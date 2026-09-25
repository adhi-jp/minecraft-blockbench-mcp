#!/usr/bin/env node
// Semi-automated AC-21 scope-isolation live smoke.
//
// AC-21 (bound spec): "After broker crash or plugin reconnect, a different
// client cannot use the prior client's confirmed scoped directory before the
// existing revocation/confirmation invariant is re-established."
//
// The deterministic proof against the fake plugin/broker harness lives in
// `tests/adapter-scope-isolation.test.ts`. This helper produces the live one:
// it drives the built adapter against a real Blockbench + plugin runtime, with
// a human confirming the scoped directory inside Blockbench, and writes a JSON
// receipt naming one of three verdicts.
//
//   PASS          the invariant held, and every control that makes that
//                 statement meaningful was observed to hold too.
//   FAIL          client B read client A's confirmed scoped directory after
//                 the disruption. The invariant was violated.
//   INCONCLUSIVE  the scenario could not be driven to the assertion. Never a
//                 pass: a run that never reached the assertion proves nothing.
//
// The whole value of this script is that it can report FAIL. Every phase is
// recorded from an observation, not from the absence of an exception, and PASS
// is returned from exactly one branch of `decideVerdict`, which requires all
// four phase records to be affirmatively satisfied.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const DEFAULT_PORT = 39731;
const DEFAULT_TIMEOUT_MS = 90_000;
/** Client-side budget for a call that waits on a human. The plugin-side
 * `propose_scoped_directory` timeout is fixed at 120 s by the protocol, so this
 * only needs headroom above it: the operator sees the bridge's own timeout
 * rather than a client-side one. */
const DEFAULT_CONFIRM_TIMEOUT_MS = 180_000;
const DEFAULT_RECONNECT_TIMEOUT_MS = 120_000;
const PROBE_FILE_NAME = 'ac21-scope-probe.txt';
const RECEIPT_SCHEMA_VERSION = 1;

const REQUIRED_TOOLS = ['health', 'get_plugin_status', 'propose_scoped_directory', 'read_file', 'write_files'];

/** Scope-state error codes that mean the scoped-directory invariant itself
 * refused the command. Any other refusal denies for some other reason and does
 * not demonstrate AC-21. */
export const SCOPE_DENIAL_CODES = ['E_SCOPE_REVOKED', 'E_SCOPE_EXPIRED', 'E_SCOPE_NOT_CONFIRMED'];

/** The only plugin scope state that proves the adapter's acknowledged
 * `revoke_scope` is what removed the inherited grant. `expired`/`unconfirmed`
 * mean the plugin was reloaded and the grant died on its own, so the scenario
 * was not driven. */
const REVOKED_SCOPE_STATE = 'revoked';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const projectRoot = resolve(scriptDir, '..');
const adapterCliPath = join(projectRoot, 'dist', 'adapter', 'cli.js');

export class SmokeError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'SmokeError';
    this.code = code;
    this.details = details;
  }
}

export class ToolFailure extends SmokeError {
  constructor(command, envelope, client = undefined) {
    const error = envelope?.error ?? { code: 'E_BLOCKBENCH_ERROR', message: 'Tool returned a failed envelope.' };
    const classified = classifyToolFailure(command, error);
    super(classified.code, classified.message, { command, client, envelope, classification: classified });
    this.name = 'ToolFailure';
    this.command = command;
    this.client = client;
    this.envelope = envelope;
    this.classification = classified;
  }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseIntegerOption(name, raw, min, max) {
  if (!/^\d+$/.test(String(raw ?? ''))) {
    throw new SmokeError('E_INVALID_PARAMS', `${name} must be an integer in [${min}, ${max}].`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new SmokeError('E_INVALID_PARAMS', `${name} must be an integer in [${min}, ${max}].`);
  }
  return value;
}

function readOptionValue(argv, index, name, inlineValue) {
  if (inlineValue !== undefined) return { value: inlineValue, nextIndex: index };
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new SmokeError('E_INVALID_PARAMS', `Missing value for ${name}.`);
  }
  return { value, nextIndex: index + 1 };
}

export const SMOKE_MODES = ['auto', 'direct', 'brokered'];

export function parseSmokeArgs(argv = [], env = process.env) {
  const envPort = env.BLOCKBENCH_MCP_PORT;
  const envSecret = env.BLOCKBENCH_MCP_SECRET !== undefined && env.BLOCKBENCH_MCP_SECRET !== '' ? env.BLOCKBENCH_MCP_SECRET : undefined;
  const options = {
    port: envPort !== undefined && envPort !== '' ? parseIntegerOption('BLOCKBENCH_MCP_PORT', envPort, 1, 65_535) : DEFAULT_PORT,
    mode: 'auto',
    outParent: undefined,
    scopeDir: undefined,
    secret: envSecret,
    authSource: envSecret !== undefined ? 'environment' : 'missing',
    lessSafeSecretFlag: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    confirmTimeoutMs: DEFAULT_CONFIRM_TIMEOUT_MS,
    reconnectTimeoutMs: DEFAULT_RECONNECT_TIMEOUT_MS,
    prompt: true,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [flag, inlineValue] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (flag === '--port') {
      const read = readOptionValue(argv, i, '--port', inlineValue);
      options.port = parseIntegerOption('--port', read.value, 1, 65_535);
      i = read.nextIndex;
    } else if (flag === '--mode') {
      const read = readOptionValue(argv, i, '--mode', inlineValue);
      if (!SMOKE_MODES.includes(read.value)) {
        throw new SmokeError('E_INVALID_PARAMS', `--mode must be one of: ${SMOKE_MODES.join(', ')}.`);
      }
      options.mode = read.value;
      i = read.nextIndex;
    } else if (flag === '--out') {
      const read = readOptionValue(argv, i, '--out', inlineValue);
      options.outParent = resolve(read.value);
      i = read.nextIndex;
    } else if (flag === '--scope-dir') {
      const read = readOptionValue(argv, i, '--scope-dir', inlineValue);
      if (read.value === '') throw new SmokeError('E_INVALID_PARAMS', '--scope-dir must not be empty.');
      options.scopeDir = resolve(read.value);
      i = read.nextIndex;
    } else if (flag === '--secret') {
      const read = readOptionValue(argv, i, '--secret', inlineValue);
      if (read.value === '') throw new SmokeError('E_INVALID_PARAMS', '--secret must not be empty.');
      options.secret = read.value;
      options.authSource = 'cli';
      options.lessSafeSecretFlag = true;
      i = read.nextIndex;
    } else if (flag === '--timeout-ms') {
      const read = readOptionValue(argv, i, '--timeout-ms', inlineValue);
      options.timeoutMs = parseIntegerOption('--timeout-ms', read.value, 1_000, 3_600_000);
      i = read.nextIndex;
    } else if (flag === '--confirm-timeout-ms') {
      const read = readOptionValue(argv, i, '--confirm-timeout-ms', inlineValue);
      options.confirmTimeoutMs = parseIntegerOption('--confirm-timeout-ms', read.value, 1_000, 3_600_000);
      i = read.nextIndex;
    } else if (flag === '--reconnect-timeout-ms') {
      const read = readOptionValue(argv, i, '--reconnect-timeout-ms', inlineValue);
      options.reconnectTimeoutMs = parseIntegerOption('--reconnect-timeout-ms', read.value, 1_000, 3_600_000);
      i = read.nextIndex;
    } else if (arg === '--no-prompt') {
      options.prompt = false;
    } else {
      throw new SmokeError('E_INVALID_PARAMS', `Unknown option: ${arg}`);
    }
  }

  return options;
}

export function helpText() {
  return [
    'AC-21 scope-isolation live smoke',
    '',
    'Proves, against a real Blockbench + plugin runtime, that after a broker crash or a plugin',
    'reconnect a different MCP client cannot use the prior client\'s confirmed scoped directory',
    'until the revocation/confirmation invariant is re-established.',
    '',
    'Usage:',
    '  BLOCKBENCH_MCP_SECRET=<secret> npm run smoke:scope-isolation-live -- [--mode auto|direct|brokered]',
    '',
    'Options:',
    '  --mode <mode>              auto (the platform default: direct on Windows, brokered elsewhere),',
    '                             direct, or brokered. The observed mode is read back from health and',
    '                             recorded in the receipt; a requested mode that is not honoured is',
    `                             INCONCLUSIVE. Default: auto.`,
    '  --port <port>              Adapter/WebSocket port. If changed, set the Blockbench plugin to the',
    `                             same port and reconnect it. Default: ${DEFAULT_PORT}.`,
    '  --out <dir>                Parent directory for a unique run subdirectory. Defaults to the system',
    '                             temp directory. The receipt and checklist are written there.',
    '  --scope-dir <dir>          Directory proposed for confirmation. Defaults to a fresh directory',
    '                             inside the run directory, which is created for you.',
    `  --timeout-ms <ms>          MCP startup/tool timeout guard. Default: ${DEFAULT_TIMEOUT_MS}.`,
    '  --confirm-timeout-ms <ms>  Budget for a call that waits on a human confirmation. Default:',
    `                             ${DEFAULT_CONFIRM_TIMEOUT_MS}. The plugin-side proposal timeout is fixed at 120000 ms,`,
    '                             so you have about two minutes to click Confirm once prompted.',
    `  --reconnect-timeout-ms <ms> Budget for the plugin to reconnect after the disruption. Default: ${DEFAULT_RECONNECT_TIMEOUT_MS}.`,
    '  --no-prompt                Do not pause for the operator before a confirmation step. The run then',
    '                             depends on the operator already watching Blockbench.',
    '  --secret <secret>          Less-safe convenience override. Prefer BLOCKBENCH_MCP_SECRET so the',
    '                             secret is less likely to leak through shell history or process listings.',
    '  --help                     Show this help.',
    '',
    'Exit codes:',
    '  0  PASS',
    '  1  FAIL          the invariant was violated (client B used client A\'s scope)',
    '  2  INCONCLUSIVE  the scenario could not be driven; this is never a pass',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Run directory
// ---------------------------------------------------------------------------

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function selectRunDirectory({ outParent, now = new Date(), randomHex = randomBytes(4).toString('hex') } = {}) {
  const parent = resolve(outParent ?? tmpdir());
  const runId = `ac21-scope-isolation-smoke-${timestampForPath(now)}-${randomHex}`;
  return { parent, runId, runDir: join(parent, runId) };
}

export async function createRunDirectory(options = {}) {
  const selected = selectRunDirectory(options);
  await mkdir(selected.parent, { recursive: true });
  try {
    await mkdir(selected.runDir, { recursive: false });
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      throw new SmokeError('E_FILE_EXISTS', `Output run directory already exists: ${selected.runDir}`);
    }
    throw new SmokeError('E_BLOCKBENCH_ERROR', `Could not create output run directory: ${selected.runDir}`, {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  return selected;
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// ---------------------------------------------------------------------------
// Mode resolution
// ---------------------------------------------------------------------------

/**
 * The adapter's own platform default: brokered everywhere except Windows,
 * where direct is the default and `BLOCKBENCH_MCP_BROKER=1` flips it. Mirrors
 * `resolveAdapterMode` in `src/adapter/config.ts`.
 */
export function expectedModeForPlatform(platform) {
  return platform === 'win32' ? 'direct' : 'brokered';
}

/**
 * What mode this run is asking for, and what the adapter should therefore
 * resolve. `auto` means the platform default with any inherited mode
 * environment removed, so "the platform default" in the receipt is the
 * product's default and not the operator's shell.
 */
export function resolveModeRequest({ requested = 'auto', platform }) {
  const platformDefault = expectedModeForPlatform(platform);
  return {
    requested,
    platformDefault,
    expected: requested === 'auto' ? platformDefault : requested,
  };
}

/**
 * The mode-selecting environment for an adapter child. Both switches are always
 * written or removed, so an inherited `BLOCKBENCH_MCP_DIRECT` can never make a
 * `--mode brokered` run quietly direct.
 */
export function adapterEnvForMode(mode, baseEnv = {}) {
  const env = { ...baseEnv };
  delete env.BLOCKBENCH_MCP_DIRECT;
  delete env.BLOCKBENCH_MCP_BROKER;
  if (mode === 'direct') env.BLOCKBENCH_MCP_DIRECT = '1';
  if (mode === 'brokered') env.BLOCKBENCH_MCP_BROKER = '1';
  return env;
}

/**
 * Which disruption AC-21 names for a resolved mode. Brokered mode has a broker
 * process to crash; direct mode has none, and its disruption is the adapter
 * restart that makes the plugin reconnect. Both are named by the criterion.
 */
export function disruptionForMode(mode) {
  return mode === 'brokered'
    ? {
        kind: 'broker_crash',
        description: 'SIGKILL the detached broker process named by this run\'s broker record.',
      }
    : {
        kind: 'adapter_restart',
        description: 'Close client A\'s adapter so the plugin reconnects to client B\'s adapter.',
      };
}

// ---------------------------------------------------------------------------
// Broker location (mirrors src/adapter/cli.ts resolveBrokerLocation)
// ---------------------------------------------------------------------------

/**
 * Where the adapter publishes the broker record for a given config file. The
 * smoke gives each run its own config file, so this identifies that run's own
 * broker and never a broker some other adapter is using.
 *
 * `resolvedConfigPath` must already be absolute in host form; the adapter
 * hashes exactly the string it resolved, so the caller does the resolving.
 * `runtimeDirOverride` is the `BLOCKBENCH_MCP_RUNTIME_DIR` the adapter children
 * inherit; without it the record sits in `run/` beside the config file.
 */
export function brokerRecordPathFor({ resolvedConfigPath, platform, runtimeDirOverride = undefined }) {
  const pathApi = platform === 'win32' ? win32 : posix;
  const configIdentity = sha256(resolvedConfigPath).slice(0, 16);
  const trimmed = typeof runtimeDirOverride === 'string' ? runtimeDirOverride.trim() : '';
  const runtimeDir =
    trimmed !== '' && pathApi.isAbsolute(trimmed)
      ? pathApi.join(trimmed, 'minecraft-blockbench-mcp')
      : pathApi.join(pathApi.dirname(resolvedConfigPath), 'run');
  return { configIdentity, runtimeDir, recordPath: `${runtimeDir}/broker-${configIdentity}.json` };
}

/**
 * Refuse to signal anything that is not recognisably this run's broker. A live
 * smoke that kills the wrong process is worse than one that reports
 * INCONCLUSIVE, so every field the record carries about identity is checked
 * before a signal is sent.
 */
export function assertKillableBrokerRecord(record, { port, selfPid }) {
  if (record === null || typeof record !== 'object') {
    throw new SmokeError('E_AC21_BROKER_RECORD_MISSING', 'No broker record was published for this run, so no broker crash could be applied.');
  }
  const pid = record.broker_pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new SmokeError('E_AC21_BROKER_RECORD_MISSING', 'The broker record does not name a usable broker pid.', { broker_pid: pid });
  }
  if (pid === selfPid) {
    throw new SmokeError('E_AC21_BROKER_RECORD_MISSING', 'The broker record names this helper\'s own pid; refusing to signal it.', { broker_pid: pid });
  }
  if (record.ws_port !== port) {
    throw new SmokeError('E_AC21_BROKER_RECORD_MISSING', 'The broker record names a different WebSocket port than this run; refusing to signal it.', {
      record_port: record.ws_port,
      run_port: port,
    });
  }
  return pid;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const SENSITIVE_KEY_RE = /(?:secret|token|password|credential|authorization)/i;

/**
 * Scrub a value for the receipt. Known secrets (and their base64 form) and any
 * secret-shaped key go to `[redacted]`; the operator's home directory becomes
 * `~` so a receipt can be handed back without carrying an absolute home path.
 */
export function sanitizeForReport(value, knownSecrets = [], homeDir = undefined) {
  const secrets = knownSecrets.filter((secret) => typeof secret === 'string' && secret.length > 0);
  const homeVariants = [];
  if (typeof homeDir === 'string' && homeDir.length > 1) {
    const forward = homeDir.split('\\').join('/');
    for (const variant of [homeDir, forward]) {
      if (!homeVariants.includes(variant)) homeVariants.push(variant);
    }
  }

  const redactString = (input) => {
    let output = input;
    for (const secret of secrets) {
      output = output.split(secret).join('[redacted]');
      output = output.split(Buffer.from(secret, 'utf8').toString('base64')).join('[redacted]');
    }
    for (const variant of homeVariants) {
      output = output.split(variant).join('~');
    }
    return output;
  };

  const visit = (input, key = '') => {
    if (SENSITIVE_KEY_RE.test(key)) return '[redacted]';
    if (typeof input === 'string') return redactString(input);
    if (Array.isArray(input)) return input.map((item) => visit(item));
    if (isPlainObject(input)) {
      const output = {};
      for (const [childKey, childValue] of Object.entries(input)) {
        output[childKey] = visit(childValue, childKey);
      }
      return output;
    }
    return input;
  };

  return visit(value);
}

const MAX_RECORDED_CONTENT_CHARS = 240;

function summarizeResult(command, result) {
  if (!isPlainObject(result)) return result;
  if (command === 'read_file' && typeof result.content === 'string' && result.content.length > MAX_RECORDED_CONTENT_CHARS) {
    return { ...result, content: `${result.content.slice(0, MAX_RECORDED_CONTENT_CHARS)}…[truncated]` };
  }
  return result;
}

export function summarizeEnvelope(command, envelope, knownSecrets = [], homeDir = undefined, client = undefined) {
  return sanitizeForReport(
    {
      client,
      command,
      ok: envelope?.ok === true,
      summary: envelope?.summary,
      result: envelope?.ok === true ? summarizeResult(command, envelope.result) : undefined,
      error: envelope?.ok === false ? envelope.error : undefined,
    },
    knownSecrets,
    homeDir,
  );
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

export function classifySetupIssue(issue, port) {
  const code = issue?.code ?? 'E_BLOCKBENCH_ERROR';
  if (code === 'E_SECRET_MISSING') {
    return {
      code,
      category: 'missing_secret',
      message: 'Missing shared secret. Set BLOCKBENCH_MCP_SECRET before running the AC-21 scope-isolation smoke.',
      remediation: ['Set BLOCKBENCH_MCP_SECRET to the same value configured in the Blockbench MCP plugin.'],
    };
  }
  if (code === 'E_PORT_IN_USE') {
    return {
      code,
      category: 'port_conflict',
      message: `The adapter could not listen on 127.0.0.1:${port}; another process is already using that port.`,
      remediation: [
        'Do not kill unknown processes from this helper.',
        'Close every other MCP adapter or broker you started for this port, then rerun.',
        'Or rerun with --port <free-port> and set the Blockbench MCP plugin to the same port before reconnecting.',
      ],
    };
  }
  if (code === 'E_BROKER_UNAVAILABLE' || code === 'E_BROKER_VERSION_MISMATCH') {
    return {
      code,
      category: 'broker_unavailable',
      message: 'No healthy broker could be reached or started for this run.',
      remediation: [
        'Run npm run build so dist/adapter/cli.js matches this checkout.',
        'Close other adapters sharing the port, then rerun.',
        'On Windows, brokered mode is opt-in; rerun with --mode brokered only when a broker is wanted.',
      ],
    };
  }
  return {
    code,
    category: 'adapter_setup',
    message: issue?.message ?? 'The adapter reported a setup issue.',
    remediation: ['Fix the adapter setup issue reported by health, then rerun the smoke.'],
  };
}

export function classifyToolFailure(command, error = {}) {
  const code = error.code ?? 'E_BLOCKBENCH_ERROR';
  if (code === 'E_PLUGIN_NOT_CONNECTED') {
    return {
      code,
      category: 'plugin_disconnected',
      message: `Cannot run ${command}: the Blockbench MCP plugin is not connected.`,
      remediation: [
        'Run npm run build, then reinstall or reload dist/plugin/minecraft_blockbench_mcp.js in Blockbench.',
        'Verify the Blockbench MCP plugin uses the same port and shared secret, then reconnect.',
        'Leave Blockbench running and untouched for the whole run; a plugin reload mid-run makes the scenario undriveable.',
      ],
    };
  }
  if (code === 'E_PROTOCOL_MISMATCH') {
    return {
      code,
      category: 'protocol_mismatch',
      message: `Cannot run ${command}: the adapter and Blockbench plugin protocol versions do not match.`,
      remediation: ['Run npm run build and reload the current dist/plugin/minecraft_blockbench_mcp.js bundle in Blockbench.'],
    };
  }
  if (SCOPE_DENIAL_CODES.includes(code)) {
    return {
      code,
      category: 'scope_denied',
      message: `${command} was refused by the scoped-directory invariant (${code}).`,
      remediation: ['Confirm a scoped directory in Blockbench with propose_scoped_directory before this command.'],
    };
  }
  if (code === 'E_UNSUPPORTED_COMMAND') {
    return {
      code,
      category: 'required_tool_absent',
      message: `Cannot run ${command}: the connected plugin does not support a required command.`,
      remediation: ['Run npm run build and reload the current Blockbench plugin bundle.'],
    };
  }
  return {
    code,
    category: 'tool_failure',
    message: `MCP tool ${command} failed: ${error.message ?? code}.`,
    remediation: ['Review smoke-report.json for the failed command, fix the runtime precondition, and rerun.'],
  };
}

export function failureObject(error, knownSecrets = [], homeDir = undefined) {
  if (error instanceof ToolFailure) {
    return sanitizeForReport(
      {
        code: error.code,
        message: error.message,
        command: error.command,
        client: error.client,
        classification: error.classification,
        envelope: summarizeEnvelope(error.command, error.envelope, knownSecrets, homeDir, error.client),
      },
      knownSecrets,
      homeDir,
    );
  }
  if (error instanceof SmokeError) {
    return sanitizeForReport({ code: error.code, message: error.message, details: error.details }, knownSecrets, homeDir);
  }
  return sanitizeForReport(
    { code: 'E_BLOCKBENCH_ERROR', message: error instanceof Error ? error.message : String(error) },
    knownSecrets,
    homeDir,
  );
}

// ---------------------------------------------------------------------------
// The assertion: how one scoped call by client B is read
// ---------------------------------------------------------------------------

/**
 * Classify client B's scoped read of the file client A wrote.
 *
 *   granted            B used A's confirmed scoped directory. This is the
 *                      violation AC-21 forbids, and it is read from a success
 *                      envelope, not from the absence of an error.
 *   denied_by_invariant the refusal names a scope state, so the scoped-directory
 *                      invariant is what refused it.
 *   denied_other       something else refused it. That denies the command but
 *                      says nothing about AC-21, so it can only be INCONCLUSIVE.
 */
export function classifyScopedAttempt(envelope, expectedContent = undefined) {
  if (envelope?.ok === true) {
    const content = envelope.result?.content;
    return {
      outcome: 'granted',
      code: null,
      content_matched_prior_client_probe: expectedContent !== undefined && content === expectedContent,
      bytes: envelope.result?.bytes ?? null,
    };
  }
  const code = envelope?.error?.code ?? 'E_BLOCKBENCH_ERROR';
  return {
    outcome: SCOPE_DENIAL_CODES.includes(code) ? 'denied_by_invariant' : 'denied_other',
    code,
    message: envelope?.error?.message,
    content_matched_prior_client_probe: false,
    bytes: null,
  };
}

export const VERDICTS = ['PASS', 'FAIL', 'INCONCLUSIVE'];

export function verdictExitCode(verdict) {
  if (verdict === 'PASS') return 0;
  if (verdict === 'FAIL') return 1;
  return 2;
}

/**
 * The verdict model.
 *
 * FAIL is decided first and unconditionally: an observed grant is a violation
 * however the rest of the run went. Everything after it is a gate that PASS has
 * to clear, and the function starts from INCONCLUSIVE, so a phase record that
 * was never filled in cannot become a pass. PASS is returned from exactly one
 * place, at the end, once every gate has been cleared by an affirmative
 * observation.
 */
export function decideVerdict(phases = {}) {
  const establish = phases.establish ?? { status: 'not_run' };
  const disrupt = phases.disrupt ?? { status: 'not_run' };
  const assertion = phases.assert ?? { status: 'not_run' };
  const reestablish = phases.reestablish ?? { status: 'not_run' };
  const attempt = assertion.scoped_operation;

  if (attempt?.outcome === 'granted') {
    return {
      verdict: 'FAIL',
      code: 'E_AC21_SCOPE_INHERITED',
      message:
        'Client B used the scoped directory client A confirmed, after the disruption and without a fresh confirmation. ' +
        'The AC-21 revocation/confirmation invariant was violated.',
      remediation: [
        'Do not ship this build: a second MCP client inherited the first client\'s filesystem authorization.',
        'Compare against tests/adapter-scope-isolation.test.ts, which covers the same invariant deterministically.',
      ],
    };
  }

  const inconclusive = (code, message, remediation) => ({ verdict: 'INCONCLUSIVE', code, message, remediation });

  if (establish.status !== 'passed') {
    return inconclusive(
      'E_AC21_ESTABLISH_INCOMPLETE',
      'Client A did not confirm a scoped directory and prove it usable, so the rest of the scenario would have been meaningless.',
      [
        'Confirm the proposed directory in Blockbench when the helper prompts.',
        'Check the establish phase in the receipt for the failing positive control.',
      ],
    );
  }
  if (disrupt.applied !== true) {
    return inconclusive('E_AC21_DISRUPTION_NOT_APPLIED', 'The broker crash or adapter restart AC-21 names was not applied, so nothing was disrupted.', [
      'Check the disrupt phase in the receipt for why the disruption could not be applied.',
    ]);
  }
  if (disrupt.plugin_reconnected !== true) {
    return inconclusive(
      'E_AC21_RECONNECT_NOT_OBSERVED',
      'The disruption was applied but the Blockbench plugin was never seen to reconnect, so no second plugin session existed to test.',
      [
        'Leave Blockbench running through the disruption and rerun.',
        'On a slow machine, raise --reconnect-timeout-ms.',
      ],
    );
  }
  if (assertion.status === 'not_run' || attempt === undefined) {
    return inconclusive('E_AC21_ASSERTION_NOT_REACHED', 'Client B never attempted the scoped operation, so the invariant was never tested.', [
      'Check the assert phase in the receipt for where the run stopped.',
    ]);
  }
  const controls = assertion.negative_controls ?? {};
  if (controls.health_ok !== true || controls.get_plugin_status_ok !== true) {
    return inconclusive(
      'E_AC21_NEGATIVE_CONTROL_FAILED',
      'Client B could not complete a non-scoped command, so its refusal proves an unreachable adapter or plugin rather than the invariant.',
      ['Leave Blockbench running for the whole run and rerun; check the assert phase negative controls in the receipt.'],
    );
  }
  if (assertion.plugin_scope_state !== REVOKED_SCOPE_STATE) {
    return inconclusive(
      'E_AC21_SCOPE_NOT_REVOKED',
      `The plugin reported scope state "${String(assertion.plugin_scope_state)}" rather than "${REVOKED_SCOPE_STATE}" after the disruption, so an ` +
        'acknowledged revocation is not what removed client A\'s grant. A reloaded plugin reports "expired" or "unconfirmed" on its own, ' +
        'which would deny client B without testing AC-21.',
      [
        'Do not reload the plugin or restart Blockbench during the run.',
        'Rerun with Blockbench left untouched between the confirmation and the assertion.',
      ],
    );
  }
  if (attempt.outcome !== 'denied_by_invariant') {
    return inconclusive(
      'E_AC21_DENIAL_NOT_SCOPED',
      `Client B's scoped operation was refused with ${String(attempt.code)}, which is not a scoped-directory state, so the refusal does not ` +
        'demonstrate the AC-21 invariant.',
      ['Check the assert phase in the receipt for the reported error and fix that precondition, then rerun.'],
    );
  }
  if (reestablish.status !== 'passed') {
    return inconclusive(
      'E_AC21_RECOVERY_UNPROVEN',
      'Client B was denied, but a fresh confirmation did not restore access, so the denial cannot be shown to be recoverable state rather than breakage.',
      ['Confirm the second proposal in Blockbench when the helper prompts, then rerun if it was missed.'],
    );
  }

  return {
    verdict: 'PASS',
    code: 'AC21_SCOPE_ISOLATION_HELD',
    message:
      'Client A confirmed a scoped directory and used it; the disruption was applied; client B was refused the same operation by the scoped-directory ' +
      'invariant while non-scoped commands still succeeded; and a fresh confirmation restored access.',
    remediation: [],
  };
}

// ---------------------------------------------------------------------------
// Receipt and checklist
// ---------------------------------------------------------------------------

export function buildSmokeReport({
  verdict,
  verdictReason,
  startedAt,
  completedAt = new Date().toISOString(),
  options,
  runDir,
  scopeDir,
  modeRequest,
  observedMode = null,
  clients = {},
  phases = {},
  commands = [],
  failure = undefined,
  knownSecrets = [],
  homeDir = undefined,
  runtime = {},
}) {
  const report = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    smoke_name: 'AC-21 scope isolation live smoke',
    acceptance_criterion: 'AC-21',
    acceptance_criterion_text:
      'After broker crash or plugin reconnect, a different client cannot use the prior client\'s confirmed scoped directory before the existing ' +
      'revocation/confirmation invariant is re-established.',
    verdict,
    verdict_reason: verdictReason,
    verdict_is_authoritative_only_for: 'the platform, mode, and Blockbench build this run observed',
    human_confirmation_required: true,
    started_at: startedAt,
    completed_at: completedAt,
    config: {
      port: options.port,
      requested_mode: modeRequest?.requested ?? null,
      expected_mode: modeRequest?.expected ?? null,
      platform_default_mode: modeRequest?.platformDefault ?? null,
      output_dir: runDir,
      scope_dir: scopeDir,
      auth: { configured: Boolean(options.secret), source: options.authSource },
      cli_auth_override_used: options.lessSafeSecretFlag,
      timeout_ms: options.timeoutMs,
      confirm_timeout_ms: options.confirmTimeoutMs,
      reconnect_timeout_ms: options.reconnectTimeoutMs,
      operator_prompt_enabled: options.prompt,
    },
    runtime: {
      node: runtime.node ?? process.version,
      platform: runtime.platform ?? process.platform,
      arch: runtime.arch ?? process.arch,
      adapter_cli: 'dist/adapter/cli.js',
      // The mode the adapter actually resolved, read back from health rather
      // than assumed from what was requested.
      observed_mode: observedMode,
      mode_honoured: observedMode === null ? null : observedMode === (modeRequest?.expected ?? null),
      clients,
    },
    phases,
    commands,
    failure,
  };
  return sanitizeForReport(report, knownSecrets, homeDir);
}

export function generateReviewChecklist({ reportFile = 'smoke-report.json', scopeDir = '<scope directory>', mode = 'auto', port = DEFAULT_PORT } = {}) {
  return [
    '# AC-21 scope isolation live smoke — operator checklist',
    '',
    'This run needs a human twice. Everything else is automated. Keep this window and the',
    'Blockbench window both visible.',
    '',
    '## Before starting',
    '',
    '- [ ] Blockbench is running with the Minecraft Blockbench MCP plugin installed and enabled.',
    `- [ ] The plugin is configured for port ${String(port)} and the same shared secret this run uses.`,
    '- [ ] No other MCP adapter or broker is using that port.',
    '- [ ] `npm run build` has been run in this checkout, so the plugin bundle and adapter match.',
    '',
    '## During the run',
    '',
    '- [ ] **First confirmation (phase 1, client A).** When prompted, confirm the scoped directory',
    `      in Blockbench: ${scopeDir}`,
    '      Blockbench may also raise its own native permission dialog; accept that too.',
    '- [ ] **Do not touch Blockbench again until the second prompt.** Do not reload the plugin, do not',
    '      restart Blockbench, and do not revoke the directory by hand. A reload makes the plugin report',
    '      the grant as expired on its own, which denies client B without testing anything.',
    '- [ ] **Wait through the disruption (phase 2).** The helper crashes the broker or restarts the',
    '      adapter and then waits for the plugin to reconnect. This can take up to about 30 seconds.',
    '- [ ] **Second confirmation (phase 4, client B).** When prompted again, confirm the same directory.',
    '',
    '## Reading the verdict',
    '',
    `- \`PASS\` (exit 0): the invariant held on this platform in mode \`${mode}\`.`,
    '- `FAIL` (exit 1): client B used client A\'s scoped directory. This is a product defect; keep the receipt.',
    '- `INCONCLUSIVE` (exit 2): the scenario could not be driven. Not a pass. `verdict_reason` in the',
    '  receipt says which precondition was missing; fix it and rerun.',
    '',
    '## What to send back',
    '',
    `- [ ] The receipt: ${reportFile}`,
    '- [ ] This checklist with the boxes ticked.',
    '- [ ] Operator:',
    '- [ ] Operating system and version:',
    '- [ ] Blockbench version:',
    '- [ ] Plugin version:',
    '- [ ] Anything unexpected observed in Blockbench:',
    '',
  ].join('\n');
}

/**
 * The lines printed before a step that blocks on a human, so the operator reads
 * what to do before the helper stops responding.
 */
export function describeHumanStep(step, { scopeDir = '<scope directory>', confirmTimeoutMs = DEFAULT_CONFIRM_TIMEOUT_MS } = {}) {
  const seconds = Math.round(Math.min(confirmTimeoutMs, 120_000) / 1000);
  if (step === 'confirm_a') {
    return [
      'PHASE 1 of 4 — establish. A human confirmation is needed now.',
      `Blockbench will ask you to confirm this directory: ${scopeDir}`,
      'Accept the MCP plugin dialog, and accept any native Blockbench permission dialog that follows.',
      `You have about ${String(seconds)} seconds once the dialog appears.`,
    ];
  }
  if (step === 'confirm_b') {
    return [
      'PHASE 4 of 4 — re-establish. A second human confirmation is needed now.',
      `Confirm the same directory again, this time for the second client: ${scopeDir}`,
      'This proves the phase 3 denial was recoverable state rather than a broken runtime.',
      `You have about ${String(seconds)} seconds once the dialog appears.`,
    ];
  }
  if (step === 'disrupt') {
    return [
      'PHASE 2 of 4 — disrupt. No human action is needed.',
      'Do not touch Blockbench: do not reload the plugin, restart Blockbench, or revoke the directory.',
      'The plugin reconnect can take up to about 30 seconds.',
    ];
  }
  return [
    'PHASE 3 of 4 — assert. No human action is needed.',
    'A second client now attempts the same scoped read without a fresh confirmation. It must be denied.',
  ];
}

// ---------------------------------------------------------------------------
// Live path
// ---------------------------------------------------------------------------

function parseEnvelope(toolResult, toolName) {
  const content = toolResult?.content;
  if (!Array.isArray(content) || content.length === 0 || content[0]?.type !== 'text') {
    throw new SmokeError('E_BLOCKBENCH_ERROR', `${toolName} returned a malformed MCP response.`);
  }
  try {
    return JSON.parse(content[0].text);
  } catch {
    throw new SmokeError('E_BLOCKBENCH_ERROR', `${toolName} returned non-JSON MCP response text.`);
  }
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new SmokeError('E_TIMEOUT', `${label} timed out after ${timeoutMs} ms.`)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sleep(ms) {
  return new Promise((resolve_) => {
    const timer = setTimeout(resolve_, ms);
    timer.unref?.();
  });
}

function log(line) {
  console.error(`[ac21-scope-isolation] ${line}`);
}

function logBlock(lines) {
  console.error('');
  for (const line of lines) log(line);
  console.error('');
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/** Pause until the operator says they are watching Blockbench. A run without a
 * TTY cannot pause, so it says so and continues rather than hanging. */
async function waitForOperator(promptText, { prompt, input = process.stdin }) {
  if (!prompt) {
    log('Operator prompt disabled (--no-prompt); continuing without pausing.');
    return 'skipped_by_flag';
  }
  if (input.isTTY !== true) {
    log('Standard input is not a terminal, so the helper cannot pause here; continuing.');
    return 'skipped_no_tty';
  }
  process.stderr.write(`[ac21-scope-isolation] ${promptText} `);
  return await new Promise((resolve_) => {
    const onData = () => {
      input.off('data', onData);
      input.pause();
      resolve_('acknowledged');
    };
    input.resume();
    input.once('data', onData);
  });
}

function assertRequiredTools(tools) {
  const toolNames = new Set(tools.tools?.map((tool) => tool.name) ?? []);
  const missing = REQUIRED_TOOLS.filter((tool) => !toolNames.has(tool));
  if (missing.length > 0) {
    throw new SmokeError('E_UNSUPPORTED_COMMAND', `Missing required MCP tools: ${missing.join(', ')}`, {
      classification: {
        code: 'E_UNSUPPORTED_COMMAND',
        category: 'required_tool_absent',
        remediation: ['Run npm run build and reload the current Blockbench plugin bundle before rerunning the smoke.'],
      },
    });
  }
}

function assertHealthPreconditions(health, options, client) {
  if (health.ok !== true) throw new ToolFailure('health', health, client);
  const result = health.result ?? {};
  const setupErrors = Array.isArray(result.setup_errors) ? result.setup_errors : [];
  if (setupErrors.length > 0) {
    const classified = setupErrors.map((issue) => classifySetupIssue(issue, options.port));
    throw new SmokeError(classified[0].code, classified[0].message, { client, setup_errors: classified });
  }
  if (result.ws_listening !== true) {
    throw new SmokeError('E_PORT_IN_USE', `Adapter WebSocket listener is not ready on 127.0.0.1:${options.port}.`, {
      client,
      classification: classifySetupIssue({ code: 'E_PORT_IN_USE' }, options.port),
    });
  }
  if (result.plugin_connected !== true) {
    throw new SmokeError('E_PLUGIN_NOT_CONNECTED', `Blockbench MCP plugin is not connected to client ${client}.`, {
      client,
      classification: classifyToolFailure('health', { code: 'E_PLUGIN_NOT_CONNECTED' }),
    });
  }
}

/**
 * One adapter child plus its MCP client. Client A and client B are separate
 * processes with distinct `--client-label` values, which is what makes them a
 * different client to the broker and not two views of one session.
 */
async function startAdapterClient({ label, options, modeEnv, configPath, commands, knownSecrets, homeDir }) {
  const env = adapterEnvForMode(modeEnv, process.env);
  env.BLOCKBENCH_MCP_PORT = String(options.port);
  env.BLOCKBENCH_MCP_SECRET = options.secret;
  env.BLOCKBENCH_MCP_CONFIG = configPath;
  env.BLOCKBENCH_MCP_REQUEST_TIMEOUT_MS = String(Math.min(options.timeoutMs, DEFAULT_TIMEOUT_MS));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [adapterCliPath, '--client-label', `ac21-client-${label.toLowerCase()}`],
    env,
    cwd: projectRoot,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => {
    const text = sanitizeForReport(String(chunk), knownSecrets, homeDir).trimEnd();
    if (text.length > 0) console.error(`[adapter-${label}] ${text}`);
  });
  const client = new Client({ name: `ac21-scope-isolation-${label.toLowerCase()}`, version: '0.1.0' });
  await withTimeout(client.connect(transport), options.timeoutMs, `MCP adapter startup (client ${label})`);
  assertRequiredTools(await withTimeout(client.listTools(), options.timeoutMs, `MCP tools/list (client ${label})`));

  /** Call a tool and record the envelope. `tolerateFailure` returns the failed
   * envelope instead of throwing, which is how the assertion reads a denial as
   * an observation rather than as an exception. */
  const callTool = async (name, args, { timeoutMs = options.timeoutMs, tolerateFailure = false } = {}) => {
    const raw = await withTimeout(client.callTool({ name, arguments: args }, { timeout: timeoutMs }), timeoutMs + 5_000, `${name} (client ${label})`);
    const envelope = parseEnvelope(raw, name);
    commands.push(summarizeEnvelope(name, envelope, knownSecrets, homeDir, label));
    if (envelope.ok !== true && !tolerateFailure) throw new ToolFailure(name, envelope, label);
    return envelope;
  };

  return { label, client, transport, callTool, pid: transport.pid ?? null };
}

async function closeAdapterClient(handle) {
  if (handle === undefined || handle === null) return;
  try {
    await handle.client.close();
  } catch (error) {
    log(`Cleanup warning while closing client ${handle.label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function readBrokerRecordFile(recordPath) {
  try {
    const raw = await readFile(recordPath, 'utf8');
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Poll `health` on a client until the plugin is connected again. */
async function waitForPluginReconnect(handle, options) {
  const deadline = Date.now() + options.reconnectTimeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const health = await handle.callTool('health', {}, { tolerateFailure: true });
    last = health;
    if (health.ok === true && health.result?.plugin_connected === true && health.result?.ws_listening === true) {
      return { reconnected: true, health, waitedMs: options.reconnectTimeoutMs - (deadline - Date.now()) };
    }
    await sleep(1_000);
  }
  return { reconnected: false, health: last, waitedMs: options.reconnectTimeoutMs };
}

async function runSmoke(options) {
  const startedAt = new Date().toISOString();
  const homeDir = homedir();
  const knownSecrets = options.secret === undefined ? [] : [options.secret];
  const commands = [];
  const modeRequest = resolveModeRequest({ requested: options.mode, platform: process.platform });
  const phases = {
    establish: { status: 'not_run', client: 'A' },
    disrupt: { status: 'not_run', applied: false, kind: disruptionForMode(modeRequest.expected).kind },
    assert: { status: 'not_run', client: 'B' },
    reestablish: { status: 'not_run', client: 'B' },
  };
  const clients = { a: { pid: null, label: 'ac21-client-a' }, b: { pid: null, label: 'ac21-client-b' } };
  let observedMode = null;
  let fatal;
  let clientA;
  let clientB;

  const selected = await createRunDirectory({ outParent: options.outParent });
  const reportPath = join(selected.runDir, 'smoke-report.json');
  const checklistPath = join(selected.runDir, 'operator-checklist.md');
  const scopeDir = options.scopeDir ?? join(selected.runDir, 'scope-root');
  const configPath = join(selected.runDir, 'adapter-config.json');

  await writeFile(checklistPath, generateReviewChecklist({ reportFile: reportPath, scopeDir, mode: options.mode, port: options.port }));
  log(`Run directory: ${selected.runDir}`);
  log(`Operator checklist: ${checklistPath}`);

  try {
    if (options.secret === undefined) {
      throw new SmokeError('E_SECRET_MISSING', 'Missing shared secret. Set BLOCKBENCH_MCP_SECRET before running the AC-21 scope-isolation smoke.', {
        classification: classifySetupIssue({ code: 'E_SECRET_MISSING' }, options.port),
      });
    }
    if (!existsSync(adapterCliPath)) {
      throw new SmokeError('E_BUILD_OUTPUT_MISSING', 'Missing dist/adapter/cli.js. Run npm run build before the AC-21 scope-isolation smoke.');
    }
    if (options.lessSafeSecretFlag) {
      log('Warning: --secret is less safe; prefer BLOCKBENCH_MCP_SECRET for regular use.');
    }

    await mkdir(scopeDir, { recursive: true });
    // A per-run config file gives this run its own broker identity, so the
    // broker crash in phase 2 can only ever reach this run's own broker.
    await writeJson(configPath, { port: options.port });
    const brokerLocation = brokerRecordPathFor({
      resolvedConfigPath: resolve(configPath),
      platform: process.platform,
      runtimeDirOverride: process.env.BLOCKBENCH_MCP_RUNTIME_DIR,
    });

    // -- Phase 1: establish -------------------------------------------------
    clientA = await startAdapterClient({ label: 'A', options, modeEnv: modeRequest.expected, configPath, commands, knownSecrets, homeDir });
    clients.a.pid = clientA.pid;

    const healthA = await clientA.callTool('health', {});
    // Read the resolved mode back before the preconditions are asserted, so
    // even a run that stops here records which mode it was actually in.
    observedMode = healthA.result?.mode ?? null;
    assertHealthPreconditions(healthA, options, 'A');
    if (observedMode !== modeRequest.expected) {
      throw new SmokeError(
        'E_AC21_MODE_NOT_HONOURED',
        `The adapter resolved mode "${String(observedMode)}" but this run asked for "${modeRequest.expected}".`,
        { requested: modeRequest.requested, expected: modeRequest.expected, observed: observedMode },
      );
    }
    log(`Observed adapter mode (read back from health): ${observedMode}`);
    phases.disrupt.kind = disruptionForMode(observedMode).kind;

    await clientA.callTool('get_plugin_status', {});

    logBlock(describeHumanStep('confirm_a', { scopeDir, confirmTimeoutMs: options.confirmTimeoutMs }));
    const gateA = await waitForOperator('Press Enter when Blockbench is in front of you and you are ready to confirm.', options);

    const proposeA = await clientA.callTool(
      'propose_scoped_directory',
      { path: scopeDir, reason: 'AC-21 live scope-isolation smoke: client A establishing a confirmed scoped directory.' },
      { timeoutMs: options.confirmTimeoutMs },
    );

    const probeContent = `ac21-scope-isolation-probe\nrun=${selected.runId}\nnonce=${randomBytes(8).toString('hex')}\n`;
    const writeA = await clientA.callTool('write_files', {
      files: [{ path: PROBE_FILE_NAME, content: probeContent, encoding: 'utf8', overwrite: true }],
    });
    const readA = await clientA.callTool('read_file', { path: PROBE_FILE_NAME, encoding: 'utf8' });
    const positiveControlOk = readA.result?.content === probeContent;

    phases.establish = {
      status: positiveControlOk ? 'passed' : 'failed',
      client: 'A',
      operator_gate: gateA,
      scope_confirmed: proposeA.result?.state === 'confirmed',
      normalized_path: proposeA.result?.normalized_path ?? null,
      probe_file: PROBE_FILE_NAME,
      probe_sha256: sha256(Buffer.from(probeContent, 'utf8')),
      positive_control: {
        write_ok: writeA.ok === true,
        read_ok: readA.ok === true,
        content_matched: positiveControlOk,
        bytes: readA.result?.bytes ?? null,
      },
      detail: positiveControlOk
        ? 'Client A confirmed the directory and performed a real scoped write and read-back.'
        : 'Client A could not read back what it wrote, so its grant was not proven usable.',
    };
    if (!positiveControlOk) {
      throw new SmokeError('E_AC21_POSITIVE_CONTROL_FAILED', 'Client A could not read back the file it wrote inside the confirmed scoped directory.');
    }
    log('Phase 1 passed: client A holds a confirmed scoped directory and used it.');

    // -- Phase 2: disrupt ---------------------------------------------------
    logBlock(describeHumanStep('disrupt', { scopeDir }));
    const disruption = disruptionForMode(observedMode);
    phases.disrupt = { status: 'running', applied: false, kind: disruption.kind, description: disruption.description, client_a_state: 'kept_open' };

    if (disruption.kind === 'broker_crash') {
      const record = await readBrokerRecordFile(brokerLocation.recordPath);
      const brokerPid = assertKillableBrokerRecord(record, { port: options.port, selfPid: process.pid });
      log(`Crashing this run's broker (pid ${String(brokerPid)}) with SIGKILL.`);
      try {
        process.kill(brokerPid, 'SIGKILL');
      } catch (error) {
        throw new SmokeError('E_AC21_BROKER_CRASH_FAILED', `Could not signal the broker process (pid ${String(brokerPid)}).`, {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      const deadline = Date.now() + 15_000;
      while (processAlive(brokerPid) && Date.now() < deadline) await sleep(200);
      const confirmedDead = !processAlive(brokerPid);
      phases.disrupt.broker = {
        record_found: true,
        broker_pid_signalled: brokerPid,
        confirmed_dead: confirmedDead,
        ws_port: record.ws_port,
        // Deliberately left behind: the adapter's own recovery is what must
        // clean up after a crashed broker, and tidying up here would hide a
        // defect in that recovery.
        stale_record_left_in_place: true,
      };
      if (!confirmedDead) {
        throw new SmokeError('E_AC21_BROKER_CRASH_FAILED', `The broker process (pid ${String(brokerPid)}) was still alive after SIGKILL.`);
      }
      phases.disrupt.applied = true;
    } else {
      log('Restarting the adapter: closing client A so the plugin reconnects to a new adapter process.');
      await closeAdapterClient(clientA);
      clientA = undefined;
      phases.disrupt.client_a_state = 'closed';
      // The direct-mode listener has to release 127.0.0.1:<port> before client
      // B can take it.
      await sleep(1_000);
      phases.disrupt.applied = true;
    }

    // -- Client B and the reconnect ----------------------------------------
    clientB = await startAdapterClient({ label: 'B', options, modeEnv: modeRequest.expected, configPath, commands, knownSecrets, homeDir });
    clients.b.pid = clientB.pid;
    log('Waiting for the Blockbench plugin to reconnect (this can take up to about 30 seconds).');
    const reconnect = await waitForPluginReconnect(clientB, options);
    phases.disrupt.plugin_reconnected = reconnect.reconnected;
    phases.disrupt.reconnect_waited_ms = reconnect.waitedMs;
    phases.disrupt.status = reconnect.reconnected ? 'passed' : 'failed';
    if (!reconnect.reconnected) {
      throw new SmokeError('E_AC21_RECONNECT_TIMEOUT', `The Blockbench plugin did not reconnect within ${String(options.reconnectTimeoutMs)} ms after the disruption.`);
    }
    log(`Phase 2 passed: ${disruption.kind} applied and the plugin reconnected.`);

    // -- Phase 3: the assertion --------------------------------------------
    logBlock(describeHumanStep('assert', { scopeDir }));
    const healthB = await clientB.callTool('health', {}, { tolerateFailure: true });
    const observedModeB = healthB.result?.mode ?? null;
    // `get_plugin_status` is a public command, so reaching the plugin at all
    // means the bridge's revocation gate opened for this session. Its `scope`
    // field is therefore the plugin's state after the revocation ran.
    const statusB = await clientB.callTool('get_plugin_status', {}, { tolerateFailure: true });
    const pluginScopeState = statusB.ok === true ? (statusB.result?.scope?.state ?? null) : null;

    const attemptEnvelope = await clientB.callTool('read_file', { path: PROBE_FILE_NAME, encoding: 'utf8' }, { tolerateFailure: true });
    const attempt = classifyScopedAttempt(attemptEnvelope, probeContent);

    phases.assert = {
      status: 'observed',
      client: 'B',
      observed_mode: observedModeB,
      negative_controls: {
        health_ok: healthB.ok === true && healthB.result?.plugin_connected === true,
        get_plugin_status_ok: statusB.ok === true,
        note: 'health is answered by the adapter; get_plugin_status is relayed to the plugin, so both together separate a dead adapter from a denied command.',
      },
      plugin_scope_state: pluginScopeState,
      scoped_operation: { command: 'read_file', path: PROBE_FILE_NAME, ...attempt },
      detail:
        attempt.outcome === 'granted'
          ? 'Client B read the file client A wrote inside client A\'s confirmed scoped directory.'
          : `Client B was refused with ${String(attempt.code)}.`,
    };
    if (attempt.outcome === 'granted') {
      log('Phase 3 OBSERVED A VIOLATION: client B read client A\'s scoped file.');
    } else {
      log(`Phase 3: client B was denied with ${String(attempt.code)} (plugin scope state: ${String(pluginScopeState)}).`);
    }

    // -- Phase 4: re-establish ---------------------------------------------
    logBlock(describeHumanStep('confirm_b', { scopeDir, confirmTimeoutMs: options.confirmTimeoutMs }));
    const gateB = await waitForOperator('Press Enter when you are ready to confirm the second proposal.', options);
    const proposeB = await clientB.callTool(
      'propose_scoped_directory',
      { path: scopeDir, reason: 'AC-21 live scope-isolation smoke: client B re-establishing the confirmation after the disruption.' },
      { timeoutMs: options.confirmTimeoutMs, tolerateFailure: true },
    );
    const readB = proposeB.ok === true ? await clientB.callTool('read_file', { path: PROBE_FILE_NAME, encoding: 'utf8' }, { tolerateFailure: true }) : null;
    const recovered = proposeB.ok === true && readB?.ok === true && readB.result?.content === probeContent;
    phases.reestablish = {
      status: recovered ? 'passed' : 'failed',
      client: 'B',
      operator_gate: gateB,
      scope_confirmed: proposeB.result?.state === 'confirmed',
      read_back_ok: readB?.ok === true,
      content_matched: recovered,
      detail: recovered
        ? 'A fresh confirmation restored client B\'s access to the same directory.'
        : 'A fresh confirmation did not restore access, so the phase 3 denial cannot be shown to be recoverable state.',
    };
  } catch (error) {
    fatal = error;
  } finally {
    await closeAdapterClient(clientB);
    await closeAdapterClient(clientA);
  }

  const decision = decideVerdict(phases);
  const report = buildSmokeReport({
    verdict: decision.verdict,
    verdictReason: { code: decision.code, message: decision.message, remediation: decision.remediation },
    startedAt,
    options,
    runDir: selected.runDir,
    scopeDir,
    modeRequest,
    observedMode,
    clients,
    phases,
    commands,
    failure: fatal === undefined ? undefined : failureObject(fatal, knownSecrets, homeDir),
    knownSecrets,
    homeDir,
  });
  await writeJson(reportPath, report);

  console.error('');
  log(`VERDICT: ${decision.verdict}`);
  log(decision.message);
  for (const line of decision.remediation ?? []) log(`  - ${line}`);
  if (fatal !== undefined) log(`Stopped early: ${failureObject(fatal, knownSecrets, homeDir).message}`);
  log(`Receipt: ${reportPath}`);
  log(`Checklist: ${checklistPath}`);
  log('Send both files back with the checklist boxes ticked.');

  return { verdict: decision.verdict, reportPath, checklistPath, runDir: selected.runDir };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseSmokeArgs(argv, env);
  if (options.help) {
    process.stdout.write(helpText());
    return 0;
  }
  const result = await runSmoke(options);
  return verdictExitCode(result.verdict);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      const failure = failureObject(error, [], homedir());
      console.error(`[ac21-scope-isolation] VERDICT: INCONCLUSIVE`);
      console.error(`[ac21-scope-isolation] Failed before a receipt could be written: ${failure.message}`);
      process.exit(2);
    });
}
