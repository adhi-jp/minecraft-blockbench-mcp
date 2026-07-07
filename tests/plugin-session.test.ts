// Integration tests for the plugin session core: the real adapter-side
// WsBridge on one end, the PluginSession (with an injected `ws` WebSocket)
// on the other — the same protocol path the Blockbench renderer uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import WsClient from 'ws';

import { WsBridge } from '../src/adapter/ws-bridge.js';
import { PluginSession, CommandError, type WebSocketLike, type SessionStatus } from '../src/plugin/session.js';

const SECRET = 'session-secret-q1w2e3';
let nextPort = 40400;

function makeBridge(port: number, overrides: Partial<ConstructorParameters<typeof WsBridge>[0]> = {}): WsBridge {
  return new WsBridge({
    port,
    secret: SECRET,
    requestTimeoutMs: 1_000,
    heartbeatIntervalMs: 100,
    heartbeatMissLimit: 3,
    handshakeTimeoutMs: 500,
    maxMessageBytes: 1024 * 1024,
    log: () => {},
    ...overrides,
  });
}

function makeSession(
  port: number,
  overrides: Partial<ConstructorParameters<typeof PluginSession>[0]> = {},
): { session: PluginSession; statuses: SessionStatus[] } {
  const statuses: SessionStatus[] = [];
  const session = new PluginSession({
    createWebSocket: (url) => new WsClient(url) as unknown as WebSocketLike,
    url: () => `ws://127.0.0.1:${port}`,
    secret: () => SECRET,
    pluginVersion: '0.1.0',
    blockbenchVersion: () => '5.1.4',
    capabilities: ['java_block'],
    backoffInitialMs: 50,
    backoffMaxMs: 200,
    onStatusChange: (status) => statuses.push(status),
    ...overrides,
  });
  return { session, statuses };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('the session connects, authenticates, and reports connected on both ends', async (t) => {
  const port = nextPort++;
  const bridge = makeBridge(port);
  assert.deepEqual(await bridge.start(), { ok: true });
  t.after(() => bridge.stop());

  const { session } = makeSession(port);
  t.after(() => session.stop());
  session.start();

  await waitFor(() => session.status === 'connected' && bridge.connected);
  assert.equal(bridge.pluginInfo?.blockbench_version, '5.1.4');
});

test('registered handlers answer relayed requests; results pass through the bridge unchanged', async (t) => {
  const port = nextPort++;
  const bridge = makeBridge(port);
  await bridge.start();
  t.after(() => bridge.stop());

  const { session } = makeSession(port);
  t.after(() => session.stop());
  session.registerHandler('get_plugin_status', () => ({
    plugin_version: '0.1.0',
    scope: { state: 'unconfirmed' },
  }));
  session.start();
  await waitFor(() => session.status === 'connected');

  const outcome = await bridge.request('get_plugin_status', {});
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.result, { plugin_version: '0.1.0', scope: { state: 'unconfirmed' } });
});

test('unknown commands produce a structured E_UNSUPPORTED_COMMAND rejection', async (t) => {
  const port = nextPort++;
  const bridge = makeBridge(port);
  await bridge.start();
  t.after(() => bridge.stop());

  const { session } = makeSession(port);
  t.after(() => session.stop());
  session.start();
  await waitFor(() => session.status === 'connected');

  const outcome = await bridge.request('does_not_exist', {});
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_UNSUPPORTED_COMMAND');
});

test('CommandError from a handler keeps its machine-readable code and details', async (t) => {
  const port = nextPort++;
  const bridge = makeBridge(port);
  await bridge.start();
  t.after(() => bridge.stop());

  const { session } = makeSession(port);
  t.after(() => session.stop());
  session.registerHandler('read_file', () => {
    throw new CommandError('E_SCOPE_NOT_CONFIRMED', 'No scoped directory confirmed.', { hint: 'propose first' });
  });
  session.start();
  await waitFor(() => session.status === 'connected');

  const outcome = await bridge.request('read_file', { path: 'x.json' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_SCOPE_NOT_CONFIRMED');
  assert.deepEqual(outcome.error?.details, { hint: 'propose first' });
});

test('unexpected handler exceptions become E_BLOCKBENCH_ERROR without killing the session', async (t) => {
  const port = nextPort++;
  const bridge = makeBridge(port);
  await bridge.start();
  t.after(() => bridge.stop());

  const { session } = makeSession(port);
  t.after(() => session.stop());
  session.registerHandler('validate_project', () => {
    throw new Error('unexpected internal failure');
  });
  session.start();
  await waitFor(() => session.status === 'connected');

  const outcome = await bridge.request('validate_project', {});
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_BLOCKBENCH_ERROR');
  assert.equal(session.status, 'connected', 'a handler failure must not disconnect the session');
});

test('the session reconnects with backoff after the adapter restarts', async (t) => {
  const port = nextPort++;
  let bridge = makeBridge(port);
  await bridge.start();

  const { session } = makeSession(port);
  t.after(() => session.stop());
  session.start();
  await waitFor(() => session.status === 'connected');

  await bridge.stop();
  await waitFor(() => session.status !== 'connected');

  bridge = makeBridge(port);
  await bridge.start();
  t.after(() => bridge.stop());

  await waitFor(() => session.status === 'connected' && bridge.connected, 5_000);
});

test('stop() closes cleanly and disables reconnection', async (t) => {
  const port = nextPort++;
  const bridge = makeBridge(port);
  await bridge.start();
  t.after(() => bridge.stop());

  const { session } = makeSession(port);
  session.start();
  await waitFor(() => session.status === 'connected');

  session.stop();
  assert.equal(session.status, 'stopped');
  await waitFor(() => !bridge.connected);

  // Wait past several backoff windows: the session must not come back.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(bridge.connected, false, 'a stopped session must not reconnect');
  assert.equal(session.status, 'stopped');
});

test('a wrong secret surfaces as auth_failed status', async (t) => {
  const port = nextPort++;
  const bridge = makeBridge(port);
  await bridge.start();
  t.after(() => bridge.stop());

  const { session, statuses } = makeSession(port, { secret: () => 'wrong-secret' });
  t.after(() => session.stop());
  session.start();

  await waitFor(() => statuses.includes('auth_failed'));
  assert.equal(bridge.connected, false);
});

test('an empty secret never attempts a connection and reports auth_failed', async (t) => {
  const port = nextPort++;
  const bridge = makeBridge(port);
  await bridge.start();
  t.after(() => bridge.stop());

  const { session, statuses } = makeSession(port, { secret: () => '' });
  t.after(() => session.stop());
  session.start();

  await waitFor(() => statuses.includes('auth_failed'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(bridge.connected, false);
});

test('reconnectNow connects promptly after a secret becomes available', async (t) => {
  const port = nextPort++;
  const bridge = makeBridge(port);
  await bridge.start();
  t.after(() => bridge.stop());

  let secret = '';
  const { session, statuses } = makeSession(port, { secret: () => secret });
  t.after(() => session.stop());
  session.start();
  // First attempt sees no secret and backs off (max backoff).
  await waitFor(() => statuses.includes('auth_failed'));
  assert.equal(bridge.connected, false);

  // Simulate the user entering the secret and the onChange hook firing.
  secret = SECRET;
  session.reconnectNow();
  await waitFor(() => session.status === 'connected' && bridge.connected, 2_000);
});

test('scope_changed events reach the adapter cache through sendEvent', async (t) => {
  const port = nextPort++;
  const bridge = makeBridge(port);
  await bridge.start();
  t.after(() => bridge.stop());

  const { session } = makeSession(port);
  t.after(() => session.stop());
  session.start();
  await waitFor(() => session.status === 'connected');

  session.sendEvent('scope_changed', { state: 'confirmed', normalized_path: '/home/user/scope' });
  await waitFor(() => bridge.pluginInfo?.scope?.state === 'confirmed');
  assert.equal(bridge.pluginInfo?.scope?.normalized_path, '/home/user/scope');
});
