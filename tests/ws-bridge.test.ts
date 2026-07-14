import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import WebSocket from 'ws';

import { WsBridge, CLOSE_CODES } from '../src/adapter/ws-bridge.js';
import { PROTOCOL_VERSION } from '../src/shared/protocol.js';

const SECRET = 'test-secret-abc123';
let nextPort = 40100;

interface BridgeHarness {
  bridge: WsBridge;
  port: number;
  logs: string[];
}

async function startBridge(
  overrides: Partial<ConstructorParameters<typeof WsBridge>[0]> = {},
): Promise<BridgeHarness> {
  const port = nextPort++;
  const logs: string[] = [];
  const bridge = new WsBridge({
    port,
    secret: SECRET,
    requestTimeoutMs: 500,
    heartbeatIntervalMs: 30,
    heartbeatMissLimit: 2,
    handshakeTimeoutMs: 200,
    maxMessageBytes: 64 * 1024,
    log: (line) => logs.push(line),
    ...overrides,
  });
  const started = await bridge.start();
  assert.deepEqual(started, { ok: true });
  return { bridge, port, logs };
}

function helloFrame(secret: string = SECRET, protocolVersion: number = PROTOCOL_VERSION): string {
  return JSON.stringify({
    type: 'hello',
    protocol_version: protocolVersion,
    secret,
    plugin_version: '0.1.0',
    blockbench_version: '5.1.4',
    capabilities: ['java_block'],
  });
}

/** Connect and authenticate a fake plugin; resolves after hello_ack. */
async function connectAuthenticated(port: number): Promise<{ socket: WebSocket; frames: unknown[] }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames: unknown[] = [];
  await once(socket, 'open');
  const ackPromise = new Promise<void>((resolve) => {
    socket.on('message', (data) => {
      const parsed = JSON.parse(String(data));
      frames.push(parsed);
      if (parsed.type === 'hello_ack') resolve();
    });
  });
  socket.send(helloFrame());
  await ackPromise;
  return { socket, frames };
}

function closeInfo(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.on('close', (code, reason) => resolve({ code, reason: String(reason) }));
  });
}

test('missing secret configuration prevents the listener from starting with E_SECRET_MISSING', async () => {
  const bridge = new WsBridge({
    port: nextPort++,
    secret: null,
    requestTimeoutMs: 100,
    heartbeatIntervalMs: 50,
    heartbeatMissLimit: 2,
    handshakeTimeoutMs: 100,
    maxMessageBytes: 1024,
    log: () => {},
  });
  const started = await bridge.start();
  assert.equal(started.ok, false);
  if (!started.ok) assert.equal(started.issue.code, 'E_SECRET_MISSING');
  assert.equal(bridge.listening, false);
  await bridge.stop();
});

test('port conflicts are reported as E_PORT_IN_USE without throwing', async (t) => {
  const first = await startBridge();
  t.after(() => first.bridge.stop());
  const second = new WsBridge({
    port: first.port,
    secret: SECRET,
    requestTimeoutMs: 100,
    heartbeatIntervalMs: 50,
    heartbeatMissLimit: 2,
    handshakeTimeoutMs: 100,
    maxMessageBytes: 1024,
    log: () => {},
  });
  const started = await second.start();
  assert.equal(started.ok, false);
  if (!started.ok) assert.equal(started.issue.code, 'E_PORT_IN_USE');
  await second.stop();
});

test('a valid hello authenticates, receives hello_ack with capabilities, and takes the session lock', async (t) => {
  const { bridge, port } = await startBridge();
  t.after(() => bridge.stop());
  const { socket, frames } = await connectAuthenticated(port);
  t.after(() => socket.close());

  assert.equal(bridge.connected, true);
  const ack = frames.find((f): f is Record<string, unknown> => (f as { type?: string }).type === 'hello_ack');
  assert.ok(ack);
  assert.equal(ack.protocol_version, PROTOCOL_VERSION);
  assert.deepEqual(ack.capabilities, ['java_block', 'geckolib_model']);
  assert.deepEqual(bridge.pluginInfo?.capabilities, ['java_block']);
});

test('a wrong secret is rejected with the auth close code and does not take the lock', async (t) => {
  const { bridge, port, logs } = await startBridge();
  t.after(() => bridge.stop());
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(socket, 'open');
  const closed = closeInfo(socket);
  socket.send(helloFrame('wrong-secret'));
  const info = await closed;
  assert.equal(info.code, CLOSE_CODES.authFailed);
  assert.equal(bridge.connected, false);
  assert.ok(!logs.join('\n').includes(SECRET), 'logs must not contain the shared secret');
});

test('a hello without a secret is rejected as an invalid handshake', async (t) => {
  const { bridge, port } = await startBridge();
  t.after(() => bridge.stop());
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(socket, 'open');
  const closed = closeInfo(socket);
  socket.send(helloFrame(''));
  const info = await closed;
  assert.equal(info.code, CLOSE_CODES.invalidHandshake, 'an empty secret fails the schema, not just the comparison');
  assert.equal(bridge.connected, false);
});

test('a protocol version mismatch is rejected with a version close code', async (t) => {
  const { bridge, port } = await startBridge();
  t.after(() => bridge.stop());
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(socket, 'open');
  const closed = closeInfo(socket);
  socket.send(helloFrame(SECRET, PROTOCOL_VERSION + 1));
  const info = await closed;
  assert.equal(info.code, CLOSE_CODES.protocolMismatch);
  assert.equal(bridge.connected, false);
});

test('a pre-auth operation frame is dropped with the handshake close code', async (t) => {
  const { bridge, port } = await startBridge();
  t.after(() => bridge.stop());
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(socket, 'open');
  const closed = closeInfo(socket);
  socket.send(JSON.stringify({ type: 'response', id: 'sneaky', ok: true, result: {} }));
  const info = await closed;
  assert.equal(info.code, CLOSE_CODES.invalidHandshake);
  assert.equal(bridge.connected, false);
});

test('a silent socket is closed when the handshake window expires', async (t) => {
  const { bridge, port } = await startBridge({ handshakeTimeoutMs: 60 });
  t.after(() => bridge.stop());
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(socket, 'open');
  const info = await closeInfo(socket);
  assert.equal(info.code, CLOSE_CODES.handshakeTimeout);
  assert.equal(bridge.connected, false);
});

test('a second authenticated session is rejected without disrupting the first', async (t) => {
  const { bridge, port } = await startBridge();
  t.after(() => bridge.stop());
  const first = await connectAuthenticated(port);
  t.after(() => first.socket.close());

  const second = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(second, 'open');
  const closed = closeInfo(second);
  second.send(helloFrame());
  const info = await closed;
  assert.equal(info.code, CLOSE_CODES.sessionExists);
  assert.equal(bridge.connected, true, 'the first session must stay active');
  assert.equal(first.socket.readyState, WebSocket.OPEN);
});

test('closing the active session releases the lock so a new session can authenticate', async (t) => {
  const { bridge, port } = await startBridge();
  t.after(() => bridge.stop());
  const first = await connectAuthenticated(port);
  first.socket.close();
  await once(first.socket, 'close');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(bridge.connected, false);

  const second = await connectAuthenticated(port);
  t.after(() => second.socket.close());
  assert.equal(bridge.connected, true);
});

test('a session that never answers heartbeat pings goes stale and releases the lock', async (t) => {
  const { bridge, port } = await startBridge({ heartbeatIntervalMs: 25, heartbeatMissLimit: 2 });
  t.after(() => bridge.stop());
  // autoPong:false simulates a hung renderer that no longer answers pings.
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { autoPong: false });
  await once(socket, 'open');
  const ack = new Promise<void>((resolve) => {
    socket.on('message', (data) => {
      if (JSON.parse(String(data)).type === 'hello_ack') resolve();
    });
  });
  socket.send(helloFrame());
  await ack;
  assert.equal(bridge.connected, true);

  await new Promise((resolve) => setTimeout(resolve, 25 * 5));
  assert.equal(bridge.connected, false, 'stale session must release the single-active-plugin lock');
});

test('requests are relayed to the plugin and responses return unchanged', async (t) => {
  const { bridge, port } = await startBridge();
  t.after(() => bridge.stop());
  const { socket } = await connectAuthenticated(port);
  t.after(() => socket.close());

  socket.on('message', (data) => {
    const frame = JSON.parse(String(data));
    if (frame.type === 'request' && frame.command === 'get_project_state') {
      socket.send(
        JSON.stringify({
          type: 'response',
          id: frame.id,
          ok: true,
          result: { open: true, format: 'java_block', counts: { cubes: 2, groups: 1, textures: 0 } },
        }),
      );
    }
  });

  const outcome = await bridge.request('get_project_state', {});
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.result, {
    open: true,
    format: 'java_block',
    counts: { cubes: 2, groups: 1, textures: 0 },
  });
});

test('plugin-generated rejections pass through with their error codes', async (t) => {
  const { bridge, port } = await startBridge();
  t.after(() => bridge.stop());
  const { socket } = await connectAuthenticated(port);
  t.after(() => socket.close());

  socket.on('message', (data) => {
    const frame = JSON.parse(String(data));
    if (frame.type === 'request') {
      socket.send(
        JSON.stringify({
          type: 'response',
          id: frame.id,
          ok: false,
          error: { code: 'E_SCOPE_NOT_CONFIRMED', message: 'No scoped directory has been confirmed.' },
        }),
      );
    }
  });

  const outcome = await bridge.request('read_file', { path: 'a.json' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_SCOPE_NOT_CONFIRMED');
});

test('an unanswered request times out with E_TIMEOUT', async (t) => {
  const { bridge, port } = await startBridge({ requestTimeoutMs: 60 });
  t.after(() => bridge.stop());
  const { socket } = await connectAuthenticated(port);
  t.after(() => socket.close());

  const outcome = await bridge.request('validate_project', {});
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_TIMEOUT');
});

test('responses with stale correlation ids are ignored', async (t) => {
  const { bridge, port } = await startBridge();
  t.after(() => bridge.stop());
  const { socket } = await connectAuthenticated(port);
  t.after(() => socket.close());

  socket.send(JSON.stringify({ type: 'response', id: 'never-issued', ok: true, result: {} }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(bridge.connected, true, 'a stale response must not break the session');
});

test('stop terminates a silent unauthenticated socket without waiting for its handshake deadline', async () => {
  const { bridge, port } = await startBridge({ handshakeTimeoutMs: 5_000 });
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(socket, 'open');
  const closed = once(socket, 'close');
  const started = Date.now();
  await bridge.stop();
  await closed;
  assert.ok(Date.now() - started < 500, 'shutdown should not wait for the handshake timeout');
  assert.equal(socket.readyState, WebSocket.CLOSED);
});

test('requests without a connected plugin fail immediately with E_PLUGIN_NOT_CONNECTED', async (t) => {
  const { bridge } = await startBridge();
  t.after(() => bridge.stop());
  const outcome = await bridge.request('get_project_state', {});
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_PLUGIN_NOT_CONNECTED');
});

test('disconnect while a request is in flight resolves it with E_PLUGIN_NOT_CONNECTED', async (t) => {
  const { bridge, port } = await startBridge({ requestTimeoutMs: 5_000 });
  t.after(() => bridge.stop());
  const { socket } = await connectAuthenticated(port);

  const pending = bridge.request('get_project_state', {});
  socket.terminate();
  const outcome = await pending;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_PLUGIN_NOT_CONNECTED');
});

test('scope_changed events update the cached plugin scope status', async (t) => {
  const { bridge, port } = await startBridge();
  t.after(() => bridge.stop());
  const { socket } = await connectAuthenticated(port);
  t.after(() => socket.close());

  socket.send(
    JSON.stringify({
      type: 'event',
      event: 'scope_changed',
      data: { state: 'confirmed', normalized_path: '/home/user/models' },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(bridge.pluginInfo?.scope, { state: 'confirmed', normalized_path: '/home/user/models' });
});

test('oversized frames close the session without crashing the bridge', async (t) => {
  const { bridge, port } = await startBridge({ maxMessageBytes: 2_048 });
  t.after(() => bridge.stop());
  const { socket } = await connectAuthenticated(port);
  const closed = closeInfo(socket);

  socket.send(JSON.stringify({ type: 'event', event: 'noise', data: 'x'.repeat(10_000) }));
  const info = await closed;
  assert.equal(info.code, 1009, 'ws closes oversized-frame sessions with 1009 (message too big)');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(bridge.connected, false);
});

test('no frame sent by the bridge ever contains the shared secret in raw or encoded form', async (t) => {
  const { bridge, port, logs } = await startBridge();
  t.after(() => bridge.stop());
  const { socket, frames } = await connectAuthenticated(port);
  t.after(() => socket.close());

  socket.on('message', (data) => {
    const frame = JSON.parse(String(data));
    frames.push(frame);
    if (frame.type === 'request') {
      socket.send(JSON.stringify({ type: 'response', id: frame.id, ok: true, result: { echoed: true } }));
    }
  });
  await bridge.request('get_plugin_status', {});

  // Also capture the close reason handed to a rejected connection attempt.
  const rejectedSocket = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(rejectedSocket, 'open');
  const rejectedClose = closeInfo(rejectedSocket);
  rejectedSocket.send(helloFrame('wrong-secret'));
  const rejectedInfo = await rejectedClose;

  const everything = JSON.stringify(frames) + '\n' + logs.join('\n') + '\n' + JSON.stringify(rejectedInfo);
  assert.ok(!everything.includes(SECRET), 'raw secret leaked');
  assert.ok(!everything.includes(Buffer.from(SECRET, 'utf8').toString('base64')), 'base64 secret leaked');
  assert.ok(!everything.includes(encodeURIComponent(SECRET)), 'URL-encoded secret leaked');
});
