// Request identity and finality on the real stdio wire of the built executable
// (`dist/adapter/cli.js`), so `npm run build` must run before `npm test`.
//
// A JSON-RPC id belongs to one stdio connection. Two MCP clients may pick the
// same one at the same moment, and one client may reuse an id the instant its
// previous request finished. The adapter therefore never correlates on the
// client's id: the direct bridge and the broker each allocate their own
// internal request UUID per attempt, and the broker's tombstones are per
// connection. These tests hold that line from the outside, and pin the matching
// finality rule -- one request instance produces at most one terminal
// client-facing message -- across the ways a request can end badly: a timeout,
// stdin reaching EOF, the plugin disconnecting, and the broker process dying.
//
// Several ids here are deliberately `0` or `""`. Those are the values on which
// `@modelcontextprotocol/server@2.0.0` coerces an inbound response id and a
// progress token with `Number()`, so they are exactly the ids on which a
// cross-delivery defect could show up rather than the ids on which it cannot.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { computeConfigIdentity } from '../src/adapter/broker/endpoint.js';
import { readBrokerRecord } from '../src/adapter/broker/rendezvous.js';
import { startRawStdioServer, parseStdoutMessages, type RawStdioSession } from './helpers/raw-stdio.js';
import { createRuntimeRoot, removeRuntimeRoot } from './helpers/runtime-root.js';
import { WireFakePlugin, waitUntil } from './helpers/wire-plugin.js';

/**
 * How long to keep reading stdout after the child process has exited.
 *
 * Node emits `exit` when the process is gone, not when its pipes are empty, so
 * an absence assertion taken at that instant can be reading a stream that still
 * has bytes in flight. The frozen-corpus driver in
 * `tests/helpers/premigration-baseline.ts` waits the same period for the same
 * reason.
 */
const POST_EXIT_FLUSH_MS = 200;

const SECRET = 'request-identity-wire-secret-8765';
let nextPort = 41_800;

function allocatePort(): number {
  return nextPort++;
}

async function openLegacyConnection(session: RawStdioSession): Promise<void> {
  session.send({
    jsonrpc: '2.0',
    id: 'open',
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'request-identity-wire-test', version: '1.0.0' },
    },
  });
  await session.waitForStdoutLines(1);
  session.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

function messagesWithId(session: RawStdioSession, id: number | string): Array<Record<string, unknown>> {
  return parseStdoutMessages(session.stdoutLines()).filter((message) => message.id === id);
}

function envelopeOf(message: Record<string, unknown>): {
  ok: boolean;
  error?: { code?: string };
  result?: { counts?: { cubes?: number } };
} {
  const result = message.result as { content?: Array<{ text?: string }> } | undefined;
  const text = result?.content?.[0]?.text;
  assert.ok(typeof text === 'string', `expected a text tool result, saw ${JSON.stringify(message)}`);
  return JSON.parse(text) as ReturnType<typeof envelopeOf>;
}

/** The marker the fake plugin put in a successful `get_project_state` answer. */
function markerOf(message: Record<string, unknown>): number | undefined {
  return envelopeOf(message).result?.counts?.cubes;
}

function callProjectState(session: RawStdioSession, id: number | string): void {
  session.send({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'get_project_state', arguments: {} },
  });
}

function markedResult(marker: number): { ok: true; result: unknown } {
  return { ok: true, result: { open: true, format: 'java_block', counts: { cubes: marker, groups: 0, textures: 0 } } };
}

interface WireWorld {
  root: string;
  configPath: string;
  port: number;
  runtimeRoot: string;
  brokerRecordPath: string;
  plugin: WireFakePlugin;
  /** Launch one more stdio client against this same config, plugin, and broker. */
  startClient(
    mode: 'direct' | 'brokered',
    options?: { requestTimeoutMs?: number; leaseIdleTimeoutMs?: number },
  ): Promise<RawStdioSession>;
}

async function createWorld(t: TestContext, hold?: readonly string[]): Promise<WireWorld> {
  const port = allocatePort();
  const root = await mkdtemp(join(tmpdir(), 'blockbench-mcp-request-identity-'));
  const configPath = join(root, 'config.json');
  await writeFile(
    configPath,
    `${JSON.stringify({ version: 1, mode: 'shared-secret', port, secret: SECRET }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const runtimeRoot = await createRuntimeRoot('bbrid-');
  const brokerRecordPath = join(
    runtimeRoot,
    'minecraft-blockbench-mcp',
    `broker-${computeConfigIdentity(configPath)}.json`,
  );

  const plugin = new WireFakePlugin({ port, secret: SECRET, hold });
  const sessions: RawStdioSession[] = [];

  t.after(async () => {
    await plugin.close();
    await Promise.all(sessions.map((session) => session.dispose()));
    // A brokered client may have started a detached broker; leave nothing
    // running that could hold this test's WebSocket port.
    const record = await readBrokerRecord(brokerRecordPath).catch(() => null);
    if (record !== null) {
      try {
        process.kill(record.broker_pid, 'SIGKILL');
      } catch {
        // Already gone, which is the normal case.
      }
    }
    await rm(root, { recursive: true, force: true });
    await removeRuntimeRoot(runtimeRoot);
  });

  const world: WireWorld = {
    root,
    configPath,
    port,
    runtimeRoot,
    brokerRecordPath,
    plugin,
    async startClient(mode, options) {
      const env: Record<string, string> = {
        BLOCKBENCH_MCP_CONFIG: configPath,
        XDG_RUNTIME_DIR: runtimeRoot,
        BLOCKBENCH_MCP_BROKER_IDLE_TIMEOUT_MS: '1000',
        BLOCKBENCH_MCP_REQUEST_TIMEOUT_MS: String(options?.requestTimeoutMs ?? 30_000),
      };
      if (options?.leaseIdleTimeoutMs !== undefined) {
        env.BLOCKBENCH_MCP_LEASE_IDLE_TIMEOUT_MS = String(options.leaseIdleTimeoutMs);
      }
      if (mode === 'brokered') env.BLOCKBENCH_MCP_BROKER = '1';
      const session = startRawStdioServer({ args: mode === 'direct' ? ['--direct'] : [], env });
      sessions.push(session);
      await openLegacyConnection(session);
      return session;
    },
  };
  return world;
}

/** Attach the fake plugin and wait for the revocation that proves it is live. */
async function attachPlugin(plugin: WireFakePlugin): Promise<void> {
  const before = plugin.requests('revoke_scope').length;
  await plugin.connect();
  await waitUntil(
    () => plugin.requests('revoke_scope').length > before,
    'the scope revocation that starts every authenticated plugin session',
  );
}

test('two stdio clients sharing one broker may have the same JSON-RPC id outstanding at once and each receives only its own outcome', async (t) => {
  // Id `0` throughout: it is the value the dependency's `Number()` coercion of
  // an inbound response id and progress token collapses onto, so it is an id on
  // which a cross-delivery defect could actually appear rather than one on which
  // it cannot.
  const world = await createWorld(t, ['get_project_state']);
  const leaseIdleTimeoutMs = 1_000;
  const a = await world.startClient('brokered', { leaseIdleTimeoutMs });
  const b = await world.startClient('brokered', { leaseIdleTimeoutMs });
  await attachPlugin(world.plugin);

  // Client A's call reaches Blockbench and stays there, unanswered.
  callProjectState(a, 0);
  await waitUntil(() => world.plugin.requests('get_project_state').length === 1, "client A's command");

  // Client B now issues the same JSON-RPC id while A's is still live. One
  // client controls the plugin session at a time, so B is told so -- and that
  // refusal must land on B's stream alone, under B's own id.
  callProjectState(b, 0);
  await waitUntil(() => messagesWithId(b, 0).length === 1, "client B's outcome");
  await a.settle(250);
  assert.equal(envelopeOf(messagesWithId(b, 0)[0]).error?.code, 'E_CLIENT_BUSY');
  assert.deepEqual(messagesWithId(a, 0), [], "client B's outcome must not be delivered to client A");
  assert.equal(world.plugin.requests('get_project_state').length, 1, "client B's call must not have been relayed");

  // A's own answer arrives and completes A's request, and only A's.
  world.plugin.answer(world.plugin.heldRequests('get_project_state')[0], markedResult(4_100));
  await waitUntil(() => messagesWithId(a, 0).length === 1, "client A's result");
  await a.settle(250);
  assert.equal(markerOf(messagesWithId(a, 0)[0]), 4_100);
  assert.equal(messagesWithId(a, 0).length, 1, 'client A ends with exactly one outcome');
  assert.equal(messagesWithId(b, 0).length, 1, 'client B ends with exactly one outcome');

  // Client A goes away, the way an MCP client closing would, and client B
  // reuses the very same id. The new request is a new instance: it gets its own
  // result, and the earlier refusal is neither repeated nor rewritten.
  await a.dispose();
  callProjectState(b, 0);
  await waitUntil(
    () => world.plugin.requests('get_project_state').length === 2,
    "client B's command to reach the plugin after the controller handoff",
    20_000,
  );
  world.plugin.answer(world.plugin.heldRequests('get_project_state')[0], markedResult(4_200));
  await waitUntil(() => messagesWithId(b, 0).length === 2, "client B's result on the reused id");
  await a.settle(250);

  const bOutcomes = messagesWithId(b, 0);
  assert.equal(bOutcomes.length, 2, 'two request instances on one id, two outcomes, no more');
  assert.equal(envelopeOf(bOutcomes[0]).error?.code, 'E_CLIENT_BUSY');
  assert.equal(markerOf(bOutcomes[1]), 4_200);
  assert.equal(messagesWithId(a, 0).length, 1, "client A's stream was untouched by client B's retry");
  assert.equal(markerOf(messagesWithId(a, 0)[0]), 4_100);
});

test('a JSON-RPC id may be reused after a terminal response, and the earlier result never reappears', async (t) => {
  const world = await createWorld(t);
  const session = await world.startClient('direct');
  await attachPlugin(world.plugin);

  callProjectState(session, 0);
  await waitUntil(() => messagesWithId(session, 0).length === 1, 'the first answer on the reused id');
  const firstMarker = markerOf(messagesWithId(session, 0)[0]);

  callProjectState(session, 0);
  await waitUntil(() => messagesWithId(session, 0).length === 2, 'the second answer on the reused id');
  await session.settle(250);

  const answers = messagesWithId(session, 0);
  assert.equal(answers.length, 2, 'exactly one terminal response per request instance');
  assert.notEqual(markerOf(answers[1]), firstMarker, 'the second request must carry its own result');
  assert.equal(envelopeOf(answers[0]).ok, true);
  assert.equal(envelopeOf(answers[1]).ok, true);
});

test('a plugin answer arriving after its request timed out cannot complete a later request that reuses the same id', async (t) => {
  const world = await createWorld(t, ['get_project_state']);
  const session = await world.startClient('direct', { requestTimeoutMs: 1_500 });
  await attachPlugin(world.plugin);

  callProjectState(session, 0);
  await waitUntil(() => world.plugin.requests('get_project_state').length === 1, 'the command that will time out');
  await waitUntil(() => messagesWithId(session, 0).length === 1, 'the timeout response', 8_000);
  const timedOut = envelopeOf(messagesWithId(session, 0)[0]);
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error?.code, 'E_TIMEOUT');

  // Same id again, a genuinely new request instance.
  callProjectState(session, 0);
  await waitUntil(() => world.plugin.requests('get_project_state').length === 2, 'the retry on the same id');
  const [stale, current] = world.plugin.heldRequests('get_project_state');

  // The abandoned answer turns up at last. It must satisfy nothing.
  world.plugin.answer(stale, markedResult(7_100));
  await session.settle(400);
  assert.equal(
    messagesWithId(session, 0).length,
    1,
    'a late answer for a timed-out request must not complete the request that reused its id',
  );

  // Positive control on the same stream: the answer that does belong to the
  // pending request completes it, and carries its own result.
  world.plugin.answer(current, markedResult(7_200));
  await waitUntil(() => messagesWithId(session, 0).length === 2, 'the retry response');
  await session.settle(250);
  const answers = messagesWithId(session, 0);
  assert.equal(answers.length, 2, 'two requests, two terminal responses, no more');
  assert.equal(markerOf(answers[1]), 7_200);
});

test('a duplicate plugin answer for a request that already completed produces no second response', async (t) => {
  const world = await createWorld(t, ['get_project_state']);
  const session = await world.startClient('direct');
  await attachPlugin(world.plugin);

  callProjectState(session, 0);
  await waitUntil(() => world.plugin.requests('get_project_state').length === 1, 'the command to reach the plugin');
  const [frame] = world.plugin.heldRequests('get_project_state');
  world.plugin.answer(frame, markedResult(8_100));
  await waitUntil(() => messagesWithId(session, 0).length === 1, 'the first and only response');

  // The same internal request id answered a second time, with a different
  // result, the way a confused or replaying plugin would.
  world.plugin.answer(frame, markedResult(8_200));
  await session.settle(400);
  const answers = messagesWithId(session, 0);
  assert.equal(answers.length, 1, 'a duplicate plugin answer must not produce a second terminal response');
  assert.equal(markerOf(answers[0]), 8_100);

  // Positive control: the stream still answers a fresh request, so the silence
  // above was the duplicate being dropped and not a wedged adapter.
  world.plugin.release('get_project_state');
  callProjectState(session, 'after-duplicate');
  await waitUntil(() => messagesWithId(session, 'after-duplicate').length === 1, 'the follow-up response');
  assert.equal(envelopeOf(messagesWithId(session, 'after-duplicate')[0]).ok, true);
  assert.equal(messagesWithId(session, 0).length, 1);
});

test('a tool call still in flight when stdin reaches EOF is never answered and the process still exits cleanly', async (t) => {
  const world = await createWorld(t, ['get_project_state']);
  const session = await world.startClient('direct');
  await attachPlugin(world.plugin);

  // Positive control first, on the same stdout stream: a completed call proves
  // this stream does carry tool responses.
  world.plugin.release('get_project_state');
  callProjectState(session, 'completed-before-eof');
  await waitUntil(() => messagesWithId(session, 'completed-before-eof').length === 1, 'the control response');

  world.plugin.hold('get_project_state');
  callProjectState(session, 'in-flight-at-eof');
  await waitUntil(() => world.plugin.requests('get_project_state').length === 2, 'the command that will be abandoned');

  session.endStdin();
  const exit = await session.waitForExit(10_000);
  // `exit` fires before the child's stdio pipes have finished draining, so a
  // read taken here would be of a stream that may still deliver bytes. The
  // frozen-corpus driver waits the same quiet period after exit for the same
  // reason; without it this absence check can pass on a message that simply had
  // not arrived yet.
  await session.settle(POST_EXIT_FLUSH_MS);
  assert.equal(exit.code, 0, 'the adapter must exit cleanly when its client goes away');
  assert.deepEqual(
    messagesWithId(session, 'in-flight-at-eof'),
    [],
    'a request whose client has gone must not be answered',
  );
  assert.equal(messagesWithId(session, 'completed-before-eof').length, 1);
  assert.equal(session.pendingStdout(), '', 'stdout must not end mid-message');
});

test('a tool call in flight when the plugin disconnects ends exactly once and is not replayed after the plugin returns', async (t) => {
  const world = await createWorld(t, ['get_project_state']);
  const session = await world.startClient('direct');
  await attachPlugin(world.plugin);

  callProjectState(session, 0);
  await waitUntil(() => world.plugin.requests('get_project_state').length === 1, 'the command to reach the plugin');

  await world.plugin.disconnect();
  await waitUntil(() => messagesWithId(session, 0).length === 1, 'the disconnect outcome');
  const outcome = envelopeOf(messagesWithId(session, 0)[0]);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_PLUGIN_NOT_CONNECTED');

  await attachPlugin(world.plugin);
  await session.settle(400);
  assert.equal(
    world.plugin.requests('get_project_state').length,
    1,
    'a request whose plugin vanished must not be re-sent when the plugin comes back',
  );
  assert.equal(messagesWithId(session, 0).length, 1, 'exactly one terminal response for that request instance');

  // Positive control: a new call after the reconnect is relayed and answered,
  // so the absent replay above was a decision and not a broken connection.
  world.plugin.release('get_project_state');
  callProjectState(session, 'after-reconnect');
  await waitUntil(() => messagesWithId(session, 'after-reconnect').length === 1, 'the post-reconnect response');
  assert.equal(envelopeOf(messagesWithId(session, 'after-reconnect')[0]).ok, true);
  assert.equal(world.plugin.requests('get_project_state').length, 2);
  assert.equal(messagesWithId(session, 0).length, 1);
});

test('a tool call in flight when the broker process is killed ends exactly once and gets no second outcome', async (t) => {
  const world = await createWorld(t, ['get_project_state']);
  const session = await world.startClient('brokered');
  await attachPlugin(world.plugin);

  callProjectState(session, 0);
  await waitUntil(() => world.plugin.requests('get_project_state').length === 1, 'the command to reach the plugin');

  const record = await readBrokerRecord(world.brokerRecordPath);
  assert.ok(record !== null, 'a brokered client must have published a broker record');
  process.kill(record.broker_pid, 'SIGKILL');

  await waitUntil(() => messagesWithId(session, 0).length === 1, 'the broker-loss outcome', 10_000);
  const outcome = envelopeOf(messagesWithId(session, 0)[0]);
  assert.equal(outcome.ok, false);
  assert.ok(
    outcome.error?.code === 'E_BROKER_UNAVAILABLE' || outcome.error?.code === 'E_PLUGIN_NOT_CONNECTED',
    `unexpected broker-loss code ${String(outcome.error?.code)}`,
  );

  // Answering the abandoned command now, the way a plugin that never noticed
  // would, must not produce anything: that broker is gone and the request
  // already ended.
  await session.settle(600);
  assert.equal(messagesWithId(session, 0).length, 1, 'losing the broker must produce exactly one terminal response');

  // Positive control: the same stream still answers a later call, so the
  // single-outcome assertion above is not an artifact of a dead stream.
  callProjectState(session, 'after-broker-loss');
  await waitUntil(() => messagesWithId(session, 'after-broker-loss').length === 1, 'the post-loss response', 15_000);
  assert.equal(messagesWithId(session, 0).length, 1);
});
