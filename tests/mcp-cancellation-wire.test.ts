// What `notifications/cancelled` actually does to a tool call, observed on the
// real stdio wire of the built executable (`dist/adapter/cli.js`), so
// `npm run build` must run before `npm test`.
//
// The adapter reads the per-request abort signal
// `@modelcontextprotocol/server` exposes as `ctx.mcpReq.signal` and carries it
// into the plugin bridge. These tests pin the three windows that matters splits
// into:
//
//   - before the command is relayed to Blockbench, it must never be relayed;
//   - after it is relayed, it is neither recalled nor repeated, and its result
//     is dropped rather than reported;
//   - in brokered mode, a command still queued behind a busy plugin is removed
//     from the queue instead of running late.
//
// In every window the cancelled request must produce no further client-facing
// JSON-RPC message at all. Each of those absence checks is paired with a live
// request on the same stdout stream, so an empty observation cannot be confused
// with a dead harness.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { startRawStdioServer, parseStdoutMessages, type RawStdioSession } from './helpers/raw-stdio.js';
import { createRuntimeRoot, removeRuntimeRoot } from './helpers/runtime-root.js';
import { WireFakePlugin, waitUntil } from './helpers/wire-plugin.js';

const SECRET = 'cancellation-wire-secret-4321';
let nextPort = 41_700;

function allocatePort(): number {
  return nextPort++;
}

interface WireHarness {
  session: RawStdioSession;
  plugin: WireFakePlugin;
  port: number;
}

/**
 * Send `initialize` plus `notifications/initialized` and wait for the single
 * response line, which is how a 2025-era MCP client opens a connection.
 */
async function openLegacyConnection(session: RawStdioSession): Promise<void> {
  session.send({
    jsonrpc: '2.0',
    id: 'open',
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'cancellation-wire-test', version: '1.0.0' },
    },
  });
  await session.waitForStdoutLines(1);
  session.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

/** Every JSON-RPC message the adapter has written that carries `id`. */
function messagesWithId(session: RawStdioSession, id: number | string): Array<Record<string, unknown>> {
  return parseStdoutMessages(session.stdoutLines()).filter((message) => message.id === id);
}

/** The `{summary, ok, ...}` envelope a tool response carries as its text content. */
function envelopeOf(message: Record<string, unknown>): Record<string, unknown> {
  const result = message.result as { content?: Array<{ text?: string }> } | undefined;
  const text = result?.content?.[0]?.text;
  assert.ok(typeof text === 'string', `expected a text tool result, saw ${JSON.stringify(message)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

function callProjectState(session: RawStdioSession, id: number | string): void {
  session.send({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'get_project_state', arguments: {} },
  });
}

function cancel(session: RawStdioSession, requestId: number | string): void {
  session.send({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId, reason: 'the test withdrew this request' },
  });
}

/**
 * Launch the built executable with a fake plugin already authenticated against
 * it. `hold` names the commands the plugin records but leaves unanswered.
 */
async function startWire(
  t: TestContext,
  options: { mode: 'direct' | 'brokered'; hold?: readonly string[]; requestTimeoutMs?: number },
): Promise<WireHarness> {
  const port = allocatePort();
  const root = await mkdtemp(join(tmpdir(), 'blockbench-mcp-cancellation-wire-'));
  const runtimeRoot = await createRuntimeRoot('bbcw-');
  const configPath = join(root, 'config.json');
  await writeFile(
    configPath,
    `${JSON.stringify({ version: 1, mode: 'shared-secret', port, secret: SECRET }, null, 2)}\n`,
    { mode: 0o600 },
  );

  const env: Record<string, string> = {
    BLOCKBENCH_MCP_CONFIG: configPath,
    BLOCKBENCH_MCP_RUNTIME_DIR: runtimeRoot,
    BLOCKBENCH_MCP_BROKER_IDLE_TIMEOUT_MS: '1000',
    BLOCKBENCH_MCP_REQUEST_TIMEOUT_MS: String(options.requestTimeoutMs ?? 30_000),
  };
  if (options.mode === 'brokered') env.BLOCKBENCH_MCP_BROKER = '1';

  const session = startRawStdioServer({ args: options.mode === 'direct' ? ['--direct'] : [], env });
  const plugin = new WireFakePlugin({ port, secret: SECRET, hold: options.hold });
  t.after(async () => {
    await plugin.close();
    await session.dispose();
    await rm(root, { recursive: true, force: true });
    await removeRuntimeRoot(runtimeRoot);
  });

  await openLegacyConnection(session);
  await plugin.connect();
  // A newly authenticated session always revokes whatever scoped directory the
  // plugin still holds, so seeing that request proves the plugin is attached.
  await waitUntil(
    () => plugin.requests('revoke_scope').length >= 1,
    'the scope revocation that starts every authenticated plugin session',
  );
  return { session, plugin, port };
}

test('a tool call cancelled before the adapter relays it never reaches the Blockbench plugin and is never answered', async (t) => {
  // Holding `revoke_scope` freezes the adapter in the one window where a public
  // command is inside it but has not been put on the WebSocket: the scoped-
  // directory gate every newly authenticated session passes through.
  const { session, plugin } = await startWire(t, { mode: 'direct', hold: ['revoke_scope'] });

  callProjectState(session, 'withdrawn-before-relay');
  await session.settle(150);
  assert.equal(plugin.requests('get_project_state').length, 0, 'the gate must hold the command before any relay');

  cancel(session, 'withdrawn-before-relay');
  plugin.release('revoke_scope');
  await session.settle(400);

  assert.equal(
    plugin.requests('get_project_state').length,
    0,
    'a command withdrawn at the scoped-directory gate must never be relayed to Blockbench',
  );
  assert.deepEqual(messagesWithId(session, 'withdrawn-before-relay'), []);

  // Positive control on the same stdout stream and the same plugin connection:
  // an identical call that is not withdrawn does get relayed and answered.
  callProjectState(session, 'kept');
  await waitUntil(() => messagesWithId(session, 'kept').length === 1, 'the uncancelled control response');
  assert.equal(plugin.requests('get_project_state').length, 1);
  assert.equal(envelopeOf(messagesWithId(session, 'kept')[0]).ok, true);
  assert.deepEqual(messagesWithId(session, 'withdrawn-before-relay'), [], 'the withdrawn request stayed unanswered');

  // The whole command list, not one name. A rollback, a recall, or a
  // compensating command issued on the adapter's own initiative would carry
  // some other name and would slip past a count of `get_project_state` alone.
  assert.deepEqual(
    plugin.frames.map((frame) => frame.command),
    ['revoke_scope', 'get_project_state'],
    'Blockbench saw a command this session never asked for. Withdrawing a request that was never relayed ' +
      'undoes nothing, so the only commands on this connection are the session-start scope revocation and the ' +
      'one uncancelled control call.',
  );
});

test('a tool call cancelled after Blockbench already has it is not relayed again, claims no rollback, and is never answered', async (t) => {
  const { session, plugin } = await startWire(t, { mode: 'direct', hold: ['get_project_state'] });

  callProjectState(session, 'withdrawn-in-flight');
  await waitUntil(() => plugin.requests('get_project_state').length === 1, 'the command to reach the plugin');

  cancel(session, 'withdrawn-in-flight');
  await session.settle(200);

  assert.equal(
    plugin.requests('get_project_state').length,
    1,
    'a withdrawn command that already reached Blockbench must not be sent a second time',
  );
  assert.deepEqual(messagesWithId(session, 'withdrawn-in-flight'), []);

  // Answering late is the strongest form of the absence check: the adapter has
  // the real result in hand and still reports nothing, because the client is no
  // longer waiting for it. Nothing claims the command was undone either.
  const held = plugin.heldRequests('get_project_state');
  assert.equal(held.length, 1);
  plugin.answer(held[0], { ok: true, result: { open: true, format: 'java_block', counts: { cubes: 99, groups: 0, textures: 0 } } });
  await session.settle(300);
  assert.deepEqual(messagesWithId(session, 'withdrawn-in-flight'), []);

  // Positive control: the very next call on this stream is answered normally,
  // so the silence above was the cancellation and not a stalled adapter.
  plugin.release('get_project_state');
  callProjectState(session, 'after-withdrawal');
  await waitUntil(() => messagesWithId(session, 'after-withdrawal').length === 1, 'the follow-up response');
  assert.equal(envelopeOf(messagesWithId(session, 'after-withdrawal')[0]).ok, true);
  assert.equal(plugin.requests('get_project_state').length, 2, 'exactly one relay per call, and no replay');

  // The whole command list. This is the window where a rollback would be
  // plausible — Blockbench has the command and the client stopped waiting — so
  // the claim that nothing is undone is checked against every name the plugin
  // saw, in order, rather than against the count of the one name expected.
  assert.deepEqual(
    plugin.frames.map((frame) => frame.command),
    ['revoke_scope', 'get_project_state', 'get_project_state'],
    'Blockbench received a command after a withdrawal. The adapter does not know whether the withdrawn command ' +
      'ran, so it must neither roll it back nor recall it: the only later command is the uncancelled control call.',
  );
});

test('nonzero-number and nonempty-string request ids cancel an in-flight tool call while ids 0 and "" do not, because @modelcontextprotocol/server discards a notifications/cancelled whose requestId is falsy', async (t) => {
  // The dependency tests `notification.params.requestId` for truthiness rather
  // than presence (`@modelcontextprotocol/server@2.0.0`,
  // `dist/src-CX2iR2pK.mjs`, `_oncancel`), so a cancellation naming `0`, `""`,
  // or `-0` is dropped before any handler or this adapter can see it and the
  // request runs to completion. That is upstream-owned, predates this adapter's
  // migration, and is deliberately not worked around here; this test records
  // the real outcome for each id class so a future reader can tell the
  // difference between this known limitation and a regression in the adapter.
  //
  // Every id is cancelled while its command is genuinely in flight -- recorded
  // by the plugin and deliberately unanswered -- rather than before it was
  // issued or after it had already completed.
  const { session, plugin } = await startWire(t, { mode: 'direct', hold: ['get_project_state'] });

  const ids: Array<{ label: string; id: number | string }> = [
    { label: 'nonzero number 7', id: 7 },
    { label: 'nonempty string "withdraw-me"', id: 'withdraw-me' },
    { label: 'number 0', id: 0 },
    { label: 'empty string ""', id: '' },
  ];

  const observed: Record<string, string> = {};
  let relayed = 0;

  /**
   * Prove the adapter has consumed everything written to stdin up to this
   * point, by making it answer a request issued afterwards. `health` needs no
   * plugin, so it is answered even while every `get_project_state` is held.
   */
  async function stdinDrained(marker: string): Promise<void> {
    session.send({ jsonrpc: '2.0', id: marker, method: 'tools/call', params: { name: 'health', arguments: {} } });
    await waitUntil(() => messagesWithId(session, marker).length === 1, `the stdin ordering marker ${marker}`);
  }

  for (const { label, id } of ids) {
    callProjectState(session, id);
    relayed += 1;
    await waitUntil(
      () => plugin.requests('get_project_state').length === relayed,
      `the command for request id ${JSON.stringify(id)} to reach the plugin`,
    );

    cancel(session, id);
    // The cancellation is a notification, so nothing answers it. Ordering is
    // what makes it observable: stdin is consumed in order, so a request issued
    // after it cannot be answered before the cancellation was read.
    await stdinDrained(`cancel-consumed-${String(relayed)}`);

    // Answer it anyway. A request the cancellation really reached ignores this
    // answer; a request the cancellation never reached is completed by it.
    const held = plugin.heldRequests('get_project_state');
    assert.equal(held.length, 1, `expected exactly one unanswered command for ${label}`);
    plugin.answer(held[0], { ok: true, result: { open: true, format: 'java_block', counts: { cubes: relayed, groups: 0, textures: 0 } } });

    // The sentinel: a second command relayed and answered by the plugin AFTER
    // the answer above, on the same WebSocket and through the same adapter path
    // to stdout. Once its response has been written, the earlier answer has
    // been through that path too — so what follows is an ordering proof rather
    // than a wait long enough to hope.
    const sentinelId = `sentinel-after-${String(relayed)}`;
    callProjectState(session, sentinelId);
    relayed += 1;
    await waitUntil(
      () => plugin.requests('get_project_state').length === relayed,
      `the sentinel command after ${label} to reach the plugin`,
    );
    const sentinelHeld = plugin.heldRequests('get_project_state');
    assert.equal(sentinelHeld.length, 1, `expected exactly one unanswered sentinel command after ${label}`);
    plugin.answer(sentinelHeld[0], {
      ok: true,
      result: { open: true, format: 'java_block', counts: { cubes: relayed, groups: 0, textures: 0 } },
    });
    await waitUntil(
      () => messagesWithId(session, sentinelId).length === 1,
      `the sentinel response after ${label}, which orders the absence check below`,
    );
    assert.equal(envelopeOf(messagesWithId(session, sentinelId)[0]).ok, true, `the sentinel after ${label} failed`);

    const answers = messagesWithId(session, id);
    observed[label] = answers.length === 0 ? 'cancelled: no response' : `not cancelled: ${String(answers.length)} response`;
    if (answers.length === 1) assert.equal(envelopeOf(answers[0]).ok, true, `${label} was answered but not successfully`);
  }

  assert.deepEqual(observed, {
    'nonzero number 7': 'cancelled: no response',
    'nonempty string "withdraw-me"': 'cancelled: no response',
    'number 0': 'not cancelled: 1 response',
    'empty string ""': 'not cancelled: 1 response',
  });

  // Each command was relayed exactly once regardless of how its cancellation
  // was treated: nothing is replayed and nothing is withdrawn from Blockbench.
  // One command per id under test, plus one sentinel after each.
  assert.equal(plugin.requests('get_project_state').length, ids.length * 2);
  assert.equal(relayed, ids.length * 2);
});

test('in brokered mode a tool call cancelled while it waits behind a busy plugin is dropped from the queue instead of running late', async (t) => {
  // The broker relays one command to Blockbench at a time. Holding the first
  // one keeps the second in the broker's queue, which is the window where a
  // cancellation can still stop it from ever executing.
  const { session, plugin } = await startWire(t, { mode: 'brokered', hold: ['get_project_state'] });

  callProjectState(session, 'occupies-the-lane');
  await waitUntil(() => plugin.requests('get_project_state').length === 1, 'the first command to occupy the lane');

  callProjectState(session, 'queued-then-withdrawn');
  await session.settle(200);
  assert.equal(plugin.requests('get_project_state').length, 1, 'the second command must still be queued, not relayed');

  cancel(session, 'queued-then-withdrawn');
  await session.settle(150);

  // Releasing the lane is what would let a queued command through. Nothing is
  // released for the withdrawn one, because the broker no longer holds it.
  plugin.release('get_project_state');
  await waitUntil(() => messagesWithId(session, 'occupies-the-lane').length === 1, 'the blocking call to complete');
  await session.settle(400);

  assert.equal(
    plugin.requests('get_project_state').length,
    1,
    'the withdrawn queue entry must never reach Blockbench, even after the lane frees up',
  );
  assert.deepEqual(messagesWithId(session, 'queued-then-withdrawn'), []);
  assert.equal(envelopeOf(messagesWithId(session, 'occupies-the-lane')[0]).ok, true);

  // Positive control: a request queued the same way but left alone does reach
  // the plugin and is answered, so the queue itself still works.
  plugin.hold('get_project_state');
  callProjectState(session, 'occupies-the-lane-again');
  await waitUntil(() => plugin.requests('get_project_state').length === 2, 'the second lane occupant');
  callProjectState(session, 'queued-and-kept');
  await session.settle(200);
  assert.equal(plugin.requests('get_project_state').length, 2, 'the control call is queued behind the lane occupant');
  plugin.release('get_project_state');
  await waitUntil(() => messagesWithId(session, 'queued-and-kept').length === 1, 'the queued control response');
  assert.equal(envelopeOf(messagesWithId(session, 'queued-and-kept')[0]).ok, true);
  assert.equal(plugin.requests('get_project_state').length, 3);
  assert.deepEqual(messagesWithId(session, 'queued-then-withdrawn'), [], 'the withdrawn entry never came back');
});
