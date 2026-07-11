#!/usr/bin/env node
// Semi-automated GeckoLib live smoke helper. It drives the built MCP adapter
// against a real Blockbench + GeckoLib runtime, writes local review artifacts,
// and leaves visual correctness to a human reviewer.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const DEFAULT_PORT = 39731;
const DEFAULT_TIMEOUT_MS = 90_000;
const FRAME_WIDTH = 512;
const FRAME_HEIGHT = 512;
const FRAME_PRESET = 'isometric_right';
const ANIMATION_NAME = 'animation.smoke.pose_check';
const REQUIRED_TOOLS = [
  'health',
  'get_plugin_status',
  'create_geckolib_project',
  'create_group',
  'create_cubes',
  'upsert_geckolib_animation',
  'capture_geckolib_animation_frame',
];

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
  constructor(command, envelope) {
    const error = envelope?.error ?? { code: 'E_BLOCKBENCH_ERROR', message: 'Tool returned a failed envelope.' };
    const classified = classifyToolFailure(command, error);
    super(classified.code, classified.message, { command, envelope, classification: classified });
    this.name = 'ToolFailure';
    this.command = command;
    this.envelope = envelope;
    this.classification = classified;
  }
}

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

export function parseSmokeArgs(argv = [], env = process.env) {
  const envPort = env.BLOCKBENCH_MCP_PORT;
  const options = {
    port: envPort !== undefined && envPort !== '' ? parseIntegerOption('BLOCKBENCH_MCP_PORT', envPort, 1, 65_535) : DEFAULT_PORT,
    outParent: undefined,
    secret: env.BLOCKBENCH_MCP_SECRET && env.BLOCKBENCH_MCP_SECRET !== '' ? env.BLOCKBENCH_MCP_SECRET : undefined,
    authSource: env.BLOCKBENCH_MCP_SECRET && env.BLOCKBENCH_MCP_SECRET !== '' ? 'environment' : 'missing',
    lessSafeSecretFlag: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
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
    } else if (flag === '--out') {
      const read = readOptionValue(argv, i, '--out', inlineValue);
      options.outParent = resolve(read.value);
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
    } else {
      throw new SmokeError('E_INVALID_PARAMS', `Unknown option: ${arg}`);
    }
  }

  return options;
}

export function helpText() {
  return `GeckoLib live smoke helper\n\nUsage:\n  BLOCKBENCH_MCP_SECRET=<secret> npm run smoke:geckolib-live -- [--port 39731] [--out ./smoke-output] [--timeout-ms 90000]\n\nOptions:\n  --port <port>        Adapter/WebSocket port. If changed, configure the Blockbench plugin to the same port and reconnect.\n  --out <dir>          Parent directory for a unique smoke run subdirectory. Defaults to the system temp directory.\n  --timeout-ms <ms>    MCP startup/tool timeout guard for this helper. Default: ${DEFAULT_TIMEOUT_MS}.\n  --secret <secret>    Less-safe convenience override. Prefer BLOCKBENCH_MCP_SECRET so the secret is less likely to leak through shell history or process listings.\n  --help               Show this help.\n`;
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function selectRunDirectory({ outParent, now = new Date(), randomHex = randomBytes(4).toString('hex') } = {}) {
  const parent = resolve(outParent ?? tmpdir());
  const runId = `geckolib-live-smoke-${timestampForPath(now)}-${randomHex}`;
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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function decodePngDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') {
    throw new SmokeError('E_INVALID_PARAMS', 'Screenshot data_url must be a PNG data URL string.');
  }
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (match === null || match[1].length % 4 !== 0) {
    throw new SmokeError('E_INVALID_PARAMS', 'Screenshot data_url is not a valid PNG base64 data URL.');
  }
  const buffer = Buffer.from(match[1], 'base64');
  if (buffer.length === 0) {
    throw new SmokeError('E_INVALID_PARAMS', 'Screenshot data_url decoded to an empty image.');
  }
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new SmokeError('E_INVALID_PARAMS', 'Screenshot data_url did not decode to a PNG payload.');
  }
  return buffer;
}

export async function writePngDataUrl(dataUrl, filePath) {
  const buffer = decodePngDataUrl(dataUrl);
  await writeFile(filePath, buffer);
  return { bytes: buffer.length, sha256: sha256(buffer) };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const SENSITIVE_KEY_RE = /(?:secret|token|password|credential|authorization)/i;

export function sanitizeForReport(value, knownSecrets = []) {
  const secrets = knownSecrets.filter((secret) => typeof secret === 'string' && secret.length > 0);
  const redactString = (input) => {
    let output = input;
    for (const secret of secrets) {
      output = output.split(secret).join('[redacted]');
      output = output.split(Buffer.from(secret, 'utf8').toString('base64')).join('[redacted]');
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

function sanitizeEnvelopeResult(command, result) {
  if (!isPlainObject(result)) return result;
  if (command === 'capture_geckolib_animation_frame') {
    const { data_url: _dataUrl, ...metadata } = result;
    return metadata;
  }
  return result;
}

export function summarizeEnvelope(command, envelope, knownSecrets = []) {
  return sanitizeForReport(
    {
      command,
      ok: envelope?.ok === true,
      summary: envelope?.summary,
      result: envelope?.ok === true ? sanitizeEnvelopeResult(command, envelope.result) : undefined,
      error: envelope?.ok === false ? envelope.error : undefined,
    },
    knownSecrets,
  );
}

export function classifySetupIssue(issue, port) {
  const code = issue?.code ?? 'E_BLOCKBENCH_ERROR';
  if (code === 'E_SECRET_MISSING') {
    return {
      code,
      category: 'missing_secret',
      message: 'Missing shared secret. Set BLOCKBENCH_MCP_SECRET before running the GeckoLib live smoke helper.',
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
        'Close the other adapter process you started, or rerun with --port <free-port>.',
        'If you change the port, set the Blockbench MCP plugin to the same port and reconnect it.',
      ],
    };
  }
  return {
    code,
    category: 'adapter_setup',
    message: issue?.message ?? 'The adapter reported a setup issue.',
    remediation: ['Fix the adapter setup issue reported by health, then rerun the GeckoLib live smoke helper.'],
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
        'Install and enable the GeckoLib Models & Animations plugin in Blockbench.',
        'Verify the Blockbench MCP plugin uses the same port and shared secret, then reconnect.',
        'If the plugin bundle is stale, rebuild and reload it; stale protocol handshakes may appear as a disconnected-plugin precondition.',
        'Ensure no conflicting adapter owns the selected port.',
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
  if (code === 'E_PLUGIN_DEPENDENCY_MISSING') {
    return {
      code,
      category: 'geckolib_unavailable',
      message: `Cannot run ${command}: the GeckoLib Models & Animations plugin is unavailable in Blockbench.`,
      remediation: ['Install or enable the GeckoLib Models & Animations plugin in Blockbench, then rerun the smoke helper.'],
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
    remediation: ['Review smoke-report.json for the failed command, fix the runtime precondition, and rerun the helper.'],
  };
}

function failureObject(error, knownSecrets = []) {
  if (error instanceof ToolFailure) {
    return sanitizeForReport(
      {
        code: error.code,
        message: error.message,
        command: error.command,
        classification: error.classification,
        envelope: summarizeEnvelope(error.command, error.envelope, knownSecrets),
      },
      knownSecrets,
    );
  }
  if (error instanceof SmokeError) {
    return sanitizeForReport({ code: error.code, message: error.message, details: error.details }, knownSecrets);
  }
  return sanitizeForReport(
    { code: 'E_BLOCKBENCH_ERROR', message: error instanceof Error ? error.message : String(error) },
    knownSecrets,
  );
}

export function buildSmokeReport({
  status,
  startedAt,
  completedAt = new Date().toISOString(),
  options,
  runDir,
  adapterPid,
  pluginStatus,
  health,
  commands = [],
  frames = [],
  sanityChecks = [],
  failure = undefined,
  knownSecrets = [],
}) {
  const report = {
    schema_version: 1,
    smoke_name: 'GeckoLib live smoke',
    status,
    human_review_required: true,
    review_status: status === 'ready_for_human_review' ? 'pending_human_review' : 'not_ready',
    started_at: startedAt,
    completed_at: completedAt,
    config: {
      port: options.port,
      output_dir: runDir,
      auth: { configured: Boolean(options.secret), source: options.authSource },
      cli_auth_override_used: options.lessSafeSecretFlag,
      timeout_ms: options.timeoutMs,
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      adapter: { cli: 'dist/adapter/cli.js', pid: adapterPid ?? null },
      health: health?.result ?? null,
      plugin: pluginStatus?.result ?? null,
    },
    commands,
    frames,
    sanity_checks: sanityChecks,
    failure,
  };
  return sanitizeForReport(report, knownSecrets);
}

export function generateReviewChecklist({ reportFile = 'smoke-report.json', frameFiles = ['frame-0.png', 'frame-1.png'] } = {}) {
  return `# GeckoLib live smoke human visual review\n\nAutomated sanity checks do not prove visual correctness. Complete this checklist before treating the live smoke as visually passed.\n\n## Artifacts\n- Report: ${reportFile}\n- Frames:\n${frameFiles.map((file) => `  - ${file}`).join('\n')}\n\n## Required checks\n- [ ] Open both PNG files and confirm they show visibly different GeckoLib poses of the asymmetric fixture.\n- [ ] Confirm the screenshots are framed well enough to inspect the animated body group.\n- [ ] Confirm no playback started while the still frames were captured.\n- [ ] Confirm no unexpected sound, particle, or timeline effects were observed.\n- [ ] Confirm Blockbench remains usable after the run.\n- [ ] Close or discard the unsaved smoke project tab after recording notes.\n\n## Reviewer notes\n- Reviewer:\n- Blockbench version:\n- GeckoLib plugin version:\n- Visual review result (pass/fail):\n- Notes or follow-up fixes:\n`;
}

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

function assertRequiredTools(tools) {
  const toolNames = new Set(tools.tools?.map((tool) => tool.name) ?? []);
  const missing = REQUIRED_TOOLS.filter((tool) => !toolNames.has(tool));
  if (missing.length > 0) {
    throw new SmokeError('E_UNSUPPORTED_COMMAND', `Missing required MCP tools: ${missing.join(', ')}`, {
      classification: {
        code: 'E_UNSUPPORTED_COMMAND',
        category: 'required_tool_absent',
        remediation: ['Run npm run build and reload the current Blockbench plugin bundle before rerunning the smoke helper.'],
      },
    });
  }
}

function assertHealthPreconditions(health, options) {
  if (health.ok !== true) {
    throw new ToolFailure('health', health);
  }
  const result = health.result ?? {};
  const setupErrors = Array.isArray(result.setup_errors) ? result.setup_errors : [];
  if (setupErrors.length > 0) {
    const classified = setupErrors.map((issue) => classifySetupIssue(issue, options.port));
    throw new SmokeError(classified[0].code, classified[0].message, { setup_errors: classified });
  }
  if (result.ws_listening !== true) {
    throw new SmokeError('E_PORT_IN_USE', `Adapter WebSocket listener is not ready on 127.0.0.1:${options.port}.`, {
      classification: classifySetupIssue({ code: 'E_PORT_IN_USE' }, options.port),
    });
  }
  if (result.plugin_connected !== true) {
    throw new SmokeError('E_PLUGIN_NOT_CONNECTED', 'Blockbench MCP plugin is not connected; fixture commands were not run.', {
      classification: classifyToolFailure('health', { code: 'E_PLUGIN_NOT_CONNECTED' }),
    });
  }
}

function assertPluginPreconditions(pluginStatus, health) {
  if (pluginStatus.ok !== true) {
    throw new ToolFailure('get_plugin_status', pluginStatus);
  }
  const status = pluginStatus.result ?? {};
  if (typeof health.result?.protocol_version === 'number' && status.protocol_version !== health.result.protocol_version) {
    throw new SmokeError('E_PROTOCOL_MISMATCH', 'Adapter and Blockbench plugin protocol versions do not match.', {
      adapter_protocol_version: health.result.protocol_version,
      plugin_protocol_version: status.protocol_version,
      classification: classifyToolFailure('get_plugin_status', { code: 'E_PROTOCOL_MISMATCH' }),
    });
  }
  const capabilities = Array.isArray(status.capabilities) ? status.capabilities : [];
  if (!capabilities.includes('geckolib_model')) {
    throw new SmokeError('E_PLUGIN_DEPENDENCY_MISSING', 'GeckoLib capability is not available in the connected Blockbench runtime.', {
      capabilities,
      classification: classifyToolFailure('create_geckolib_project', { code: 'E_PLUGIN_DEPENDENCY_MISSING' }),
    });
  }
}

function buildFixtureCommands(runId) {
  const projectIdentifier = `smoke_pose_${runId.replace(/[^a-z0-9_]/gi, '_').toLowerCase().slice(-24)}`;
  return {
    createProject: {
      modid: 'smokemod',
      model_type: 'Entity',
      identifier: projectIdentifier,
      name: 'GeckoLib live smoke pose check',
      force: true,
    },
    createGroup: { name: 'body', origin: [0, 12, 0] },
    cubes: (groupUuid) => ({
      cubes: [
        { name: 'body_core', from: [-3, 6, -2], to: [3, 18, 2], origin: [0, 12, 0], group_uuid: groupUuid, box_uv: true, uv_offset: [0, 0] },
        { name: 'right_marker', from: [3, 12, -1], to: [8, 15, 1], origin: [0, 12, 0], group_uuid: groupUuid, box_uv: true, uv_offset: [16, 0] },
        { name: 'top_marker', from: [-1, 18, -1], to: [1, 24, 1], origin: [0, 12, 0], group_uuid: groupUuid, box_uv: true, uv_offset: [32, 0] },
      ],
    }),
    animation: {
      name: ANIMATION_NAME,
      length: 1,
      loop: 'hold_on_last_frame',
      bones: {
        body: {
          rotation: [
            { time: 0, value: [0, 0, 0] },
            { time: 0.5, value: [0, 35, 0], easing: 'easeInOutSine' },
            { time: 1, value: [0, -35, 20], easing: 'easeInOutSine' },
          ],
          position: [
            { time: 0, value: [0, 0, 0] },
            { time: 1, value: [0, 1.5, 0] },
          ],
        },
      },
    },
    captures: [0, 1].map((time) => ({
      animation: ANIMATION_NAME,
      time,
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      angle_preset: FRAME_PRESET,
    })),
  };
}

function runSanityChecks(frames) {
  const checks = [];
  for (const frame of frames) {
    checks.push({ name: `frame-${frame.index}-non-empty-png`, ok: frame.bytes > 0, details: { bytes: frame.bytes } });
    checks.push({
      name: `frame-${frame.index}-metadata-echo`,
      ok:
        frame.metadata.animation === frame.request.animation &&
        frame.metadata.time === frame.request.time &&
        frame.metadata.width === frame.request.width &&
        frame.metadata.height === frame.request.height &&
        frame.metadata.angle_preset === frame.request.angle_preset &&
        typeof frame.metadata.rendered_time === 'number',
      details: { request: frame.request, metadata: frame.metadata },
    });
  }
  checks.push({
    name: 'captured-frame-hashes-distinct',
    ok: new Set(frames.map((frame) => frame.sha256)).size === frames.length,
    details: { hashes: frames.map((frame) => frame.sha256) },
  });
  return checks;
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function runSmoke(options) {
  if (!options.secret) {
    throw new SmokeError('E_SECRET_MISSING', 'Missing shared secret. Set BLOCKBENCH_MCP_SECRET before running the GeckoLib live smoke helper.');
  }
  if (!existsSync(adapterCliPath)) {
    throw new SmokeError('E_BUILD_OUTPUT_MISSING', 'Missing dist/adapter/cli.js. Run npm run build before the GeckoLib live smoke helper.');
  }

  if (options.lessSafeSecretFlag) {
    console.error('[geckolib-live-smoke] Warning: --secret is less safe; prefer BLOCKBENCH_MCP_SECRET for regular use.');
  }

  const startedAt = new Date().toISOString();
  const selected = await createRunDirectory({ outParent: options.outParent });
  const reportPath = join(selected.runDir, 'smoke-report.json');
  const checklistPath = join(selected.runDir, 'review-checklist.md');
  const knownSecrets = [options.secret];
  const commands = [];
  const frames = [];
  let sanityChecks = [];
  let client;
  let transport;
  let health;
  let pluginStatus;

  const writeFailureReport = async (error) => {
    const report = buildSmokeReport({
      status: 'failed',
      startedAt,
      options,
      runDir: selected.runDir,
      adapterPid: transport?.pid ?? null,
      health,
      pluginStatus,
      commands,
      frames,
      sanityChecks,
      failure: failureObject(error, knownSecrets),
      knownSecrets,
    });
    await writeJson(reportPath, report);
    return reportPath;
  };

  try {
    const env = { ...process.env };
    env.BLOCKBENCH_MCP_PORT = String(options.port);
    env.BLOCKBENCH_MCP_SECRET = options.secret;
    env.BLOCKBENCH_MCP_REQUEST_TIMEOUT_MS = String(Math.min(options.timeoutMs, DEFAULT_TIMEOUT_MS));

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [adapterCliPath],
      env,
      cwd: projectRoot,
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk) => {
      const text = sanitizeForReport(String(chunk), knownSecrets).trimEnd();
      if (text.length > 0) console.error(text);
    });
    client = new Client({ name: 'geckolib-live-smoke', version: '0.1.0' });
    await withTimeout(client.connect(transport), options.timeoutMs, 'MCP adapter startup');

    const tools = await withTimeout(client.listTools(), options.timeoutMs, 'MCP tools/list');
    assertRequiredTools(tools);

    const callTool = async (name, args) => {
      const envelope = parseEnvelope(await withTimeout(client.callTool({ name, arguments: args }), options.timeoutMs, name), name);
      commands.push(summarizeEnvelope(name, envelope, knownSecrets));
      if (envelope.ok !== true) throw new ToolFailure(name, envelope);
      return envelope;
    };

    health = await callTool('health', {});
    assertHealthPreconditions(health, options);

    pluginStatus = await callTool('get_plugin_status', {});
    assertPluginPreconditions(pluginStatus, health);

    console.error('[geckolib-live-smoke] Pre-run notice: this helper will create and leave a new unsaved GeckoLib project tab for manual inspection.');
    console.error('[geckolib-live-smoke] No existing project files are opened, saved, or overwritten; close/discard the smoke tab manually after review.');

    const fixture = buildFixtureCommands(selected.runId);
    await callTool('create_geckolib_project', fixture.createProject);
    const group = await callTool('create_group', fixture.createGroup);
    const groupUuid = group.result?.uuid;
    if (typeof groupUuid !== 'string' || groupUuid.length === 0) {
      throw new SmokeError('E_BLOCKBENCH_ERROR', 'create_group did not return a group uuid.');
    }
    await callTool('create_cubes', fixture.cubes(groupUuid));
    await callTool('upsert_geckolib_animation', fixture.animation);

    for (let index = 0; index < fixture.captures.length; index += 1) {
      const request = fixture.captures[index];
      const capture = await callTool('capture_geckolib_animation_frame', request);
      const fileName = `frame-${index}.png`;
      const filePath = join(selected.runDir, fileName);
      const image = await writePngDataUrl(capture.result?.data_url, filePath);
      frames.push({
        index,
        file: filePath,
        bytes: image.bytes,
        sha256: image.sha256,
        request,
        metadata: sanitizeEnvelopeResult('capture_geckolib_animation_frame', capture.result),
      });
    }

    sanityChecks = runSanityChecks(frames);
    if (sanityChecks.some((check) => check.ok !== true)) {
      throw new SmokeError('E_SMOKE_SANITY_FAILED', 'Automated sanity checks failed; human visual review is not ready.', {
        sanity_checks: sanityChecks,
      });
    }

    const report = buildSmokeReport({
      status: 'ready_for_human_review',
      startedAt,
      options,
      runDir: selected.runDir,
      adapterPid: transport?.pid ?? null,
      health,
      pluginStatus,
      commands,
      frames,
      sanityChecks,
      knownSecrets,
    });
    await writeJson(reportPath, report);
    await writeFile(checklistPath, generateReviewChecklist({ reportFile: reportPath, frameFiles: frames.map((frame) => frame.file) }));

    console.error('[geckolib-live-smoke] Automated sanity result: pass');
    console.error(`[geckolib-live-smoke] Output directory: ${selected.runDir}`);
    console.error(`[geckolib-live-smoke] Report: ${reportPath}`);
    console.error(`[geckolib-live-smoke] Review checklist: ${checklistPath}`);
    console.error('[geckolib-live-smoke] human_review_required: true');
    return { ok: true, reportPath, checklistPath, runDir: selected.runDir };
  } catch (error) {
    const partialPath = await writeFailureReport(error);
    console.error(`[geckolib-live-smoke] Failed: ${failureObject(error, knownSecrets).message}`);
    console.error(`[geckolib-live-smoke] Partial report: ${partialPath}`);
    return { ok: false, error, reportPath: partialPath, runDir: selected.runDir };
  } finally {
    try {
      if (client) await client.close();
      else if (transport) await transport.close();
    } catch (error) {
      console.error(`[geckolib-live-smoke] Adapter cleanup warning: ${sanitizeForReport(error instanceof Error ? error.message : String(error), knownSecrets)}`);
    }
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseSmokeArgs(argv, env);
  if (options.help) {
    process.stdout.write(helpText());
    return 0;
  }
  const result = await runSmoke(options);
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code)).catch((error) => {
    const failure = failureObject(error, []);
    console.error(`[geckolib-live-smoke] Failed before report creation: ${failure.message}`);
    process.exit(1);
  });
}
