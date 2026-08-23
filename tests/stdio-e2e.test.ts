// End-to-end tests over the real stdio surface: the SDK client launches the
// built CLI (dist/adapter/cli.js), so `npm run build` must run before `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import WebSocket from 'ws';

import { COMMAND_NAMES, PROTOCOL_VERSION, type CommandName } from '../src/shared/protocol.js';
import { MODERN_PROTOCOL_VERSION } from './helpers/mcp-era-wire.ts';

const SECRET = 'e2e-secret-xyz789';
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(projectRoot, 'dist', 'adapter', 'cli.js');
let nextPort = 40200;

// The adapter resolves an implicit per-user default config file; point every
// spawned child at an empty config home so a developer machine with a real
// `minecraft-blockbench-mcp setup` state cannot leak into these tests.
const emptyConfigHome = mkdtempSync(join(tmpdir(), 'bbmcp-empty-config-home-'));

/**
 * Which MCP wire era the SDK client negotiates.
 *
 * `@modelcontextprotocol/client` defaults to the 2025-era latest, so a test
 * that constructs a client without saying otherwise only ever exercises the
 * legacy era. Pinning the modern revision fails loudly instead of falling back,
 * which is what makes a modern arm a real second observation rather than a
 * second legacy run. `scripts/verify-package.mjs` opens the packaged executable
 * the same way.
 */
type WireEra = 'legacy' | 'modern';

const ERAS: readonly WireEra[] = ['legacy', 'modern'];

function negotiationFor(era: WireEra): { mode: 'legacy' | { pin: string } } {
  return era === 'legacy' ? { mode: 'legacy' } : { mode: { pin: MODERN_PROTOCOL_VERSION } };
}

async function startClient(options: {
  port: number;
  secret?: string | undefined;
  configPath?: string | undefined;
  era?: WireEra;
  requestTimeoutMs?: number;
  maxMessageBytes?: number;
}): Promise<{ client: Client; close: () => Promise<void>; stderrText: () => string }> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.BLOCKBENCH_MCP_SECRET;
  delete env.BLOCKBENCH_MCP_CONFIG;
  env.BLOCKBENCH_MCP_DIRECT = '1';
  env.XDG_CONFIG_HOME = emptyConfigHome;
  env.HOME = emptyConfigHome;
  env.APPDATA = emptyConfigHome;
  env.USERPROFILE = emptyConfigHome;
  if (options.secret !== undefined) env.BLOCKBENCH_MCP_SECRET = options.secret;
  if (options.configPath !== undefined) env.BLOCKBENCH_MCP_CONFIG = options.configPath;
  env.BLOCKBENCH_MCP_PORT = String(options.port);
  // Keep test timing fast; these are the same knobs users can configure.
  env.BLOCKBENCH_MCP_REQUEST_TIMEOUT_MS = String(options.requestTimeoutMs ?? 2000);
  if (options.maxMessageBytes !== undefined) {
    env.BLOCKBENCH_MCP_MAX_MESSAGE_BYTES = String(options.maxMessageBytes);
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath],
    env,
    cwd: projectRoot,
    stderr: 'pipe',
  });
  const stderrChunks: string[] = [];
  const client = new Client(
    { name: 'stdio-e2e-test', version: '0.0.0' },
    { versionNegotiation: negotiationFor(options.era ?? 'legacy') },
  );
  await client.connect(transport);
  transport.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(String(chunk)));
  return {
    client,
    close: async () => {
      await client.close();
    },
    stderrText: () => stderrChunks.join(''),
  };
}

interface Envelope {
  summary: string;
  ok: boolean;
  command?: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; details?: unknown };
}

function parseEnvelope(toolResult: unknown): Envelope {
  const content = (toolResult as { content: Array<{ type: string; text: string }> }).content;
  assert.ok(Array.isArray(content) && content.length > 0, 'tool result must carry text content');
  return JSON.parse(content[0].text) as Envelope;
}

/** Minimal schema-valid arguments for every operation tool. */
const MINIMAL_ARGS: Record<CommandName, Record<string, unknown>> = {
  get_plugin_status: {},
  get_project_state: {},
  get_elements: {},
  create_cubes: { cubes: [{ from: [0, 0, 0], to: [1, 1, 1] }] },
  update_cube: { uuid: 'u-1', set: { name: 'renamed' } },
  set_cube_uv: { uuid: 'u-1', box_uv: true },
  set_texture_resolution: { width: 64, height: 64 },
  delete_cubes: { uuids: ['u-1'] },
  create_group: { name: 'bone' },
  update_group: { uuid: 'g-1', set: { name: 'renamed' } },
  delete_group: { uuid: 'g-1' },
  assign_texture: {
    source: { kind: 'data_url', data_url: 'data:image/png;base64,iVBORw0KGgo=' },
    apply_to: 'all',
  },
  read_file: { path: 'model.json' },
  write_files: { files: [{ path: 'model.json', content: '{}' }] },
  save_project: { path: 'model.bbmodel' },
  capture_screenshot: {},
  validate_project: {},
  propose_scoped_directory: { path: '/tmp/blockbench-mcp-e2e' },
  create_project: { format: 'java_block' },
  open_model: { path: 'model.json' },
  set_display_transform: { slot: 'gui', scale: [1, 1, 1] },
  export_model: { path: 'out/model.json' },
  create_geckolib_project: { modid: 'examplemod', model_type: 'Entity', identifier: 'ghost' },
  open_geckolib_model: { path: 'ghost.bbmodel' },
  export_geckolib_model: { path: 'out/ghost.geo.json' },
  export_geckolib_animations: { path: 'out/ghost.animation.json' },
  validate_geckolib_file: { geo_path: 'out/ghost.geo.json' },
  upsert_geckolib_animation: { name: 'animation.ghost.idle', length: 1, bones: {} },
  delete_geckolib_animation: { name: 'animation.ghost.idle' },
  get_geckolib_animation: { name: 'animation.ghost.idle' },
  capture_geckolib_animation_frame: { animation: 'animation.ghost.idle', time: 0 },
};

test('with Blockbench closed: initialize, list tools, healthy health, and immediate not-connected precondition errors for every operation tool', async (t) => {
  const port = nextPort++;
  const { client, close } = await startClient({ port, secret: SECRET });
  t.after(close);

  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(toolNames, ['health', ...COMMAND_NAMES].sort(), 'health plus every protocol command must be exposed');

  const health = parseEnvelope(await client.callTool({ name: 'health', arguments: {} }));
  assert.equal(health.ok, true);
  assert.equal(health.result?.plugin_connected, false);
  assert.equal(health.result?.port, port);
  assert.equal(health.result?.ws_listening, true);
  assert.equal(health.result?.protocol_version, PROTOCOL_VERSION);
  assert.deepEqual(health.result?.setup_errors, []);

  // The at-least-one-path refinement on validate_geckolib_file wraps its
  // params schema; the advertised tool schema must still name both paths.
  const validateTool = tools.tools.find((tool) => tool.name === 'validate_geckolib_file');
  const advertised = (validateTool?.inputSchema ?? {}) as { properties?: Record<string, unknown> };
  assert.deepEqual(
    Object.keys(advertised.properties ?? {}).sort(),
    ['animation_path', 'geo_path'],
    'validate_geckolib_file must advertise both path parameters in tools/list',
  );

  // Every refined params schema must still advertise its fields; a wrapped
  // (or nested) refinement would otherwise list an empty input schema.
  const setCubeUvTool = tools.tools.find((tool) => tool.name === 'set_cube_uv');
  const setCubeUvAdvertised = (setCubeUvTool?.inputSchema ?? {}) as { properties?: Record<string, unknown> };
  assert.deepEqual(
    Object.keys(setCubeUvAdvertised.properties ?? {}).sort(),
    ['box_uv', 'faces', 'mirror_uv', 'uuid', 'uv_offset'],
    'set_cube_uv must advertise all parameters in tools/list',
  );

  // Passing neither path fails with the structured parameter error, not a
  // transport-level rejection.
  const neitherPath = parseEnvelope(await client.callTool({ name: 'validate_geckolib_file', arguments: {} }));
  assert.equal(neitherPath.ok, false);
  assert.equal(neitherPath.error?.code, 'E_INVALID_PARAMS');

  // Every operation tool must fail fast with the structured precondition error.
  for (const command of COMMAND_NAMES) {
    const started = Date.now();
    const envelope = parseEnvelope(await client.callTool({ name: command, arguments: MINIMAL_ARGS[command] }));
    const elapsed = Date.now() - started;
    assert.equal(envelope.ok, false, `${command} must fail while the plugin is disconnected`);
    assert.equal(envelope.error?.code, 'E_PLUGIN_NOT_CONNECTED', `${command} must report E_PLUGIN_NOT_CONNECTED`);
    assert.ok(elapsed < 1_500, `${command} must fail immediately, not wait or retry (took ${elapsed} ms)`);
    assert.ok(
      !JSON.stringify(envelope).match(/executed|rejected by the plugin/i),
      `${command} must not claim plugin execution`,
    );
  }
});

test('schema-invalid arguments are rejected before the tool handler and never reach the plugin', async (t) => {
  const port = nextPort++;
  const { client, close } = await startClient({ port, secret: SECRET });
  t.after(close);

  // The SDK validates the strict input schema itself and answers with an
  // isError tool result carrying the -32602 invalid-params marker; the tool
  // handler (and therefore any relay to the plugin) never runs.
  const outcome = (await client.callTool({
    name: 'create_project',
    arguments: { format: 'java_block', evil: true },
  })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
  assert.equal(outcome.isError, true);
  assert.match(outcome.content[0].text, /-32602|Input validation error/);
});

test('a malformed config file never leaks its content (or the secret) into health responses or logs', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bbmcp-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'adapter-config.json');
  // Deliberately malformed JSON whose content includes the shared secret.
  writeFileSync(configPath, `{"secret": "${SECRET}"`);

  const port = nextPort++;
  const { client, close, stderrText } = await startClient({ port, secret: SECRET, configPath });
  t.after(close);

  const health = parseEnvelope(await client.callTool({ name: 'health', arguments: {} }));
  const codes = (health.result?.setup_errors as Array<{ code: string }>).map((issue) => issue.code);
  assert.ok(codes.includes('E_INVALID_PARAMS'), 'the malformed config file must surface as a setup issue');

  const everything = JSON.stringify(health) + '\n' + stderrText();
  assert.ok(!everything.includes(SECRET), 'raw secret from the config file leaked');
  assert.ok(!everything.includes(Buffer.from(SECRET, 'utf8').toString('base64')), 'base64 secret leaked');
});

test('port already in use: MCP still serves, health reports E_PORT_IN_USE, tools stay listed', async (t) => {
  const port = nextPort++;
  const blocker: Server = createServer();
  blocker.listen(port, '127.0.0.1');
  await once(blocker, 'listening');
  t.after(() => new Promise<void>((resolve) => blocker.close(() => resolve())));

  const { client, close } = await startClient({ port, secret: SECRET });
  t.after(close);

  const tools = await client.listTools();
  assert.equal(tools.tools.length, COMMAND_NAMES.length + 1);

  const health = parseEnvelope(await client.callTool({ name: 'health', arguments: {} }));
  assert.equal(health.ok, true);
  assert.equal(health.result?.ws_listening, false);
  const codes = (health.result?.setup_errors as Array<{ code: string }>).map((issue) => issue.code);
  assert.ok(codes.includes('E_PORT_IN_USE'));

  const envelope = parseEnvelope(await client.callTool({ name: 'get_project_state', arguments: {} }));
  assert.equal(envelope.error?.code, 'E_PLUGIN_NOT_CONNECTED');
});

test('missing secret: MCP still serves and health reports E_SECRET_MISSING', async (t) => {
  const port = nextPort++;
  const { client, close, stderrText } = await startClient({ port });
  t.after(close);

  const health = parseEnvelope(await client.callTool({ name: 'health', arguments: {} }));
  assert.equal(health.ok, true);
  assert.equal(health.result?.ws_listening, false);
  const codes = (health.result?.setup_errors as Array<{ code: string }>).map((issue) => issue.code);
  assert.ok(codes.includes('E_SECRET_MISSING'));
  assert.ok(stderrText().includes('Config source: no config file'), 'a bare spawn must not resolve any config file');
});

test('with a fake plugin attached: responses are plugin-generated, health shows plugin info, and the secret never leaks into MCP responses', async (t) => {
  const port = nextPort++;
  const { client, close } = await startClient({ port, secret: SECRET });
  t.after(close);

  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(socket, 'open');
  // Every newly authenticated adapter session revokes any scoped directory the
  // plugin still holds and relays nothing until that is acknowledged, so this
  // fake answers revoke_scope the way the shipped plugin does and reports ready
  // only once it has.
  const ack = new Promise<void>((resolve) => {
    let acknowledged = false;
    let revoked = false;
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data));
      if (frame.type === 'hello_ack') acknowledged = true;
      if (frame.type === 'request') {
        if (frame.command === 'revoke_scope') {
          socket.send(JSON.stringify({ type: 'response', id: frame.id, ok: true, result: { state: 'revoked' } }));
          revoked = true;
        } else if (frame.command === 'get_project_state') {
          socket.send(
            JSON.stringify({
              type: 'response',
              id: frame.id,
              ok: true,
              result: { open: true, format: 'java_block', counts: { cubes: 1, groups: 0, textures: 0 } },
            }),
          );
        } else {
          socket.send(
            JSON.stringify({
              type: 'response',
              id: frame.id,
              ok: false,
              error: { code: 'E_SCOPE_NOT_CONFIRMED', message: 'No scoped directory has been confirmed.' },
            }),
          );
        }
      }
      if (acknowledged && revoked) resolve();
    });
  });
  socket.send(
    JSON.stringify({
      type: 'hello',
      protocol_version: PROTOCOL_VERSION,
      secret: SECRET,
      plugin_version: '0.1.0',
      blockbench_version: '5.1.4',
      capabilities: ['java_block'],
    }),
  );
  await ack;
  t.after(() => socket.close());

  const collected: unknown[] = [];

  const health = parseEnvelope(await client.callTool({ name: 'health', arguments: {} }));
  collected.push(health);
  assert.equal(health.result?.plugin_connected, true);
  const plugin = health.result?.plugin as { blockbench_version: string; capabilities: string[] };
  assert.equal(plugin.blockbench_version, '5.1.4');

  const state = parseEnvelope(await client.callTool({ name: 'get_project_state', arguments: {} }));
  collected.push(state);
  assert.equal(state.ok, true);
  assert.deepEqual(state.result, {
    open: true,
    format: 'java_block',
    counts: { cubes: 1, groups: 0, textures: 0 },
  });

  const rejected = parseEnvelope(await client.callTool({ name: 'read_file', arguments: { path: 'a.json' } }));
  collected.push(rejected);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error?.code, 'E_SCOPE_NOT_CONFIRMED', 'plugin rejections must pass through unchanged');

  const everything = JSON.stringify(collected);
  assert.ok(!everything.includes(SECRET), 'raw secret leaked into an MCP response');
  assert.ok(!everything.includes(Buffer.from(SECRET, 'utf8').toString('base64')), 'base64 secret leaked');
  assert.ok(!everything.includes(encodeURIComponent(SECRET)), 'URL-encoded secret leaked');
});

test('plugin result schemas preserve valid results and reject structurally invalid results', async (t) => {
  const port = nextPort++;
  const { client, close } = await startClient({ port, secret: SECRET });
  t.after(close);

  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(socket, 'open');
  // See the note on the other fake: the adapter withholds public commands until
  // this revocation is acknowledged.
  const ack = new Promise<void>((resolve) => {
    let acknowledged = false;
    let revoked = false;
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data));
      if (frame.type === 'hello_ack') acknowledged = true;
      if (frame.type === 'request') {
        if (frame.command === 'revoke_scope') {
          socket.send(JSON.stringify({ type: 'response', id: frame.id, ok: true, result: { state: 'revoked' } }));
          revoked = true;
        } else if (frame.command === 'get_project_state') {
          socket.send(
            JSON.stringify({
              type: 'response',
              id: frame.id,
              ok: true,
              result: { open: true, format: 'java_block', counts: { cubes: 1, groups: 0, textures: 0 } },
            }),
          );
        } else if (frame.command === 'get_plugin_status') {
          socket.send(JSON.stringify({ type: 'response', id: frame.id, ok: true, result: 'not a status object' }));
        }
      }
      if (acknowledged && revoked) resolve();
    });
  });
  socket.send(
    JSON.stringify({
      type: 'hello',
      protocol_version: PROTOCOL_VERSION,
      secret: SECRET,
      plugin_version: '0.1.0',
      blockbench_version: '5.1.4',
      capabilities: ['java_block'],
    }),
  );
  await ack;
  t.after(() => socket.close());

  const valid = parseEnvelope(await client.callTool({ name: 'get_project_state', arguments: {} }));
  assert.equal(valid.ok, true);
  assert.deepEqual(valid, {
    summary: 'get_project_state succeeded.',
    ok: true,
    command: 'get_project_state',
    result: { open: true, format: 'java_block', counts: { cubes: 1, groups: 0, textures: 0 } },
  });

  const invalid = parseEnvelope(await client.callTool({ name: 'get_plugin_status', arguments: {} }));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.command, 'get_plugin_status');
  assert.equal(invalid.error?.code, 'E_PROTOCOL_MISMATCH');
  assert.match(invalid.error?.message ?? '', /get_plugin_status.*result.*protocol result schema/i);
  assert.ok(Array.isArray(invalid.error?.details));
});

// ---------------------------------------------------------------------------
// Direct-mode regression behaviour, on both MCP wire eras
// ---------------------------------------------------------------------------

/** Connect to the adapter's plugin listener, retrying while it is still binding. */
async function openPluginSocket(port: number, timeoutMs = 10_000): Promise<WebSocket> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const opened = await new Promise<boolean>((resolve) => {
      socket.once('open', () => resolve(true));
      socket.once('error', () => resolve(false));
    });
    if (opened) return socket;
    socket.terminate();
    if (Date.now() >= deadline) throw new Error(`Timed out connecting to the plugin listener on port ${port}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A Blockbench stand-in that authenticates and can be told to stay silent. */
async function attachSilentPlugin(port: number, options: { answer: boolean }): Promise<WebSocket> {
  // The MCP handshake can complete a moment before the WebSocket listener has
  // finished binding, so the plugin retries rather than racing it.
  const socket = await openPluginSocket(port);
  const ready = new Promise<void>((resolve) => {
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data)) as { type?: string; id?: string; command?: string };
      if (frame.type !== 'request') return;
      if (frame.command === 'revoke_scope') {
        socket.send(JSON.stringify({ type: 'response', id: frame.id, ok: true, result: { state: 'revoked' } }));
        resolve();
        return;
      }
      // Every other command is deliberately left unanswered when `answer` is
      // false, which is what makes the adapter's own request timeout the thing
      // under test.
      if (!options.answer) return;
      socket.send(
        JSON.stringify({
          type: 'response',
          id: frame.id,
          ok: true,
          result: { open: true, format: 'java_block', counts: { cubes: 1, groups: 0, textures: 0 } },
        }),
      );
    });
  });
  socket.send(
    JSON.stringify({
      type: 'hello',
      protocol_version: PROTOCOL_VERSION,
      secret: SECRET,
      plugin_version: '0.1.0',
      blockbench_version: '5.1.4',
      capabilities: ['java_block'],
    }),
  );
  await ready;
  return socket;
}

async function waitUntil(predicate: () => boolean, description: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Every direct-mode failure the migration contract requires to be unchanged,
 * observed on one wire era: a listener that could not bind, a request the
 * plugin never answers, and a plugin frame past the size limit.
 *
 * Returned as plain data so the two eras can be compared against each other
 * rather than against two separately written expectations.
 */
async function observeDirectRegressions(
  t: import('node:test').TestContext,
  era: WireEra,
): Promise<Record<string, unknown>> {
  // Listener/setup failure: something else already holds the port.
  const blockedPort = nextPort++;
  const blocker: Server = createServer();
  blocker.listen(blockedPort, '127.0.0.1');
  await once(blocker, 'listening');
  t.after(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
  const blocked = await startClient({ port: blockedPort, secret: SECRET, era });
  t.after(blocked.close);
  const blockedHealth = parseEnvelope(await blocked.client.callTool({ name: 'health', arguments: {} }));
  const listenerFailure = {
    healthOk: blockedHealth.ok,
    wsListening: blockedHealth.result?.ws_listening,
    setupErrorCodes: (blockedHealth.result?.setup_errors as Array<{ code: string }>).map((issue) => issue.code),
    toolCount: (await blocked.client.listTools()).tools.length,
    relayCode: parseEnvelope(await blocked.client.callTool({ name: 'get_project_state', arguments: {} })).error?.code,
  };

  // Timeout: the plugin is attached and simply never answers.
  const timeoutPort = nextPort++;
  const timeoutClient = await startClient({ port: timeoutPort, secret: SECRET, era, requestTimeoutMs: 1_000 });
  t.after(timeoutClient.close);
  const silent = await attachSilentPlugin(timeoutPort, { answer: false });
  t.after(() => silent.close());
  const timedOut = parseEnvelope(await timeoutClient.client.callTool({ name: 'get_project_state', arguments: {} }));
  const timeout = { ok: timedOut.ok, code: timedOut.error?.code, command: timedOut.command };

  // Size limit: the plugin sends a frame larger than the configured maximum,
  // which closes its session and leaves the adapter with no plugin.
  const sizePort = nextPort++;
  const sizeClient = await startClient({
    port: sizePort,
    secret: SECRET,
    era,
    requestTimeoutMs: 1_000,
    maxMessageBytes: 2_048,
  });
  t.after(sizeClient.close);
  const chatty = await attachSilentPlugin(sizePort, { answer: true });
  t.after(() => chatty.close());
  // Positive control before the oversize frame: this plugin does serve commands.
  const beforeOversize = parseEnvelope(
    await sizeClient.client.callTool({ name: 'get_project_state', arguments: {} }),
  );
  let closeCode: number | null = null;
  chatty.on('close', (code) => (closeCode = code));
  chatty.send(JSON.stringify({ type: 'event', event: 'noise', data: 'x'.repeat(10_000) }));
  await waitUntil(() => closeCode !== null, `${era}: the oversized plugin frame to close the session`);
  const afterOversize = parseEnvelope(await sizeClient.client.callTool({ name: 'get_project_state', arguments: {} }));
  const sizeLimit = {
    beforeOk: beforeOversize.ok,
    closeCode,
    afterOk: afterOversize.ok,
    afterCode: afterOversize.error?.code,
  };

  return { listenerFailure, timeout, sizeLimit };
}

test('direct-mode listener failure, request timeout, and plugin frame size limits behave identically on a 2026-07-28 connection and a 2025-era one', async (t) => {
  const observed: Partial<Record<WireEra, Record<string, unknown>>> = {};
  for (const era of ERAS) observed[era] = await observeDirectRegressions(t, era);

  // Each era observed the real behaviour, not an empty run.
  for (const era of ERAS) {
    const listener = observed[era]?.listenerFailure as Record<string, unknown>;
    assert.equal(listener.healthOk, true, `${era}: health failed instead of reporting the listener failure`);
    assert.equal(listener.wsListening, false, `${era}: the listener bound a port that was already taken`);
    assert.deepEqual(listener.setupErrorCodes, ['E_PORT_IN_USE'], `${era}: the listener failure changed shape`);
    assert.equal(listener.toolCount, COMMAND_NAMES.length + 1, `${era}: the catalogue shrank on a failed listener`);
    assert.equal(listener.relayCode, 'E_PLUGIN_NOT_CONNECTED', `${era}: a relay with no listener changed its code`);

    const timeout = observed[era]?.timeout as Record<string, unknown>;
    assert.equal(timeout.ok, false, `${era}: an unanswered command reported success`);
    assert.equal(timeout.code, 'E_TIMEOUT', `${era}: an unanswered command did not time out`);

    const sizeLimit = observed[era]?.sizeLimit as Record<string, unknown>;
    assert.equal(sizeLimit.beforeOk, true, `${era}: the plugin was not serving before the oversized frame`);
    assert.equal(sizeLimit.closeCode, 1009, `${era}: an oversized plugin frame did not close the session with 1009`);
    assert.equal(sizeLimit.afterOk, false, `${era}: a command succeeded after the plugin session was closed`);
    assert.equal(sizeLimit.afterCode, 'E_PLUGIN_NOT_CONNECTED', `${era}: the post-oversize code changed`);
  }

  // And the two eras agree with each other, member for member.
  assert.deepEqual(
    observed.modern,
    observed.legacy,
    'direct-mode listener, timeout, or size-limit behaviour differs between the two MCP wire eras',
  );
});
