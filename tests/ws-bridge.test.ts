import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import WebSocket from 'ws';

import { isRequestCancelled } from '../src/adapter/request-cancellation.js';
import { WsBridge, CLOSE_CODES, listenerSetupIssue } from '../src/adapter/ws-bridge.js';
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

/**
 * Connect and authenticate a fake plugin, then answer the `revoke_scope` the
 * bridge sends every newly authenticated session. Resolves once that
 * acknowledgement is on the wire, so the caller's own responders are installed
 * before any public command is relayed. A real Blockbench plugin answers this
 * command (src/plugin/commands/scope-commands.ts); a fake that ignored it would
 * simply never be allowed to run a command.
 */
async function connectAuthenticated(port: number): Promise<{ socket: WebSocket; frames: unknown[] }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames: unknown[] = [];
  await once(socket, 'open');
  const ready = new Promise<void>((resolve) => {
    let acknowledged = false;
    let revoked = false;
    socket.on('message', (data) => {
      const parsed = JSON.parse(String(data));
      frames.push(parsed);
      if (parsed.type === 'hello_ack') acknowledged = true;
      if (parsed.type === 'request' && parsed.command === 'revoke_scope') {
        socket.send(JSON.stringify({ type: 'response', id: parsed.id, ok: true, result: { state: 'revoked' } }));
        revoked = true;
      }
      if (acknowledged && revoked) resolve();
    });
  });
  socket.send(helloFrame());
  await ready;
  return { socket, frames };
}

/** Wait until the fake plugin has recorded a relayed `request` frame for `command`. */
async function waitUntilFrame(frames: readonly unknown[], command: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const seen = (): boolean =>
    frames.some((frame) => {
      const record = frame as { type?: string; command?: string };
      return record.type === 'request' && record.command === command;
    });
  while (!seen()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for a relayed ${command} frame.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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

test('listener failures other than address conflicts use a truthful setup error', () => {
  const issue = listenerSetupIssue(Object.assign(new Error('secret path details'), { code: 'EPERM' }), 39731);
  assert.deepEqual(issue, {
    code: 'E_LISTENER_FAILED',
    message: 'WebSocket listener failed to start on 127.0.0.1:39731 (EPERM).',
  });
  assert.ok(!issue.message.includes('secret path details'));
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
  assert.equal(outcome.error?.details, undefined);
});

test('a mutating timeout reports unknown execution outcome and reconciliation guidance', async (t) => {
  const { bridge, port } = await startBridge({ requestTimeoutMs: 30 });
  t.after(() => bridge.stop());
  const { socket } = await connectAuthenticated(port);
  t.after(() => socket.close());

  let requestId = '';
  socket.on('message', (data) => {
    const frame = JSON.parse(String(data));
    if (frame.type === 'request') requestId = frame.id;
  });
  const outcome = await bridge.request('create_cubes', {});
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_TIMEOUT');
  assert.deepEqual(outcome.error?.details, {
    execution_state: 'unknown',
    retry: 'Do not retry automatically; the plugin may have completed the command.',
    reconciliation: {
      command: 'get_project_state',
      manual_check: 'Read back the affected objects before retrying the mutation.',
    },
  });
  assert.notEqual(requestId, '');
  socket.send(JSON.stringify({ type: 'response', id: requestId, ok: true, result: { uuids: ['late'] } }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(bridge.connected, true, 'late completion must be discarded without resolving the caller again');
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

/**
 * How a withdrawn request comes back out of the direct bridge.
 *
 * The wire-level cancellation tests observe silence on stdout, and silence is
 * also what `@modelcontextprotocol/server` produces on its own: it drops the
 * result and the thrown error of any request whose abort signal has fired. So
 * those tests would pass over a bridge that ignored the signal entirely and
 * simply answered late. This is the assertion that constrains this adapter: the
 * bridge itself has to reject, and it has to say how far the command got, since
 * `before_send` and `after_send` are the difference between "Blockbench never
 * saw this" and "Blockbench may have run it and nothing was rolled back".
 */
test('a withdrawn direct bridge request rejects and reports that nothing was sent', async (t) => {
  const { bridge, port } = await startBridge({ requestTimeoutMs: 5_000 });
  t.after(() => bridge.stop());
  const { socket, frames } = await connectAuthenticated(port);
  t.after(() => socket.close());

  const controller = new AbortController();
  controller.abort();
  const relayedBefore = frames.filter(
    (frame) => (frame as { type?: string; command?: string }).type === 'request',
  ).length;

  await assert.rejects(
    bridge.request('get_project_state', {}, undefined, controller.signal),
    (error: unknown) => {
      assert.ok(
        isRequestCancelled(error),
        `a withdrawn request settled with something other than a cancellation: ${String(error)}`,
      );
      assert.equal(error.stage, 'before_send', 'a request withdrawn before any relay reported the wrong stage');
      assert.equal(
        error.requestId,
        'get_project_state',
        'a withdrawn request that never got an internal id must be identified by its command name, never by a ' +
          'client-supplied JSON-RPC id',
      );
      return true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    frames.filter((frame) => (frame as { type?: string }).type === 'request').length,
    relayedBefore,
    'a request withdrawn before it was sent still reached the plugin',
  );
});

test('a direct bridge request withdrawn after it reached the plugin rejects, reports after_send, and is never recalled', async (t) => {
  const { bridge, port } = await startBridge({ requestTimeoutMs: 5_000 });
  t.after(() => bridge.stop());
  const { socket, frames } = await connectAuthenticated(port);
  t.after(() => socket.close());

  const controller = new AbortController();
  const pending = bridge.request('get_project_state', {}, undefined, controller.signal);
  await waitUntilFrame(frames, 'get_project_state');
  const relayed = frames.filter(
    (frame): frame is { type: string; command: string; id: string } =>
      (frame as { type?: string }).type === 'request',
  );
  controller.abort();

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(isRequestCancelled(error), `expected a cancellation, saw ${String(error)}`);
    assert.equal(
      error.stage,
      'after_send',
      'a request already handed to Blockbench reported that nothing was sent, which would claim an undo the ' +
        'adapter cannot perform',
    );
    assert.equal(
      error.requestId,
      relayed.at(-1)?.id,
      'the withdrawn request was not identified by the internal correlation id it was relayed under',
    );
    return true;
  });

  // Nothing is recalled and nothing is repeated: the command list the plugin
  // saw is compared whole, so a rollback or a retry under any command name
  // fails here rather than only the one name a spot check would look for.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(
    frames
      .filter((frame) => (frame as { type?: string }).type === 'request')
      .map((frame) => (frame as { command: string }).command),
    ['revoke_scope', 'get_project_state'],
    'the plugin received a command after the withdrawal; a withdrawn request is neither rolled back nor replayed',
  );
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

test('a revoke_scope acknowledgement naming a scope state that still grants access is refused with E_PROTOCOL_MISMATCH', async (t) => {
  // The bridge re-validates this one reply because it does not trust the
  // payload. Parsing it is not enough: `confirmed` and `proposed` are members
  // of the scope status enum that still carry a live grant, so accepting one
  // as an acknowledgement would open the gate on a directory the plugin never
  // gave up.
  for (const stillGranting of [
    { state: 'confirmed', normalized_path: '/tmp/scoped' },
    { state: 'proposed', normalized_path: '/tmp/scoped' },
  ]) {
    const harness = await startBridge();
    t.after(() => harness.bridge.stop());
    const socket = new WebSocket(`ws://127.0.0.1:${harness.port}`);
    t.after(() => socket.close());
    await once(socket, 'open');
    const relayed: string[] = [];
    let authenticated: () => void;
    const acknowledged = new Promise<void>((resolve) => {
      authenticated = resolve;
    });
    socket.on('message', (data) => {
      const parsed = JSON.parse(String(data)) as { type?: string; id?: string; command?: string };
      if (parsed.type === 'hello_ack') {
        authenticated();
        return;
      }
      if (parsed.type !== 'request') return;
      relayed.push(parsed.command ?? '');
      if (parsed.command === 'revoke_scope') {
        socket.send(JSON.stringify({ type: 'response', id: parsed.id, ok: true, result: stillGranting }));
        return;
      }
      socket.send(JSON.stringify({ type: 'response', id: parsed.id, ok: true, result: { relayed: true } }));
    });
    socket.send(helloFrame());
    await acknowledged;

    const outcome = await harness.bridge.request('get_project_state', {});
    assert.equal(
      outcome.ok,
      false,
      `a command was served after revoke_scope was acknowledged with scope state ${stillGranting.state}`,
    );
    assert.equal(outcome.error?.code, 'E_PROTOCOL_MISMATCH');
    assert.deepEqual(outcome.error?.details, { state: stillGranting.state });
    assert.equal(harness.bridge.scopeCleared, false, `scope state ${stillGranting.state} was recorded as cleared`);
    assert.deepEqual(
      relayed.filter((command) => command !== 'revoke_scope'),
      [],
      `a command was relayed after a revocation acknowledged as ${stillGranting.state}`,
    );
  }
});
