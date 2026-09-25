// Shared machinery for the frozen pre-migration wire corpus.
//
// `scripts/capture-premigration-baseline.mjs` uses this module to record what
// the built stdio MCP executable puts on the wire; `tests/premigration-wire-baseline.test.ts`
// uses it to replay the frozen inputs against the current build and compare.
// Both sides run the same driver, so a recording and a replay differ only in
// what they do with the observations.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  REPO_ROOT,
  describeStdoutFramingViolations,
  parseStdoutMessages,
  splitStderrLines,
  startRawStdioServer,
} from './raw-stdio.ts';

export { REPO_ROOT };

/** Default location of the checked-in corpus. */
export const DEFAULT_FIXTURE_ROOT: string = join(REPO_ROOT, 'tests', 'fixtures', 'premigration');

/**
 * Environment override used by the mutation-sensitivity check: it points the
 * parity oracle at a scratch copy of the corpus so a deliberately corrupted
 * copy can be shown to fail without ever touching the checked-in files.
 */
export const FIXTURE_ROOT_ENV_VAR = 'BLOCKBENCH_MCP_BASELINE_FIXTURE_DIR';

export function fixtureRoot(): string {
  const override = process.env[FIXTURE_ROOT_ENV_VAR];
  return override !== undefined && override !== '' ? override : DEFAULT_FIXTURE_ROOT;
}

export function scenarioDir(root: string = fixtureRoot()): string {
  return join(root, 'scenarios');
}

// ---------------------------------------------------------------------------
// Fixture shape
// ---------------------------------------------------------------------------

export interface ScenarioStepProgram {
  /** Human-readable description of what this step exercises. */
  label: string;
  /** JSON value framed as one newline-terminated stdin line. */
  send?: unknown;
  /** Raw text framed as one newline-terminated stdin line, used for malformed input. */
  sendRawLine?: string;
  /** How many new stdout messages this step is expected to produce. */
  awaitStdoutMessages: number;
  /** Quiet period observed after the step, used to prove silence. */
  settleMs?: number;
}

export type TerminationKind = 'stdin-eof' | 'sigterm' | 'sigint';

export interface ScenarioProgram {
  args: string[];
  steps: ScenarioStepProgram[];
  termination: TerminationKind;
}

export interface RecordedMessage {
  /** The parsed JSON-RPC message exactly as the executable emitted it. */
  message: unknown;
  /** SHA-256 of the raw stdout line, which pins JSON property order. */
  rawSha256: string;
}

export interface ScenarioStepFixture extends ScenarioStepProgram {
  expect: RecordedMessage[];
}

export interface ScenarioFixture {
  name: string;
  proves: string;
  /** Which documented fixture classes this file covers. */
  covers: string[];
  process: {
    args: string[];
    /** Named environment recipe; see the fixture README. */
    environment: 'isolated-empty-config-home';
  };
  steps: ScenarioStepFixture[];
  termination: {
    kind: TerminationKind;
    exitCode: number | null;
    signal: string | null;
    trailingStdoutMessages: RecordedMessage[];
  };
  stdout: {
    lineCount: number;
    everyLineIsOneJsonRpcObject: boolean;
    normalizationRewroteStdout: boolean;
  };
  stderrLines: string[];
}

export interface ScenarioObservation {
  stepMessages: string[][];
  trailingLines: string[];
  /**
   * Whether the terminating `child.kill()` was accepted by a live process, or
   * `null` for a scenario terminated by closing stdin, where nothing is killed.
   *
   * `false` means the adapter had already exited before the signal was sent, so
   * the exit recorded below was not caused by the stimulus this scenario claims
   * to apply. Without it, an adapter that exits on its own after the last
   * recorded message and happens to report the same status as a forced
   * termination would satisfy both halves of the win32 assertion.
   */
  terminationKillAccepted: boolean | null;
  exitCode: number | null;
  exitSignal: string | null;
  stdoutLines: string[];
  pendingStdout: string;
  stderrLines: string[];
  framingViolations: string[];
  normalizationRewroteStdout: boolean;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

export interface NormalizationContext {
  configHome: string;
  repoRoot: string;
  nodeExecPath: string;
}

/**
 * Replace the few values that genuinely vary between machines and runs.
 *
 * Every rule here is deliberately narrow. Nothing that belongs to the protocol
 * contract - tool order, schema shape, error codes, message text, `isError`,
 * capability shape, protocol version echoes, or the default WebSocket port
 * constant - is touched. On Linux none of these rules currently fire on
 * stdout; the recorded fixtures assert that, so a future capture that starts
 * needing normalization on stdout is visible rather than silent.
 */
export function normalizeCapturedText(text: string, context: NormalizationContext): string {
  return text
    .split(context.configHome)
    .join('<config-home>')
    .split(context.repoRoot)
    .join('<repo-root>')
    .split(context.nodeExecPath)
    .join('<node-exec-path>')
    .replace(/\r$/, '');
}

export function normalizeCapturedLines(
  lines: readonly string[],
  context: NormalizationContext,
): string[] {
  return lines.map((line) => normalizeCapturedText(line, context));
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/** How long to wait after process exit before deciding stdout is finished. */
const POST_EXIT_FLUSH_MS = 200;

export async function runScenarioProgram(program: ScenarioProgram): Promise<ScenarioObservation> {
  const session = startRawStdioServer({ args: program.args });
  const context: NormalizationContext = {
    configHome: session.configHome,
    repoRoot: REPO_ROOT,
    nodeExecPath: process.execPath,
  };
  try {
    const stepMessages: string[][] = [];
    let consumed = 0;
    for (const step of program.steps) {
      if (step.sendRawLine !== undefined) session.sendRawLine(step.sendRawLine);
      else session.send(step.send);

      const target = consumed + step.awaitStdoutMessages;
      if (step.awaitStdoutMessages > 0) await session.waitForStdoutLines(target);
      if (step.settleMs !== undefined && step.settleMs > 0) await session.settle(step.settleMs);

      const seen = session.stdoutLines();
      if (seen.length !== target) {
        throw new Error(
          `step ${JSON.stringify(step.label)} expected ${String(step.awaitStdoutMessages)} new stdout ` +
            `message(s) (${String(target)} total) but the executable produced ${String(seen.length)}: ` +
            JSON.stringify(seen.slice(target).map((line) => line.slice(0, 200))),
        );
      }
      stepMessages.push(seen.slice(consumed, target));
      consumed = target;
    }

    let terminationKillAccepted: boolean | null = null;
    if (program.termination === 'stdin-eof') session.endStdin();
    else terminationKillAccepted = session.kill(program.termination === 'sigterm' ? 'SIGTERM' : 'SIGINT');

    const exit = await session.waitForExit();
    await session.settle(POST_EXIT_FLUSH_MS);

    const stdoutLines = session.stdoutLines();
    const rawStderr = session.stderrText();
    const normalizedStdout = normalizeCapturedLines(stdoutLines, context);
    return {
      stepMessages: stepMessages.map((lines) => normalizeCapturedLines(lines, context)),
      trailingLines: normalizeCapturedLines(stdoutLines.slice(consumed), context),
      terminationKillAccepted,
      exitCode: exit.code,
      exitSignal: exit.signal,
      stdoutLines: normalizedStdout,
      pendingStdout: session.pendingStdout(),
      stderrLines: normalizeCapturedLines(splitStderrLines(rawStderr), context),
      framingViolations: describeStdoutFramingViolations(stdoutLines, session.pendingStdout()),
      normalizationRewroteStdout: normalizedStdout.some((line, index) => line !== stdoutLines[index]),
    };
  } finally {
    await session.dispose();
  }
}

// ---------------------------------------------------------------------------
// What terminating a process looks like on this host
// ---------------------------------------------------------------------------

export interface TerminationOutcome {
  exitCode: number | null;
  exitSignal: string | null;
}

/**
 * The control child. It reports ready and then does nothing but stay alive,
 * installing no signal handler of any kind, so what it reports when it is
 * killed is what this host does to a process that cannot answer.
 */
const TERMINATION_CONTROL_SOURCE = "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);";

const TERMINATION_CONTROL_READY_TIMEOUT_MS = 15_000;

/**
 * How long the control child is given to die after it has been signalled.
 *
 * Without a bound here a kill that never lands leaves the whole job hanging
 * until the 60-minute CI timeout, which reports as a stalled leg rather than as
 * the failure it is.
 */
const TERMINATION_CONTROL_EXIT_TIMEOUT_MS = 15_000;

const READY_MARKER = 'ready';

/**
 * Measure what `child.kill(signal)` does to a process that handles nothing,
 * on the host running the suite, in the same run.
 *
 * This exists because the recorded termination outcome in the frozen corpus is
 * two different things wearing one name: the stimulus the harness applies, and
 * the exit status the recording platform observed after the adapter's handler
 * ran. On a platform where the stimulus cannot reach a handler, the recorded
 * status describes nothing that can happen. Measuring an unhandled termination
 * here gives that platform an exact expectation to compare against instead of a
 * guess about how the runtime spells a forced kill — and gives the platforms
 * that do deliver signals a positive control, since a recorded outcome equal to
 * the unhandled one would prove no handler had to run to produce it.
 *
 * The control is a Node process spawned and killed exactly the way the replay
 * spawns and kills the adapter, so the only difference between them is the
 * handler the adapter installs.
 */
export async function measureUnhandledTermination(signal: NodeJS.Signals): Promise<TerminationOutcome> {
  const child = spawn(process.execPath, ['-e', TERMINATION_CONTROL_SOURCE], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
  let ready = false;
  let gone = false;
  let failure: Error | null = null;
  // The marker is accumulated, not tested chunk by chunk. A pipe is free to
  // deliver `ready\n` as `rea` then `dy\n`, and testing each chunk on its own
  // would then never see it - a false failure fifteen seconds later, on a
  // control child that started perfectly.
  let readyBuffer = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    readyBuffer += chunk;
    if (readyBuffer.includes(READY_MARKER)) ready = true;
  });
  child.on('error', (error: Error) => {
    failure = error;
  });
  void exited.then(() => {
    gone = true;
  });

  const deadline = Date.now() + TERMINATION_CONTROL_READY_TIMEOUT_MS;
  while (!ready) {
    if (failure !== null) throw new Error(`the termination control child could not be started: ${String(failure)}`);
    if (gone) throw new Error('the termination control child exited before it reported ready');
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(
        `the termination control child never reported ready within ${String(TERMINATION_CONTROL_READY_TIMEOUT_MS)}ms, ` +
          'so what an unhandled termination looks like on this host could not be measured',
      );
    }
    await new Promise((done) => setTimeout(done, 5));
  }

  // The measurement is only worth anything if the signal was actually delivered
  // to a live process: an exit that this call did not cause describes nothing
  // about what a forced termination looks like here.
  if (!child.kill(signal)) {
    throw new Error(
      `the termination control child did not accept ${signal}, so what an unhandled termination looks like on ` +
        'this host could not be measured',
    );
  }
  let expiry: NodeJS.Timeout | undefined;
  const expired = new Promise<null>((done) => {
    expiry = setTimeout(() => {
      done(null);
    }, TERMINATION_CONTROL_EXIT_TIMEOUT_MS);
  });
  const outcome = await Promise.race([exited, expired]);
  clearTimeout(expiry);
  if (outcome === null) {
    child.kill('SIGKILL');
    throw new Error(
      `the termination control child was still running ${String(TERMINATION_CONTROL_EXIT_TIMEOUT_MS)}ms after ` +
        `${signal} was delivered to it, so what an unhandled termination looks like on this host could not be ` +
        'measured',
    );
  }
  const [exitCode, exitSignal] = outcome;
  return { exitCode, exitSignal };
}

/** Turn recorded raw lines into the frozen `{ message, rawSha256 }` pairs. */
export function toRecordedMessages(lines: readonly string[]): RecordedMessage[] {
  return parseStdoutMessages(lines).map((message, index) => ({
    message,
    rawSha256: sha256(lines[index]),
  }));
}

/** Recover the replayable input program from a frozen scenario fixture. */
export function programOf(fixture: ScenarioFixture): ScenarioProgram {
  return {
    args: fixture.process.args.slice(),
    steps: fixture.steps.map((step) => {
      const program: ScenarioStepProgram = {
        label: step.label,
        awaitStdoutMessages: step.awaitStdoutMessages,
      };
      if ('sendRawLine' in step && step.sendRawLine !== undefined) program.sendRawLine = step.sendRawLine;
      else program.send = step.send;
      if (step.settleMs !== undefined) program.settleMs = step.settleMs;
      return program;
    }),
    termination: fixture.termination.kind,
  };
}

export function listScenarioNames(root: string = fixtureRoot()): string[] {
  return readdirSync(scenarioDir(root))
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => entry.slice(0, -'.json'.length))
    .sort();
}

export function readScenarioFixture(name: string, root: string = fixtureRoot()): ScenarioFixture {
  return JSON.parse(readFileSync(join(scenarioDir(root), `${name}.json`), 'utf8')) as ScenarioFixture;
}

export function readJsonFixture<T>(relativePath: string, root: string = fixtureRoot()): T {
  return JSON.parse(readFileSync(join(root, relativePath), 'utf8')) as T;
}
