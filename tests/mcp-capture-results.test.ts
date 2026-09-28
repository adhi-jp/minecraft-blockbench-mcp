import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import { CONFIG_DEFAULTS } from '../src/adapter/config.js';
import { buildMcpServer, toToolResult } from '../src/adapter/mcp-server.js';
import { WsBridge, type BridgeRequestResult } from '../src/adapter/ws-bridge.js';
import { COMMAND_SPECS } from '../src/shared/protocol.js';
import { WireFakePlugin } from './helpers/wire-plugin.js';

const metadata = {
  width: 320,
  height: 240,
  angle_preset: 'top',
  project: { uuid: 'project-wire', name: 'ghost' },
  counts: { cubes: 7, groups: 2, textures: 1 },
};
const base64 = 'iVBORw0KGgo=';
const inline = { ...metadata, data_url: `data:image/png;base64,${base64}` };
const animation = { animation: 'animation.ghost.idle', time: 1.25, rendered_time: 1.25 };
type Response = ReturnType<typeof toToolResult>;
let nextPort = 43_950;

function textEnvelope(response: Response): Record<string, any> {
  assert.equal(response.content[0].type, 'text');
  if (response.content[0].type !== 'text') throw new Error('Missing text envelope');
  return JSON.parse(response.content[0].text);
}

async function wireCapture(command: string, answer: BridgeRequestResult): Promise<Response> {
  const port = nextPort++;
  const secret = 'capture-results-wire-secret';
  const bridge = new WsBridge({
    port, secret, requestTimeoutMs: 2_000, heartbeatIntervalMs: 200,
    heartbeatMissLimit: 3, handshakeTimeoutMs: 1_000, maxMessageBytes: 4 * 1024 * 1024, log: () => {},
  });
  const plugin = new WireFakePlugin({ port, secret, hold: [command] });
  const server = buildMcpServer({ bridge, config: { ...CONFIG_DEFAULTS, port }, setupIssues: [], mode: 'direct' });
  const client = new Client({ name: 'capture-results-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    assert.deepEqual(await bridge.start(), { ok: true });
    await plugin.connect();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = client.callTool({
      name: command,
      arguments: {
        ...(command === 'capture_geckolib_animation_frame' ? { animation: animation.animation, time: animation.time } : {}),
        ...(answer.ok && typeof answer.result === 'object' && answer.result !== null && 'path' in answer.result
          ? { output_path: answer.result.path } : {}),
      },
    });
    const deadline = Date.now() + 2_000;
    while (plugin.heldRequests(command).length === 0) {
      if (Date.now() > deadline) throw new Error('Capture was not relayed');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    plugin.answer(plugin.heldRequests(command)[0], answer.ok
      ? { ok: true, result: answer.result }
      : { ok: false, error: answer.error });
    return await response as Response;
  } finally {
    await client.close();
    await server.close();
    await plugin.disconnect();
    await bridge.stop();
  }
}

function assertInline(response: Response, expected: Record<string, unknown>): void {
  assert.equal(response.isError, undefined);
  assert.equal(response.content.length, 2);
  assert.equal(response.content.filter((block) => block.type === 'image').length, 1);
  assert.deepEqual(response.content[1], { type: 'image', data: base64, mimeType: 'image/png' });
  const envelope = textEnvelope(response);
  assert.equal(envelope.ok, true);
  assert.equal('data_url' in envelope.result, false);
  assert.deepEqual(envelope.result, expected);
  assert.equal(JSON.stringify(envelope).includes(base64), false);
}

test('capture result conversion separates the image from JSON without mutating the plugin result', () => {
  const envelope = { summary: 'capture_screenshot succeeded.', ok: true, command: 'capture_screenshot', result: inline };
  assertInline(toToolResult(envelope), metadata);
  assert.equal(envelope.result.data_url, inline.data_url);
  const ordinary = { ...envelope, command: 'another_tool' };
  assert.deepEqual(toToolResult(ordinary), { content: [{ type: 'text', text: JSON.stringify(ordinary, null, 2) }] });
  const fileEnvelope = { ...envelope, result: { ...metadata, path: '/confirmed/render.png', bytes: 8 } };
  assert.deepEqual(toToolResult(fileEnvelope), { content: [{ type: 'text', text: JSON.stringify(fileEnvelope, null, 2) }] });
  const failure = { ...envelope, ok: false, error: { code: 'E_FILE_EXISTS' as const, message: 'Destination exists.' } };
  assert.deepEqual(toToolResult(failure), { content: [{ type: 'text', text: JSON.stringify(failure, null, 2) }], isError: true });
});

test('screenshot wire responses contain one PNG image and project metadata without a data URL in text', async () => {
  assertInline(await wireCapture('capture_screenshot', { ok: true, result: inline }), metadata);
});

test('animation frame wire responses retain animation metadata alongside one PNG image', async () => {
  assertInline(await wireCapture('capture_geckolib_animation_frame', { ok: true, result: { ...inline, ...animation } }), { ...metadata, ...animation });
});

test('file capture wire responses contain only metadata and no image or base64', async () => {
  const result = { ...metadata, path: '/confirmed/render.png', bytes: 8 };
  const response = await wireCapture('capture_screenshot', { ok: true, result });
  assert.equal(response.content.length, 1);
  assert.equal(response.content.some((block) => block.type === 'image'), false);
  assert.equal(response.isError, undefined);
  assert.deepEqual(textEnvelope(response).result, result);
  assert.equal('data_url' in textEnvelope(response).result, false);
  assert.equal(JSON.stringify(response.content).includes(base64), false);
  assert.equal(JSON.stringify(response.content).includes('base64'), false);
});

test('capture wire errors retain the single text error envelope', async () => {
  const error = { code: 'E_FILE_EXISTS' as const, message: 'Destination exists.', details: { path: '/confirmed/render.png' } };
  const response = await wireCapture('capture_screenshot', { ok: false, error });
  assert.deepEqual(response, {
    content: [{ type: 'text', text: JSON.stringify({ summary: 'capture_screenshot failed: E_FILE_EXISTS.', ok: false, command: 'capture_screenshot', error }, null, 2) }],
    isError: true,
  });
});

test('capture schemas accept either output variant and reject mixed outputs or missing identity', () => {
  for (const command of ['capture_screenshot', 'capture_geckolib_animation_frame'] as const) {
    const extra = command === 'capture_screenshot' ? {} : animation;
    const result = { ...metadata, ...extra, path: '/confirmed/render.png', bytes: 8 };
    const schema = COMMAND_SPECS[command].result;
    assert.equal(schema.safeParse({ ...inline, ...extra }).success, true);
    assert.equal(schema.safeParse(result).success, true);
    assert.equal(schema.safeParse({ ...result, data_url: inline.data_url }).success, false);
    const { project, ...withoutProject } = result;
    assert.equal(schema.safeParse(withoutProject).success, false);
    const { counts, ...withoutCounts } = result;
    assert.equal(schema.safeParse(withoutCounts).success, false);
    const params = COMMAND_SPECS[command].params;
    const args = command === 'capture_screenshot' ? {} : { animation: animation.animation, time: 0 };
    assert.equal(params.safeParse({ ...args, overwrite: true }).success, false);
    assert.equal(params.safeParse({ ...args, overwrite: false }).success, false);
    assert.equal(params.safeParse({ ...args, output_path: 'render.png', overwrite: true }).success, true);
  }
});
