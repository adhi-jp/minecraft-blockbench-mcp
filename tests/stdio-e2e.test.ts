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

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import WebSocket from 'ws';

import { COMMAND_NAMES, PROTOCOL_VERSION, type CommandName } from '../src/shared/protocol.js';

const SECRET = 'e2e-secret-xyz789';
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(projectRoot, 'dist', 'adapter', 'cli.js');
let nextPort = 40200;

async function startClient(options: {
  port: number;
  secret?: string | undefined;
  configPath?: string | undefined;
}): Promise<{ client: Client; close: () => Promise<void>; stderrText: () => string }> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.BLOCKBENCH_MCP_SECRET;
  delete env.BLOCKBENCH_MCP_CONFIG;
  if (options.secret !== undefined) env.BLOCKBENCH_MCP_SECRET = options.secret;
  if (options.configPath !== undefined) env.BLOCKBENCH_MCP_CONFIG = options.configPath;
  env.BLOCKBENCH_MCP_PORT = String(options.port);
  // Keep test timing fast; these are the same knobs users can configure.
  env.BLOCKBENCH_MCP_REQUEST_TIMEOUT_MS = '2000';

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath],
    env,
    cwd: projectRoot,
    stderr: 'pipe',
  });
  const stderrChunks: string[] = [];
  const client = new Client({ name: 'stdio-e2e-test', version: '0.0.0' });
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
  create_cubes: { cubes: [{ from: [0, 0, 0], to: [1, 1, 1] }] },
  update_cube: { uuid: 'u-1', set: { name: 'renamed' } },
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
  capture_screenshot: {},
  validate_project: {},
  propose_scoped_directory: { path: '/tmp/blockbench-mcp-e2e' },
  create_project: { format: 'java_block' },
  open_model: { path: 'model.json' },
  set_display_transform: { slot: 'gui', scale: [1, 1, 1] },
  export_model: { path: 'out/model.json' },
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
  const { client, close } = await startClient({ port });
  t.after(close);

  const health = parseEnvelope(await client.callTool({ name: 'health', arguments: {} }));
  assert.equal(health.ok, true);
  assert.equal(health.result?.ws_listening, false);
  const codes = (health.result?.setup_errors as Array<{ code: string }>).map((issue) => issue.code);
  assert.ok(codes.includes('E_SECRET_MISSING'));
});

test('with a fake plugin attached: responses are plugin-generated, health shows plugin info, and the secret never leaks into MCP responses', async (t) => {
  const port = nextPort++;
  const { client, close } = await startClient({ port, secret: SECRET });
  t.after(close);

  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(socket, 'open');
  const ack = new Promise<void>((resolve) => {
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data));
      if (frame.type === 'hello_ack') resolve();
      if (frame.type === 'request') {
        if (frame.command === 'get_project_state') {
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
