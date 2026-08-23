// Raw newline-delimited JSON-RPC harness for the built stdio MCP executable.
//
// This helper deliberately does NOT use the MCP client SDK. It spawns
// `dist/adapter/cli.js` as a child process, writes newline-delimited JSON-RPC
// text to its stdin, and records stdout and stderr separately as raw bytes.
// Driving the wire directly is what makes the recorded corpus an independent
// description of the protocol surface: a client library upgraded alongside the
// server could otherwise hide a change on both sides at once.
//
// It can send frames the SDK client cannot produce (malformed JSON, frames
// missing `jsonrpc`, JSON-RPC batch arrays), which is required to record how
// the executable reacts to hostile or non-conforming input.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ChildProcess } from 'node:child_process';

/** Repository root, resolved from this file's location (`tests/helpers/`). */
export const REPO_ROOT: string = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The built stdio MCP executable under test. */
export const CLI_ENTRY_PATH: string = join(REPO_ROOT, 'dist', 'adapter', 'cli.js');

/**
 * POSIX platforms default to brokered plugin connectivity, so direct mode has
 * to be pinned explicitly for a reproducible single-process recording.
 * See `resolveAdapterMode` in `src/adapter/config.ts`.
 */
export const DIRECT_MODE_ARGS: readonly string[] = ['--direct'];

export interface RawStdioLaunchOptions {
  /** Arguments appended after the CLI entry path. Defaults to `--direct`. */
  args?: readonly string[];
  /** Extra environment entries applied on top of the isolated environment. */
  env?: Readonly<Record<string, string | undefined>>;
}

export interface RawStdioExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface RawStdioSession {
  /** Absolute path of the throwaway config home this process was given. */
  readonly configHome: string;
  /** Completed stdout lines, in arrival order, without their newline. */
  stdoutLines(): readonly string[];
  /** Bytes received on stdout that are not yet terminated by a newline. */
  pendingStdout(): string;
  /** Everything the process has written to stderr so far. */
  stderrText(): string;
  /** Serialize `message` as JSON and write it as one newline-terminated line. */
  send(message: unknown): void;
  /** Write `line` verbatim plus a newline. Use for malformed or hand-framed input. */
  sendRawLine(line: string): void;
  /** Resolve once stdout has produced at least `total` complete lines. */
  waitForStdoutLines(total: number, timeoutMs?: number): Promise<readonly string[]>;
  /** Wait a fixed quiet period, used to prove that no response is produced. */
  settle(ms: number): Promise<void>;
  /** Close stdin, which the adapter treats as the client going away. */
  endStdin(): void;
  /**
   * Deliver a signal to the child process, and report whether the operating
   * system accepted it for a process that was still alive.
   *
   * `false` means nothing was delivered - almost always because the child had
   * already exited. A caller that asserts on what happens *after* a kill has to
   * check this, or an exit that the kill did not cause reads as one that it
   * did.
   */
  kill(signal: NodeJS.Signals): boolean;
  /** Resolve when the child exits. */
  waitForExit(timeoutMs?: number): Promise<RawStdioExit>;
  /** Kill if still running, wait for exit, and remove the throwaway config home. */
  dispose(): Promise<void>;
}

const DEFAULT_WAIT_TIMEOUT_MS = 15_000;

/**
 * Build the environment used for every recording: no inherited shared secret,
 * no inherited config path, and every per-user config root pointed at an empty
 * throwaway directory. This mirrors the isolation in `scripts/verify-package.mjs`
 * so machine-local `setup` state cannot leak into what gets recorded.
 */
export function isolatedAdapterEnv(
  configHome: string,
  extra?: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.BLOCKBENCH_MCP_SECRET;
  delete env.BLOCKBENCH_MCP_CONFIG;
  delete env.BLOCKBENCH_MCP_DIRECT;
  delete env.BLOCKBENCH_MCP_BROKER;
  env.XDG_CONFIG_HOME = configHome;
  env.HOME = configHome;
  env.APPDATA = configHome;
  env.USERPROFILE = configHome;
  if (extra !== undefined) {
    for (const [key, value] of Object.entries(extra)) env[key] = value;
  }
  return env;
}

export function startRawStdioServer(options: RawStdioLaunchOptions = {}): RawStdioSession {
  const configHome = mkdtempSync(join(tmpdir(), 'blockbench-mcp-wire-'));
  mkdirSync(configHome, { recursive: true });
  const env = isolatedAdapterEnv(configHome, options.env);
  const args = [CLI_ENTRY_PATH, ...(options.args ?? DIRECT_MODE_ARGS)];

  const child: ChildProcess = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    env: env as NodeJS.ProcessEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const lines: string[] = [];
  let pending = '';
  let stderr = '';
  let exit: RawStdioExit | null = null;
  const exitWaiters: Array<(value: RawStdioExit) => void> = [];

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    pending += chunk;
    let index = pending.indexOf('\n');
    while (index >= 0) {
      lines.push(pending.slice(0, index));
      pending = pending.slice(index + 1);
      index = pending.indexOf('\n');
    }
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.on('exit', (code, signal) => {
    exit = { code, signal };
    for (const waiter of exitWaiters.splice(0)) waiter(exit);
  });

  const settle = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

  const waitForStdoutLines = async (
    total: number,
    timeoutMs: number = DEFAULT_WAIT_TIMEOUT_MS,
  ): Promise<readonly string[]> => {
    const deadline = Date.now() + timeoutMs;
    while (lines.length < total) {
      if (Date.now() > deadline) {
        throw new Error(
          `timed out after ${String(timeoutMs)}ms waiting for ${String(total)} stdout line(s); ` +
            `have ${String(lines.length)}. stderr so far: ${JSON.stringify(stderr)}`,
        );
      }
      if (exit !== null && lines.length < total) {
        throw new Error(
          `process exited (code ${String(exit.code)}, signal ${String(exit.signal)}) with only ` +
            `${String(lines.length)} of ${String(total)} expected stdout line(s). stderr: ${JSON.stringify(stderr)}`,
        );
      }
      await settle(5);
    }
    return lines.slice();
  };

  const waitForExit = (timeoutMs: number = DEFAULT_WAIT_TIMEOUT_MS): Promise<RawStdioExit> => {
    if (exit !== null) return Promise.resolve(exit);
    return new Promise<RawStdioExit>((done, fail) => {
      const timer = setTimeout(() => {
        fail(new Error(`timed out after ${String(timeoutMs)}ms waiting for the adapter process to exit`));
      }, timeoutMs);
      exitWaiters.push((value) => {
        clearTimeout(timer);
        done(value);
      });
    });
  };

  return {
    configHome,
    stdoutLines: () => lines.slice(),
    pendingStdout: () => pending,
    stderrText: () => stderr,
    send(message: unknown) {
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    },
    sendRawLine(line: string) {
      child.stdin?.write(`${line}\n`);
    },
    waitForStdoutLines,
    settle,
    endStdin() {
      child.stdin?.end();
    },
    kill(signal: NodeJS.Signals) {
      // `child.kill` returns false when libuv refused the signal, which is what
      // it does for a process that is already gone (ESRCH) and for one whose
      // handle has already been closed. Returning it rather than discarding it
      // is what lets a caller prove the exit it then observes was caused by
      // this call.
      return child.kill(signal);
    },
    waitForExit,
    async dispose() {
      if (exit === null) {
        child.kill('SIGKILL');
        await waitForExit(5_000).catch(() => undefined);
      }
      rmSync(configHome, { recursive: true, force: true });
    },
  };
}

/**
 * Describe every way the recorded stdout deviates from "exactly one JSON-RPC
 * object per line, nothing else". An empty array means the stream is clean.
 */
export function describeStdoutFramingViolations(
  lines: readonly string[],
  pendingBuffer: string,
): string[] {
  const violations: string[] = [];
  lines.forEach((line, index) => {
    if (line.length === 0) {
      violations.push(`stdout line ${String(index)} is empty`);
      return;
    }
    if (line !== line.trim()) {
      violations.push(`stdout line ${String(index)} carries leading or trailing whitespace: ${JSON.stringify(line)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      violations.push(
        `stdout line ${String(index)} is not JSON (${error instanceof Error ? error.message : String(error)}): ` +
          JSON.stringify(line.slice(0, 200)),
      );
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      violations.push(`stdout line ${String(index)} is not a JSON object: ${JSON.stringify(line.slice(0, 200))}`);
      return;
    }
    if ((parsed as Record<string, unknown>).jsonrpc !== '2.0') {
      violations.push(`stdout line ${String(index)} is not a JSON-RPC 2.0 message: ${JSON.stringify(line.slice(0, 200))}`);
    }
  });
  if (pendingBuffer.length > 0) {
    violations.push(`stdout ended with an unterminated partial line: ${JSON.stringify(pendingBuffer.slice(0, 200))}`);
  }
  return violations;
}

/** Parse every recorded stdout line as a JSON-RPC message object. */
export function parseStdoutMessages(lines: readonly string[]): Array<Record<string, unknown>> {
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `stdout line ${String(index)} is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  });
}

/** Split recorded stderr into lines, dropping the trailing empty segment. */
export function splitStderrLines(stderr: string): string[] {
  return stderr.split('\n').filter((line) => line.length > 0);
}
