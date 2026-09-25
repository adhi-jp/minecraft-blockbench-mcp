// Asserts the connectivity mode the adapter actually resolved, by asking it.
//
// The mode dimension cannot ride along on the test suite: the suite scrubs
// BLOCKBENCH_MCP_DIRECT and BLOCKBENCH_MCP_BROKER out of every environment it
// spawns an adapter with (`tests/helpers/raw-stdio.ts`), and each test then
// sets the mode it wants per spawn. Exporting a mode around `npm test`
// therefore changes nothing about what runs, which is why this is its own step.
//
// It also asserts the observed mode rather than the requested one. Setting an
// environment variable is an instruction, not evidence; without reading back
// what the adapter resolved, a matrix leg that asks for brokered and silently
// gets direct is indistinguishable from one that worked.
//
// `result.mode` in the MCP `health` tool result is the only place the resolved
// mode is observable — there is no flag or subcommand that prints it, and
// `doctor` cannot stand in because it force-sets direct mode before probing
// (`src/setup/health-check.ts`). So this speaks MCP over stdio, the same way
// `scripts/verify-package.mjs` does. No Blockbench plugin is needed:
// `result.mode` is populated whether or not one is connected.
//
// Exit codes: 0 observed matches expected, 1 mismatch, 3 harness failure.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const EXIT_OK = 0;
const EXIT_MISMATCH = 1;
const EXIT_HARNESS_ERROR = 3;

const MODES = ['direct', 'brokered'];
const SELECTORS = ['default', 'env', 'flag'];

const DEFAULT_ENTRY = join('dist', 'adapter', 'cli.js');
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Brokered mode hands the plugin listener to a detached per-user broker that
 * outlives the adapter it was started for. The tests keep it from surviving a
 * run by capping its idle life, and so does this: a CI leg must not be able to
 * leave a broker holding a socket or a named pipe after the step is over.
 */
const BROKER_IDLE_TIMEOUT_MS = '5000';

/** How long to wait for a polite shutdown before killing the child outright. */
const CLOSE_GRACE_MS = 2_000;

/** Adapter stderr is only surfaced on failures, and only this much of it. */
const STDERR_TAIL_LIMIT = 2_000;

const UNKNOWN = 'UNKNOWN';

function usage() {
  return (
    'usage: node scripts/assert-adapter-mode.mjs --expect <direct|brokered> --select <default|env|flag> ' +
    '[--entry <path>] [--timeout-ms <n>] [--label <text>]\n'
  );
}

function parseCliArguments(argv) {
  const { values } = parseArgs({
    args: argv,
    // Strict, and no positionals: a misspelled selector must fail the leg
    // rather than quietly falling back to some default probe.
    strict: true,
    allowPositionals: false,
    options: {
      expect: { type: 'string' },
      select: { type: 'string' },
      entry: { type: 'string' },
      'timeout-ms': { type: 'string' },
      label: { type: 'string' },
    },
  });

  if (values.expect === undefined) throw new Error('--expect is required');
  if (!MODES.includes(values.expect)) {
    throw new Error(`--expect must be one of ${MODES.join('|')}, got ${JSON.stringify(values.expect)}`);
  }
  if (values.select === undefined) throw new Error('--select is required');
  if (!SELECTORS.includes(values.select)) {
    throw new Error(`--select must be one of ${SELECTORS.join('|')}, got ${JSON.stringify(values.select)}`);
  }
  if (values['timeout-ms'] !== undefined && !/^[1-9]\d*$/.test(values['timeout-ms'])) {
    throw new Error(`--timeout-ms must be a positive integer, got ${JSON.stringify(values['timeout-ms'])}`);
  }

  return {
    expect: values.expect,
    select: values.select,
    // Relative entries resolve from the repo root, not the working directory,
    // so a leg means the same thing wherever it is launched from.
    entry: resolve(REPO_ROOT, values.entry ?? DEFAULT_ENTRY),
    timeoutMs: values['timeout-ms'] === undefined ? DEFAULT_TIMEOUT_MS : Number.parseInt(values['timeout-ms'], 10),
    label: values.label ?? '-',
  };
}

/**
 * Mirrors `isolatedAdapterEnv` in `tests/helpers/raw-stdio.ts`: no inherited
 * secret, no inherited config path, no inherited mode, and every per-user
 * config root pointed at a throwaway directory. Without this a developer's or
 * runner's own `setup` state could decide the mode, and the assertion would be
 * measuring the machine rather than the adapter.
 */
function isolatedEnv(configHome, extra) {
  const env = { ...process.env };
  delete env.BLOCKBENCH_MCP_SECRET;
  delete env.BLOCKBENCH_MCP_CONFIG;
  delete env.BLOCKBENCH_MCP_DIRECT;
  delete env.BLOCKBENCH_MCP_BROKER;
  env.XDG_CONFIG_HOME = configHome;
  env.HOME = configHome;
  env.APPDATA = configHome;
  env.USERPROFILE = configHome;
  // One step further than the test helper: with no BLOCKBENCH_MCP_RUNTIME_DIR
  // the broker puts its runtime directory under the config directory
  // (`resolveRuntimeDirectory` in `src/adapter/broker/endpoint.ts`), so the
  // lock and rendezvous files a brokered probe creates land inside the
  // throwaway home and go away with it, even when the calling shell sets the
  // override. Measured when a shared runtime directory still applied: a probe
  // left a stale `broker-<identity>.lock` behind in it.
  delete env.BLOCKBENCH_MCP_RUNTIME_DIR;
  env.BLOCKBENCH_MCP_BROKER_IDLE_TIMEOUT_MS = BROKER_IDLE_TIMEOUT_MS;
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  return env;
}

/**
 * Turn the requested selector into the one lever it is supposed to pull, and
 * nothing else. `default` deliberately pulls no lever at all: it is the case
 * that proves the platform's own default resolution, so it must reach the
 * adapter with no mode flag and no mode variable — which the scrubbing above
 * already guarantees.
 */
function selectorLevers(select, expect) {
  if (select === 'flag') {
    return { args: [expect === 'brokered' ? '--broker' : '--direct'], env: {} };
  }
  if (select === 'env') {
    return { args: [], env: { [expect === 'brokered' ? 'BLOCKBENCH_MCP_BROKER' : 'BLOCKBENCH_MCP_DIRECT']: '1' } };
  }
  return { args: [], env: {} };
}

/** The `health` tool answers with one JSON text block, same as verify-package reads. */
function parseHealth(result) {
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0 || content[0].type !== 'text') {
    throw new Error('the adapter health response did not contain text');
  }
  return JSON.parse(content[0].text);
}

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

/**
 * Teardown that cannot itself hang the leg. `close` normally stops the child,
 * but a probe that timed out mid-handshake may have a child that is not
 * listening to anything, so a refused-to-die process is killed outright. The
 * broker, when there is one, is detached and is not this child; its idle
 * timeout is what retires it.
 */
async function shutdown(client, transport) {
  const pid = transport.pid;
  try {
    await Promise.race([client.close(), delay(CLOSE_GRACE_MS)]);
  } catch {
    // Teardown failures must not mask the verdict.
  }
  if (typeof pid === 'number') {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone, which is the outcome being asked for.
    }
  }
}

/** Starts the adapter over stdio, asks it for health, and gives back the envelope. */
async function probeHealth({ entry, args, env, timeoutMs, stderrChunks }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, ...args],
    cwd: REPO_ROOT,
    env,
    stderr: 'pipe',
  });
  // Kept in flowing mode so a chatty adapter can never block on a full stderr
  // pipe, and so the tail can explain a startup failure.
  transport.stderr?.on('data', (chunk) => stderrChunks.push(String(chunk)));

  const client = new Client({ name: 'adapter-mode-assert', version: '1.0.0' });
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the adapter did not answer health within ${timeoutMs} ms`)), timeoutMs);
  });

  try {
    return await Promise.race([
      (async () => {
        await client.connect(transport);
        return parseHealth(await client.callTool({ name: 'health', arguments: {} }));
      })(),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
    await shutdown(client, transport);
  }
}

/** One grep-able line per run, printed on every path including the failures. */
function formatReceipt({ label, select, expect, observed, pluginConnected, verdict }) {
  return (
    `ASSERT-ADAPTER-MODE ${label} platform=${process.platform} select=${select} expected=${expect} ` +
    `observed=${observed} plugin_connected=${pluginConnected} verdict=${verdict}`
  );
}

function stderrTail(chunks) {
  const text = chunks.join('');
  if (text === '') return '(no adapter stderr)';
  return text.length > STDERR_TAIL_LIMIT ? `...${text.slice(-STDERR_TAIL_LIMIT)}` : text;
}

async function main(argv) {
  let options;
  try {
    options = parseCliArguments(argv);
  } catch (error) {
    process.stderr.write(`assert-adapter-mode: ${error.message}\n${usage()}`);
    process.stdout.write(
      `${formatReceipt({
        label: '-',
        select: UNKNOWN,
        expect: UNKNOWN,
        observed: UNKNOWN,
        pluginConnected: UNKNOWN,
        verdict: 'HARNESS-ERROR',
      })}\n`,
    );
    return EXIT_HARNESS_ERROR;
  }

  const { expect, select, entry, timeoutMs, label } = options;
  const receipt = (fields) => formatReceipt({ label, select, expect, ...fields });

  // A missing build is the most likely way this step is misconfigured, so it
  // gets its own message rather than an exception from deep inside the spawn.
  if (!existsSync(entry)) {
    process.stderr.write(
      `assert-adapter-mode: adapter entry not found: ${entry}\n` +
        '  the adapter has to be compiled before its mode can be observed; run `npm run build` first,\n' +
        '  or point --entry at an existing build.\n',
    );
    process.stdout.write(
      `${receipt({ observed: UNKNOWN, pluginConnected: UNKNOWN, verdict: 'HARNESS-ERROR' })}\n`,
    );
    return EXIT_HARNESS_ERROR;
  }

  const configHome = mkdtempSync(join(tmpdir(), 'blockbench-mcp-mode-assert-'));
  const stderrChunks = [];
  try {
    const levers = selectorLevers(select, expect);
    const health = await probeHealth({
      entry,
      args: levers.args,
      env: isolatedEnv(configHome, levers.env),
      timeoutMs,
      stderrChunks,
    });

    // The whole envelope is the CI receipt: it carries the mode, whether a
    // plugin was connected, and any setup errors that explain the state. It is
    // built from an environment with no secret in it, so there is nothing
    // sensitive to redact.
    process.stdout.write(`${JSON.stringify(health, null, 2)}\n`);

    const result = health === null || typeof health !== 'object' ? undefined : health.result;
    const mode = result === null || typeof result !== 'object' ? undefined : result.mode;
    const pluginConnected =
      result !== null && typeof result === 'object' && typeof result.plugin_connected === 'boolean'
        ? String(result.plugin_connected)
        : UNKNOWN;

    if (!MODES.includes(mode)) {
      process.stderr.write(
        'assert-adapter-mode: the health result did not report a usable adapter mode; ' +
          `expected one of ${MODES.join('|')}, got ${JSON.stringify(mode)}\n`,
      );
      process.stdout.write(
        `${receipt({
          observed: typeof mode === 'string' && mode !== '' ? mode : UNKNOWN,
          pluginConnected,
          verdict: 'HARNESS-ERROR',
        })}\n`,
      );
      return EXIT_HARNESS_ERROR;
    }

    if (mode !== expect) {
      process.stderr.write(
        `assert-adapter-mode: ${label} observed the wrong adapter mode\n` +
          `  expected: ${expect}\n` +
          `  observed: ${mode}\n` +
          `  platform: ${process.platform}, selector: ${select}, entry: ${entry}\n`,
      );
      process.stdout.write(`${receipt({ observed: mode, pluginConnected, verdict: 'MISMATCH' })}\n`);
      return EXIT_MISMATCH;
    }

    process.stdout.write(`${receipt({ observed: mode, pluginConnected, verdict: 'PASS' })}\n`);
    return EXIT_OK;
  } catch (error) {
    process.stderr.write(
      `assert-adapter-mode: could not observe the adapter mode: ${error.message}\n` +
        `  entry: ${entry}\n  adapter stderr:\n${stderrTail(stderrChunks)}\n`,
    );
    process.stdout.write(`${receipt({ observed: UNKNOWN, pluginConnected: UNKNOWN, verdict: 'HARNESS-ERROR' })}\n`);
    return EXIT_HARNESS_ERROR;
  } finally {
    // Every exit path, including the timeout and the failures above.
    rmSync(configHome, { recursive: true, force: true, maxRetries: 3 });
  }
}

process.exitCode = await main(process.argv.slice(2));
