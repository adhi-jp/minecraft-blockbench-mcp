// What a 2026-07-28 client observes on the raw stdio wire.
//
// Every assertion here drives `dist/adapter/cli.js` over newline-delimited
// JSON-RPC without the MCP client package, because the client and the server
// ship as a matched pair and a client-driven check can only show that the two
// agree with each other.
//
// The absence assertions are the point of this file — no `initialize`, no
// cacheable-result members on `tools/call`, no capability beyond the static
// tool list, no server-to-client request. Each one is paired with a positive
// observation on the same stdout stream, so an assertion cannot pass because
// the channel went quiet.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { TestContext } from 'node:test';

import {
  CACHEABLE_RESULT_MEMBERS,
  CANONICAL_SERVER_INFO,
  errorCodeOf,
  MODERN_CAPABILITIES,
  MODERN_PROTOCOL_VERSION,
  SERVER_INFO_META_KEY,
  advertisedTools,
  carriesMethodAndId,
  envelopeOf,
  exchange,
  isNotification,
  isResponse,
  modernRequest,
  openModernConnection,
} from './helpers/mcp-era-wire.ts';
import { CLI_ENTRY_PATH, startRawStdioServer } from './helpers/raw-stdio.ts';
import type { RawStdioSession } from './helpers/raw-stdio.ts';
import { createRuntimeRoot, removeRuntimeRoot } from './helpers/runtime-root.ts';

assert.ok(
  existsSync(CLI_ENTRY_PATH),
  `the built executable is missing at ${CLI_ENTRY_PATH}; run \`npm run build\` before this suite`,
);

/**
 * Start the executable in direct mode with no secret configured, which is the
 * state a fresh install is in: the plugin listener never starts, so every
 * discovery surface has to work without Blockbench.
 */
async function startModernSession(t: TestContext): Promise<RawStdioSession> {
  const session = startRawStdioServer({ args: ['--direct'] });
  t.after(async () => {
    await session.dispose();
  });
  return session;
}

test('a 2026-07-28 connection answers server/discover as its very first message, with no initialize', async (t) => {
  const session = await startModernSession(t);
  const result = await openModernConnection(session);

  assert.deepEqual(
    result.supportedVersions,
    [MODERN_PROTOCOL_VERSION],
    'discovery must report exactly the modern revision this executable serves',
  );
  // Positive control for "no initialize was needed": the connection is now
  // usable, and the very next request is answered on the same stream.
  const listed = await exchange(session, modernRequest(2, 'tools/list'));
  assert.ok(advertisedTools(listed).length > 0, 'tools/list answered nothing after discovery alone');
  assert.equal(
    session.stdoutLines().length,
    2,
    'discovery plus one tools/list must produce exactly two stdout messages, so nothing answered an initialize',
  );
});

test('modern discovery advertises exactly the static tools capability and the canonical server identity', async (t) => {
  const session = await startModernSession(t);
  const result = await openModernConnection(session);

  assert.deepEqual(
    result.capabilities,
    MODERN_CAPABILITIES,
    'the tool catalogue never changes while the process runs, so a modern connection must advertise ' +
      'listChanged: false and nothing else',
  );
  // The absence half: no capability this server does not implement may appear.
  const capabilities = result.capabilities as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(capabilities),
    ['tools'],
    'discovery advertised a capability beyond the tool list',
  );
  for (const unsupported of ['prompts', 'resources', 'logging', 'completions', 'sampling', 'elicitation', 'tasks']) {
    assert.equal(capabilities[unsupported], undefined, `discovery advertised the unsupported ${unsupported} capability`);
  }

  const meta = result._meta as Record<string, unknown> | undefined;
  assert.deepEqual(
    meta?.[SERVER_INFO_META_KEY],
    CANONICAL_SERVER_INFO,
    'discovery must report the canonical server identity under the reserved serverInfo key',
  );
});

test('server/discover and tools/list are cacheable complete results with ttlMs 0 and cacheScope private', async (t) => {
  const session = await startModernSession(t);
  const discovery = await openModernConnection(session);
  const listed = (await exchange(session, modernRequest(2, 'tools/list'))).result as Record<string, unknown>;

  for (const [label, result] of [
    ['server/discover', discovery],
    ['tools/list', listed],
  ] as const) {
    assert.equal(result.resultType, 'complete', `${label} must report a complete result`);
    assert.equal(result.ttlMs, 0, `${label} must report ttlMs 0`);
    assert.equal(result.cacheScope, 'private', `${label} must report cacheScope private`);
    assert.deepEqual(
      (result._meta as Record<string, unknown> | undefined)?.[SERVER_INFO_META_KEY],
      CANONICAL_SERVER_INFO,
      `${label} must carry the canonical server identity`,
    );
  }
});

test('a tools/call result is a complete result that never carries the cacheable ttlMs or cacheScope members', async (t) => {
  const session = await startModernSession(t);
  const listedResult = (await openModernConnection(session), await exchange(session, modernRequest(2, 'tools/list')))
    .result as Record<string, unknown>;
  const called = await exchange(session, modernRequest(3, 'tools/call', { name: 'health', arguments: {} }));
  const callResult = called.result as Record<string, unknown>;

  // Positive control on the same stdout stream: the fields do appear, on the
  // request immediately before this one, so their absence below is a property
  // of `tools/call` and not of the capture.
  for (const member of CACHEABLE_RESULT_MEMBERS) {
    assert.ok(member in listedResult, `tools/list did not carry ${member}, so the absence check has no control`);
    assert.ok(
      !(member in callResult),
      `a tools/call result carried the cacheable-result member ${member}; only server/discover and tools/list ` +
        'are specification-designated cacheable results in this server',
    );
  }
  assert.equal(callResult.resultType, 'complete', 'a successful tool call is still a complete modern result');
  assert.deepEqual(
    (callResult._meta as Record<string, unknown> | undefined)?.[SERVER_INFO_META_KEY],
    CANONICAL_SERVER_INFO,
    'a tools/call result must still carry the canonical server identity',
  );
  assert.equal(envelopeOf(called).ok, true, 'the health call itself must have succeeded');
});

test('a tool-domain failure on a modern connection stays a successful JSON-RPC result carrying isError', async (t) => {
  const session = await startModernSession(t);
  await openModernConnection(session);
  const called = await exchange(
    session,
    modernRequest(2, 'tools/call', { name: 'get_project_state', arguments: {} }),
  );
  const result = called.result as Record<string, unknown>;

  assert.equal(called.error, undefined, 'a tool-domain failure must not become a JSON-RPC error');
  assert.equal(result.isError, true, 'a tool-domain failure must set isError');
  assert.equal(result.resultType, 'complete', 'a tool-domain failure is still a complete modern result');
  const envelope = envelopeOf(called);
  assert.equal(envelope.ok, false);
  assert.equal((envelope.error as { code?: string }).code, 'E_PLUGIN_NOT_CONNECTED');
  for (const member of CACHEABLE_RESULT_MEMBERS) {
    assert.ok(!(member in result), `a failed tool call carried the cacheable-result member ${member}`);
  }
  // Server identity travels with every modern successful result path, and a
  // tool-domain failure is one of them: the JSON-RPC call succeeded, so the
  // reserved `_meta` identity belongs here exactly as it does on a call that
  // returned a payload.
  assert.deepEqual(
    (result._meta as Record<string, unknown> | undefined)?.[SERVER_INFO_META_KEY],
    CANONICAL_SERVER_INFO,
    'an isError tool result omitted the canonical server identity that every modern result carries',
  );
});

/**
 * The executable in brokered mode with nothing for it to attach to.
 *
 * A fresh runtime directory means no broker record and no broker, and no
 * configured secret means the one it tries to start cannot bind a listener. The
 * adapter answers out of its own state in that situation, which is the
 * synthesized-failure path this test needs.
 */
async function startModernBrokeredSession(t: TestContext): Promise<RawStdioSession> {
  const root = await mkdtemp(join(tmpdir(), 'blockbench-mcp-modern-brokered-'));
  const runtimeRoot = await createRuntimeRoot('bbmod-');
  const session = startRawStdioServer({
    args: [],
    env: { XDG_RUNTIME_DIR: runtimeRoot, BLOCKBENCH_MCP_BROKER: '1' },
  });
  t.after(async () => {
    await session.dispose();
    await rm(root, { recursive: true, force: true });
    await removeRuntimeRoot(runtimeRoot);
  });
  return session;
}

test('a failure the adapter synthesizes for itself still carries the canonical server identity on a modern connection', async (t) => {
  // Nothing outside the adapter answers here: there is no broker to attach to
  // and no plugin behind it, so both the refusal and the status report are
  // written by the adapter out of its own state. That is the result path most
  // likely to be assembled by hand and therefore to miss the reserved server
  // identity every modern result carries.
  const session = await startModernBrokeredSession(t);
  const refused = await exchange(
    session,
    modernRequest(1, 'tools/call', { name: 'get_project_state', arguments: {} }),
    20_000,
  );
  const refusedResult = refused.result as Record<string, unknown>;

  assert.equal(refused.error, undefined, 'a synthesized broker failure became a JSON-RPC error');
  assert.equal(refusedResult.isError, true, 'a synthesized broker failure did not set isError');
  assert.equal(
    errorCodeOf(envelopeOf(refused)),
    'E_BROKER_UNAVAILABLE',
    'the adapter did not report the unreachable broker, so this is not the synthesized path',
  );
  assert.deepEqual(
    (refusedResult._meta as Record<string, unknown> | undefined)?.[SERVER_INFO_META_KEY],
    CANONICAL_SERVER_INFO,
    'a synthesized broker failure omitted the canonical server identity',
  );

  // The same path in its successful shape: `health` reports the setup failure
  // rather than becoming one, and it too is a modern result.
  const health = await exchange(session, modernRequest(2, 'tools/call', { name: 'health', arguments: {} }));
  const healthResult = health.result as Record<string, unknown>;
  const envelope = envelopeOf(health);
  assert.equal(envelope.ok, true, 'health failed instead of reporting the setup error');
  assert.deepEqual(
    ((envelope.result as Record<string, unknown>).setup_errors as Array<{ code: string }>).map((issue) => issue.code),
    ['E_BROKER_UNAVAILABLE'],
    'health did not report the unreachable broker as a setup error',
  );
  assert.deepEqual(
    (healthResult._meta as Record<string, unknown> | undefined)?.[SERVER_INFO_META_KEY],
    CANONICAL_SERVER_INFO,
    'a locally answered health result omitted the canonical server identity',
  );
});

test('no outbound JSON-RPC object on a modern connection carries both method and id', async (t) => {
  const session = await startModernSession(t);
  await openModernConnection(session);
  // Drive a spread of surfaces so the capture has something to look at: a
  // catalogue read, a successful call, a tool-domain failure, a dependency
  // validation failure, a protocol error, and an unknown method.
  await exchange(session, modernRequest(2, 'tools/list'));
  await exchange(session, modernRequest(3, 'tools/call', { name: 'health', arguments: {} }));
  await exchange(session, modernRequest(4, 'tools/call', { name: 'get_project_state', arguments: {} }));
  await exchange(session, modernRequest(5, 'tools/call', { name: 'read_file', arguments: { path: 42 } }));
  await exchange(session, modernRequest(6, 'tools/call', { name: 'not_a_registered_tool', arguments: {} }));
  await exchange(session, modernRequest(7, 'blockbench/not-a-method'));
  session.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99 } });
  await session.settle(200);

  const outbound = session.stdoutLines().map((line) => JSON.parse(line) as Record<string, unknown>);
  const serverRequests = outbound.filter((message) => carriesMethodAndId(message));
  assert.deepEqual(
    serverRequests,
    [],
    'the server issued a JSON-RPC request to the client on a 2026-07-28 connection. That revision defines no ' +
      'server-to-client request, so a client would be asked to answer a method it never agreed to serve.',
  );

  // Positive control for the capture channel: it did see ordinary responses,
  // across both the result and the error shapes.
  const responses = outbound.filter((message) => isResponse(message));
  assert.equal(responses.length, outbound.length, 'every captured object should be an ordinary response here');
  assert.ok(responses.length >= 7, `the capture saw only ${String(responses.length)} response(s)`);
  assert.ok(
    responses.some((message) => 'result' in message) && responses.some((message) => 'error' in message),
    'the capture saw only one response shape, so it has not been shown to observe the full outbound stream',
  );
});

test('the server-to-client request check recognises an object that carries both method and id', () => {
  // The assertion above is an absence claim about a live stream. This proves
  // the predicate it rests on would actually fire, using the shapes the real
  // revisions define. This server emits no server-to-client request and no
  // notification of its own, so the live stream cannot supply this control.
  assert.equal(
    carriesMethodAndId({ jsonrpc: '2.0', id: 1, method: 'roots/list', params: {} }),
    true,
    'a server-to-client request must be recognised',
  );
  assert.equal(
    carriesMethodAndId({ jsonrpc: '2.0', id: 1, method: 'elicitation/create', params: { message: 'x' } }),
    true,
    'an elicitation request must be recognised',
  );
  assert.equal(carriesMethodAndId({ jsonrpc: '2.0', id: 1, result: {} }), false, 'a response is not a request');
  assert.equal(
    carriesMethodAndId({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'x' } }),
    false,
    'an error response is not a request',
  );
  assert.equal(
    carriesMethodAndId({ jsonrpc: '2.0', method: 'notifications/message', params: {} }),
    false,
    'a notification is not a request',
  );
  assert.equal(isNotification({ jsonrpc: '2.0', method: 'notifications/message', params: {} }), true);
  assert.equal(isResponse({ jsonrpc: '2.0', id: 1, result: {} }), true);
});

test('identical modern discovery and tools/list requests produce identical bytes on an unchanged build', async (t) => {
  const session = await startModernSession(t);
  await openModernConnection(session);
  const first = await exchange(session, modernRequest(2, 'tools/list'));
  const second = await exchange(session, modernRequest(3, 'tools/list'));

  assert.deepEqual(
    advertisedTools(second).map((tool) => tool.name),
    advertisedTools(first).map((tool) => tool.name),
    'the advertised tool order changed between two identical requests',
  );
  const [firstLine, secondLine] = [session.stdoutLines()[1], session.stdoutLines()[2]];
  assert.equal(
    secondLine.replace('"id":3', '"id":2'),
    firstLine,
    'two identical tools/list requests serialized differently, so the catalogue is not deterministic',
  );
});

/** One answer with its request id removed, so two answers can be compared whole. */
function answerWithoutRequestId(message: Record<string, unknown>): string {
  const { id: _id, ...rest } = message;
  return JSON.stringify(rest);
}

test('a modern request declaring different client capabilities does not inherit the previous request context', async (t) => {
  const session = await startModernSession(t);
  await openModernConnection(session, { clientCapabilities: { roots: { listChanged: true } } });
  const withSampling = await exchange(
    session,
    modernRequest(2, 'tools/list', {}, { clientCapabilities: { sampling: {} } }),
  );
  const withNone = await exchange(session, modernRequest(3, 'tools/list', {}, { clientCapabilities: {} }));
  // A self-reported identity must not change anything either.
  const impersonating = await exchange(
    session,
    modernRequest(4, 'tools/list', {}, { clientInfo: { name: 'minecraft-blockbench-mcp', version: '99.0.0' } }),
  );

  // Every one of the three has to be a served catalogue before the comparison
  // means anything. `advertisedTools` reads `result?.tools ?? []` and `exchange`
  // does not throw on a JSON-RPC error, so three refused requests would compare
  // equal as three empty lists.
  for (const [label, answered] of [
    ['the request declaring sampling', withSampling],
    ['the request declaring no capabilities', withNone],
    ['the request declaring the server\u2019s own identity', impersonating],
  ] as const) {
    assert.equal(answered.error, undefined, `${label} was refused, so this comparison proves nothing`);
    assert.ok(advertisedTools(answered).length > 0, `${label} advertised no tools, so this comparison proves nothing`);
  }

  // Compare the whole answer rather than the tool names: what the client
  // declared must change nothing at all about the result — not the catalogue,
  // not the cacheable members, not the reserved server identity — and a name
  // list would hide every one of those.
  assert.equal(
    answerWithoutRequestId(withNone),
    answerWithoutRequestId(withSampling),
    'what the client declared it can do changed the answer it got, so protocol context is leaking between ' +
      'requests',
  );
  assert.equal(
    answerWithoutRequestId(impersonating),
    answerWithoutRequestId(withSampling),
    'a self-reported client identity changed the answer the server returned',
  );
});
