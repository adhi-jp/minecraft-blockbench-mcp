// How the executable decides which MCP wire era a stdio connection speaks, and
// what it refuses once that decision is made.
//
// The five locked legacy revisions must keep negotiating exactly the shape the
// frozen corpus recorded. A `2026-07-28` client must be able to open with
// `server/discover` and no `initialize`. A hybrid opening — a legacy
// `initialize` that also stamps the reserved `2026-07-28` claims onto
// `params._meta` — must be served as legacy, with everything else about the
// opening left alone. After the era is pinned, a request from the other era is
// refused, and a refused request must not reach the plugin. On a `2026-07-28`
// connection the per-request `io.modelcontextprotocol/protocolVersion` claim is
// compared against the supported set on every request, not only on the one
// that pinned the era; on a 2025-era connection that same claim stays opaque.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { TestContext } from 'node:test';

import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server';

import {
  CANONICAL_SERVER_INFO,
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  LEGACY_CAPABILITIES,
  LEGACY_COUNTER_OFFER_VERSION,
  LOCKED_LEGACY_PROTOCOL_VERSIONS,
  MODERN_PROTOCOL_VERSION,
  PROTOCOL_VERSION_META_KEY,
  advertisedTools,
  envelopeOf,
  errorCodeOf,
  exchange,
  exchangeExpectingSilence,
  legacyOpening,
  legacyRequest,
  modernMeta,
  modernRequest,
  openLegacyConnection,
} from './helpers/mcp-era-wire.ts';
import { CLI_ENTRY_PATH, REPO_ROOT, startRawStdioServer } from './helpers/raw-stdio.ts';
import type { RawStdioSession } from './helpers/raw-stdio.ts';
import { createRuntimeRoot, removeRuntimeRoot } from './helpers/runtime-root.ts';
import { WireFakePlugin, waitUntil } from './helpers/wire-plugin.ts';

assert.ok(
  existsSync(CLI_ENTRY_PATH),
  `the built executable is missing at ${CLI_ENTRY_PATH}; run \`npm run build\` before this suite`,
);

const SECRET = 'era-negotiation-wire-secret-2468';
let nextPort = 42_200;

function allocatePort(): number {
  const port = nextPort++;
  assert.ok(port <= 42_299, 'the era negotiation tests must stay inside the reserved 42200-42299 port range');
  return port;
}

function startSession(t: TestContext, env: Record<string, string> = {}): RawStdioSession {
  const session = startRawStdioServer({ args: ['--direct'], env });
  t.after(async () => {
    await session.dispose();
  });
  return session;
}

/** The executable with a fake Blockbench plugin already authenticated to it. */
interface PluginObservedHarness {
  session: RawStdioSession;
  plugin: WireFakePlugin;
}

async function startWithPlugin(t: TestContext): Promise<PluginObservedHarness> {
  const port = allocatePort();
  const root = await mkdtemp(join(tmpdir(), 'blockbench-mcp-era-negotiation-'));
  const runtimeRoot = await createRuntimeRoot('bbera-');
  const configPath = join(root, 'config.json');
  await writeFile(
    configPath,
    `${JSON.stringify({ version: 1, mode: 'shared-secret', port, secret: SECRET }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const session = startRawStdioServer({
    args: ['--direct'],
    env: {
      BLOCKBENCH_MCP_CONFIG: configPath,
      XDG_RUNTIME_DIR: runtimeRoot,
      BLOCKBENCH_MCP_REQUEST_TIMEOUT_MS: '5000',
    },
  });
  const plugin = new WireFakePlugin({ port, secret: SECRET });
  t.after(async () => {
    await plugin.close();
    await session.dispose();
    await rm(root, { recursive: true, force: true });
    await removeRuntimeRoot(runtimeRoot);
  });
  return { session, plugin };
}

/**
 * The era constants in `tests/helpers/mcp-era-wire.ts` are hand-written, and a
 * hand-written constant that restates the implementation drifts silently: it
 * agrees with whatever the tests using it happen to observe. Each one that has
 * an authority outside this repository is checked against that authority here.
 *
 * The modern revision is deliberately not in this list, because it has no such
 * authority: it is this project's own addition, absent from every version list
 * the dependency exports. What pins it instead is the dependency's own refusal
 * path — the `-32022` assertions elsewhere in this file require the executable
 * to serve exactly that revision and refuse every other claim.
 */
test('the legacy era constants match the version lists the MCP server package exports', () => {
  assert.deepEqual(
    [...LOCKED_LEGACY_PROTOCOL_VERSIONS].sort(),
    [...SUPPORTED_PROTOCOL_VERSIONS].sort(),
    'the five locked legacy revisions are no longer exactly the revisions @modelcontextprotocol/server supports. ' +
      'Either the dependency changed which revisions it serves, in which case the frozen corpus records ' +
      'behaviour for a revision that is gone, or the hand-written list drifted.',
  );
  // Order matters to the readers of this constant: the tests that walk it
  // report per-revision failures oldest first.
  assert.deepEqual(
    [...LOCKED_LEGACY_PROTOCOL_VERSIONS],
    [...LOCKED_LEGACY_PROTOCOL_VERSIONS].sort(),
    'the locked legacy revisions are no longer listed oldest first',
  );
  assert.equal(
    LEGACY_COUNTER_OFFER_VERSION,
    LATEST_PROTOCOL_VERSION,
    'an unsupported legacy initialize is answered with the latest revision the dependency supports, so this ' +
      'constant has to be that revision and not a copy of what it used to be',
  );
  assert.ok(
    !SUPPORTED_PROTOCOL_VERSIONS.includes(MODERN_PROTOCOL_VERSION),
    `${MODERN_PROTOCOL_VERSION} appears in the dependency's supported legacy revisions. The two eras are ` +
      'negotiated by different paths in this executable, and a revision the dependency now handles itself ' +
      'would be served twice over.',
  );
  assert.equal(
    CANONICAL_SERVER_INFO.version,
    (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version,
    'the server version reported on both eras is no longer the package version',
  );
});

test('each of the five locked legacy revisions negotiates and keeps its recorded capability shape', async (t) => {
  for (const version of LOCKED_LEGACY_PROTOCOL_VERSIONS) {
    const session = startSession(t);
    const result = await openLegacyConnection(session, { protocolVersion: version });

    assert.equal(result.protocolVersion, version, `${version} was not echoed back as the negotiated revision`);
    assert.deepEqual(
      result.capabilities,
      LEGACY_CAPABILITIES,
      `${version} must keep being answered with the capability shape the frozen corpus recorded`,
    );
    assert.deepEqual(result.serverInfo, CANONICAL_SERVER_INFO, `${version} reported a different server identity`);

    // Positive control: the negotiated connection is usable, not merely
    // answered, and it lists the same catalogue every era does.
    const listed = await exchange(session, legacyRequest(2, 'tools/list'));
    assert.ok(advertisedTools(listed).length > 0, `${version} negotiated but then listed no tools`);

    // Listing is not calling. A revision that negotiates and serves a catalogue
    // can still fail at the point a tool actually runs, so every locked
    // revision is made to answer a call as well: one that succeeds outright and
    // one that fails inside the tool domain, which are the two shapes a
    // `tools/call` result takes on this server.
    const called = await exchange(session, legacyRequest(3, 'tools/call', { name: 'health', arguments: {} }));
    assert.equal(called.error, undefined, `${version} answered a tools/call with a JSON-RPC error`);
    const envelope = envelopeOf(called);
    assert.equal(envelope.ok, true, `${version} negotiated but then could not run a tool`);
    assert.equal(
      (called.result as Record<string, unknown>).isError,
      undefined,
      `${version} marked a successful tool call as an error`,
    );
    assert.equal(envelope.command, undefined, `${version} changed the health envelope shape`);

    const failed = await exchange(
      session,
      legacyRequest(4, 'tools/call', { name: 'get_project_state', arguments: {} }),
    );
    assert.equal(
      (failed.result as Record<string, unknown>).isError,
      true,
      `${version} did not mark a tool-domain failure with isError`,
    );
    assert.equal(
      errorCodeOf(envelopeOf(failed)),
      'E_PLUGIN_NOT_CONNECTED',
      `${version} reported a different code for a disconnected plugin`,
    );
    await session.dispose();
  }
});

test('no modern result member leaks into a legacy negotiation or a legacy tool listing', async (t) => {
  const session = startSession(t);
  const negotiated = await openLegacyConnection(session, { protocolVersion: '2025-11-25' });
  const listed = (await exchange(session, legacyRequest(2, 'tools/list'))).result as Record<string, unknown>;

  for (const [label, result] of [
    ['the legacy initialize result', negotiated],
    ['a legacy tools/list result', listed],
  ] as const) {
    for (const member of ['resultType', 'ttlMs', 'cacheScope', 'supportedVersions', '_meta']) {
      assert.ok(!(member in result), `${label} carried the modern-only member ${member}`);
    }
  }
  // Positive control on the same channel: the legacy members that must be
  // present are present.
  assert.equal(negotiated.protocolVersion, '2025-11-25');
  assert.ok(Array.isArray((listed as { tools?: unknown }).tools));
});

test('a hybrid opening carrying the reserved 2026-07-28 claims is served as legacy on every locked revision', async (t) => {
  for (const version of LOCKED_LEGACY_PROTOCOL_VERSIONS) {
    const session = startSession(t);
    const opening = legacyOpening(1, {
      protocolVersion: version,
      meta: {
        [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
        [CLIENT_CAPABILITIES_META_KEY]: {},
        [CLIENT_INFO_META_KEY]: { name: 'hybrid-client', version: '1.0.0' },
      },
    });
    const answered = await exchange(session, opening);
    const result = answered.result as Record<string, unknown> | undefined;

    assert.equal(
      answered.error,
      undefined,
      `a hybrid opening on ${version} was refused instead of being served as legacy: ${JSON.stringify(answered)}`,
    );
    assert.equal(result?.protocolVersion, version, `a hybrid opening on ${version} negotiated a different revision`);
    assert.deepEqual(result?.capabilities, LEGACY_CAPABILITIES, `a hybrid opening on ${version} changed capabilities`);
    assert.ok(!('supportedVersions' in (result ?? {})), `a hybrid opening on ${version} was served as modern`);
    await session.dispose();
  }
});

test('a hybrid opening keeps its ordinary _meta members, its declared capabilities, and its client identity', async (t) => {
  const session = startSession(t);
  const opening = legacyOpening(1, {
    protocolVersion: '2025-06-18',
    capabilities: { roots: { listChanged: true }, sampling: {} },
    clientInfo: { name: 'hybrid-client', version: '4.2.0' },
    meta: {
      [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
      [CLIENT_CAPABILITIES_META_KEY]: {},
      [CLIENT_INFO_META_KEY]: { name: 'hybrid-client', version: '4.2.0' },
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      'io.modelcontextprotocol/somethingElse': { keep: true },
      'com.example/private': 'kept',
    },
  });
  const answered = await exchange(session, opening);

  assert.equal(
    (answered.result as Record<string, unknown> | undefined)?.protocolVersion,
    '2025-06-18',
    'the revision the client asked for did not survive normalization',
  );
  // Positive control that the connection really is a working legacy one: the
  // opening was accepted with non-empty declared capabilities and the
  // catalogue is served on it.
  session.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const listed = await exchange(session, legacyRequest(2, 'tools/list'));
  assert.ok(advertisedTools(listed).length > 0, 'the hybrid-opened legacy connection served no catalogue');
});

test('a legacy connection refuses a 2026-07-28 request once its era is pinned', async (t) => {
  const session = startSession(t);
  await openLegacyConnection(session, { protocolVersion: '2025-06-18' });
  const refused = await exchange(session, modernRequest(2, 'server/discover'));

  assert.equal(refused.result, undefined, 'a modern discovery was served on a pinned legacy connection');
  assert.equal(
    (refused.error as { code?: number } | undefined)?.code,
    -32601,
    'a legacy connection must answer a method that revision does not define with -32601',
  );
  // Positive control on the same connection: legacy requests still work after
  // the refusal, so the refusal did not tear the connection down.
  const listed = await exchange(session, legacyRequest(3, 'tools/list'));
  assert.ok(advertisedTools(listed).length > 0, 'the connection stopped working after refusing a modern request');
});

test('server/discover alone leaves the era open, so a legacy initialize after it still negotiates legacy', async (t) => {
  // `server/discover` is the one method a client may send before it has
  // committed to a revision: it exists so a client can ask what the server
  // speaks and then decide. Answering it therefore does not pin the
  // connection, and a client that discovers and then opens the 2025-era
  // handshake is served as legacy.
  const session = startSession(t);
  const discovered = await exchange(session, modernRequest(1, 'server/discover'));
  assert.deepEqual(
    (discovered.result as Record<string, unknown>).supportedVersions,
    [MODERN_PROTOCOL_VERSION],
    'discovery must answer before the era is decided',
  );
  const discoveredAgain = await exchange(session, modernRequest(2, 'server/discover'));
  assert.equal((discoveredAgain.result as Record<string, unknown>).resultType, 'complete');

  const negotiated = await exchange(session, legacyOpening(3, { protocolVersion: '2025-06-18' }));
  const result = negotiated.result as Record<string, unknown> | undefined;
  assert.equal(negotiated.error, undefined, 'discovery must not have pinned the connection to the modern era');
  assert.equal(result?.protocolVersion, '2025-06-18');
  assert.deepEqual(result?.capabilities, LEGACY_CAPABILITIES);
  assert.ok(!('resultType' in (result ?? {})), 'the legacy handshake carried a modern result member');
});

test('a 2026-07-28 connection refuses a legacy initialize with -32022 and names the revision it serves', async (t) => {
  const session = startSession(t);
  // A modern request that is not `server/discover` is what pins the era.
  await exchange(session, modernRequest(1, 'tools/list'));
  const refused = await exchange(session, legacyOpening(2, { protocolVersion: '2025-06-18' }));
  const error = refused.error as { code?: number; message?: string; data?: Record<string, unknown> } | undefined;

  assert.equal(refused.result, undefined, 'a legacy handshake was served on a pinned modern connection');
  assert.equal(error?.code, -32022, 'a cross-era request after the era is pinned must use -32022');
  assert.deepEqual(error?.data?.supported, [MODERN_PROTOCOL_VERSION], 'the refusal must name the supported revision');
  assert.equal(error?.data?.requested, '2025-06-18', 'the refusal must name what was requested');
  // Positive control: the modern connection still serves after the refusal.
  const listed = await exchange(session, modernRequest(3, 'tools/list'));
  assert.ok(advertisedTools(listed).length > 0, 'the connection stopped working after refusing a legacy handshake');
});

test('an unsupported 2026-07-28 version is refused with -32022 while an unsupported legacy initialize counter-offers', async (t) => {
  const modernSession = startSession(t);
  const modernRefusal = await exchange(
    modernSession,
    modernRequest(1, 'server/discover', {}, { protocolVersion: '1999-01-01' }),
  );
  const modernError = modernRefusal.error as { code?: number; data?: Record<string, unknown> } | undefined;
  assert.equal(modernError?.code, -32022, 'an unsupported modern revision must be refused with -32022');
  assert.deepEqual(modernError?.data?.supported, [MODERN_PROTOCOL_VERSION]);
  assert.equal(modernError?.data?.requested, '1999-01-01');

  const legacySession = startSession(t);
  const counterOffer = await exchange(legacySession, legacyOpening(1, { protocolVersion: '1999-01-01' }));
  const result = counterOffer.result as Record<string, unknown> | undefined;
  assert.equal(counterOffer.error, undefined, 'an unsupported legacy revision must counter-offer, not refuse');
  assert.equal(
    result?.protocolVersion,
    LEGACY_COUNTER_OFFER_VERSION,
    'the legacy counter-offer changed from the revision the frozen corpus recorded',
  );
  assert.deepEqual(result?.capabilities, LEGACY_CAPABILITIES);
});

test('a 2026-07-28 request with a missing or malformed _meta envelope is refused with -32602', async (t) => {
  const session = startSession(t);
  // Pin the era first: until a request other than `server/discover` arrives,
  // the connection has not committed to a revision and the reserved envelope
  // is not yet required.
  await exchange(session, modernRequest(1, 'tools/list'));

  const missing = await exchange(session, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const missingError = missing.error as { code?: number; message?: string } | undefined;
  assert.equal(missing.result, undefined, 'a modern request with no reserved envelope was served');
  assert.equal(missingError?.code, -32602, 'a missing reserved _meta envelope must be refused with -32602');
  assert.match(
    String(missingError?.message),
    /_meta/,
    'the refusal must say which envelope was missing so a client can fix it',
  );

  const malformed = await exchange(session, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/list',
    params: {
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
        [CLIENT_CAPABILITIES_META_KEY]: 'not-an-object',
        [CLIENT_INFO_META_KEY]: { name: 'era-matrix-client', version: '1.0.0' },
      },
    },
  });
  assert.equal(malformed.result, undefined, 'a modern request with a malformed reserved envelope was served');
  assert.equal(
    (malformed.error as { code?: number } | undefined)?.code,
    -32602,
    'a malformed reserved _meta envelope must be refused with -32602',
  );

  // Positive control on the same connection: a well-formed envelope is served.
  const served = await exchange(session, modernRequest(4, 'tools/list'));
  assert.ok(advertisedTools(served).length > 0, 'a well-formed modern request was not served');
});

test('a legacy connection ignores the reserved 2026-07-28 claims instead of answering as modern', async (t) => {
  // On a 2025-era connection `_meta` is opaque: a server that started
  // rejecting members it does not recognise would break legacy clients. The
  // requirement a legacy connection does carry is that stamping the reserved
  // claims onto a request cannot pull a modern answer out of it.
  const session = startSession(t);
  await openLegacyConnection(session, { protocolVersion: '2025-06-18' });
  const listed = await exchange(session, modernRequest(2, 'tools/list'));
  const result = listed.result as Record<string, unknown>;

  assert.ok(Array.isArray(result.tools), 'the legacy connection stopped serving its catalogue');
  for (const member of ['resultType', 'ttlMs', 'cacheScope', '_meta']) {
    assert.ok(
      !(member in result),
      `a request stamped with the reserved 2026-07-28 claims pulled the modern result member ${member} out of ` +
        'a connection that negotiated a 2025-era revision',
    );
  }
  // Positive control: the same members are present when the connection really
  // is modern, so their absence here is the era and not the request shape.
  const modernSession = startSession(t);
  const modernResult = (await exchange(modernSession, modernRequest(1, 'tools/list'))).result as Record<
    string,
    unknown
  >;
  assert.equal(modernResult.resultType, 'complete');
  assert.equal(modernResult.ttlMs, 0);
});

test('a request refused for its era or its metadata never reaches the Blockbench plugin', async (t) => {
  const { session, plugin } = await startWithPlugin(t);
  // Pin the connection to 2026-07-28 with a request that is not
  // `server/discover`, so the era and metadata refusals below actually apply.
  await exchange(session, modernRequest(1, 'tools/list'));
  await plugin.connect();
  await waitUntil(
    () => plugin.requests('revoke_scope').length >= 1,
    'the scope revocation that starts every authenticated plugin session',
  );
  const framesAfterAuthentication = plugin.frames.length;

  // Each of these is refused before dispatch, for a different reason:
  // a cross-era handshake, a missing reserved envelope, a malformed reserved
  // envelope, an unknown method, and a `tools/call` whose reserved claim names
  // a revision this server does not support. The last one is the interesting
  // case: it names a real tool with valid arguments, so nothing but the
  // revision check stands between it and Blockbench.
  const refusals = [
    legacyOpening(10, { protocolVersion: '2025-06-18' }),
    { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'get_project_state', arguments: {} } },
    {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: {
        name: 'get_project_state',
        arguments: {},
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
          [CLIENT_CAPABILITIES_META_KEY]: 'not-an-object',
          [CLIENT_INFO_META_KEY]: { name: 'era-matrix-client', version: '1.0.0' },
        },
      },
    },
    modernRequest(13, 'blockbench/not-a-method'),
    modernRequest(
      14,
      'tools/call',
      { name: 'get_project_state', arguments: {} },
      { protocolVersion: '1999-01-01' },
    ),
  ];
  for (const request of refusals) {
    const answered = await exchange(session, request);
    assert.equal(
      answered.result,
      undefined,
      `this request was served instead of refused: ${JSON.stringify(request).slice(0, 200)}`,
    );
  }
  await session.settle(300);

  assert.equal(
    plugin.frames.length,
    framesAfterAuthentication,
    `a refused request reached Blockbench: ${JSON.stringify(plugin.frames.slice(framesAfterAuthentication))}`,
  );

  // Positive control on the same plugin channel: an accepted request does
  // reach it, so the observation above is not an artefact of a dead plugin.
  const accepted = exchange(session, modernRequest(15, 'tools/call', { name: 'get_project_state', arguments: {} }));
  await waitUntil(
    () => plugin.requests('get_project_state').length >= 1,
    'the accepted tool call that proves the plugin observation channel is live',
  );
  await accepted;
  assert.ok(
    plugin.frames.length > framesAfterAuthentication,
    'the plugin observation channel never saw an accepted request, so it proves nothing about refusals',
  );
});

test('an unsupported io.modelcontextprotocol/protocolVersion is refused with -32022 on a later request too, not only on the one that selects the era', async (t) => {
  // 2026-07-28 is a stateless revision: every request carries its own
  // `io.modelcontextprotocol/protocolVersion`, and no request may be served on
  // the strength of a claim some earlier request on the same connection made.
  // So the claimed revision is compared against the supported set on the
  // request that selects the era AND on every request after it, and a client
  // must not be able to tell the two comparisons apart.
  const selectionSession = startSession(t);
  const atSelection = await exchange(
    selectionSession,
    modernRequest(1, 'tools/list', {}, { protocolVersion: '1999-01-01' }),
  );
  const selectionError = atSelection.error as { code?: number; data?: Record<string, unknown> } | undefined;
  assert.equal(
    selectionError?.code,
    -32022,
    'an unsupported revision on the request that selects the era must be refused with -32022',
  );
  assert.deepEqual(selectionError?.data?.supported, [MODERN_PROTOCOL_VERSION]);

  const pinnedSession = startSession(t);
  // A request that is not `server/discover` is what selects the era.
  const selecting = await exchange(pinnedSession, modernRequest(1, 'tools/list'));
  assert.ok(advertisedTools(selecting).length > 0, 'the connection was never selected onto 2026-07-28');

  const before = pinnedSession.stdoutLines().length;
  pinnedSession.send(modernRequest(2, 'tools/list', {}, { protocolVersion: '1999-01-01' }));
  await pinnedSession.waitForStdoutLines(before + 1);
  await pinnedSession.settle(400);
  const answers = pinnedSession
    .stdoutLines()
    .slice(before)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  // Exactly one terminal response for that id: the refusal is written in place
  // of the request, never alongside an answer to it.
  assert.equal(
    answers.length,
    1,
    `an unsupported revision after the era was selected produced ${String(answers.length)} messages: ${JSON.stringify(answers).slice(0, 400)}`,
  );
  const afterSelection = answers[0];
  assert.equal(
    afterSelection.result,
    undefined,
    'a request claiming an unsupported revision was served after the era was selected',
  );
  const refusalError = afterSelection.error as { code?: number; data?: Record<string, unknown> } | undefined;
  assert.equal(refusalError?.code, -32022, 'an unsupported revision on a later request must be refused with -32022');
  assert.deepEqual(
    refusalError?.data?.supported,
    [MODERN_PROTOCOL_VERSION],
    'the refusal must report the revisions this server does support',
  );
  assert.equal(refusalError?.data?.requested, '1999-01-01', 'the refusal must name the revision that was claimed');

  // One fault, one error shape: the later refusal is indistinguishable from
  // the one the era-selecting request produces, down to the message text and
  // the key order of `data`.
  assert.equal(
    JSON.stringify(refusalError),
    JSON.stringify(selectionError),
    'the refusal on a later request differs from the refusal on the era-selecting request',
  );

  // Positive control on the same connection: a supported revision is still
  // served, so what was refused is the claimed revision and not the connection.
  const served = await exchange(pinnedSession, modernRequest(3, 'tools/list'));
  assert.ok(advertisedTools(served).length > 0, 'a supported revision was refused on the same connection');

  // Positive control that only the version VALUE check was added: envelope
  // SHAPE faults still answer -32602 on the very same connection.
  const malformed = await exchange(pinnedSession, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/list',
    params: {
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
        [CLIENT_CAPABILITIES_META_KEY]: 'not-an-object',
        [CLIENT_INFO_META_KEY]: { name: 'era-matrix-client', version: '1.0.0' },
      },
    },
  });
  assert.equal(
    (malformed.error as { code?: number } | undefined)?.code,
    -32602,
    'a malformed reserved envelope must stay -32602 and must not be reported as an unsupported revision',
  );
});

test('a 2025-era connection still serves a request whose reserved claim names a revision the server does not support', async (t) => {
  // `_meta` is opaque on a 2025-era connection: a server that started refusing
  // members it does not recognise would break legacy clients. The per-request
  // revision check belongs to 2026-07-28 traffic only, so the very claim that
  // is refused above must be served here.
  const legacySession = startSession(t);
  await openLegacyConnection(legacySession, { protocolVersion: '2025-06-18' });
  const listed = await exchange(
    legacySession,
    modernRequest(2, 'tools/list', {}, { protocolVersion: '1999-01-01' }),
  );

  assert.equal(
    listed.error,
    undefined,
    `a 2025-era connection refused an unrecognised _meta member: ${JSON.stringify(listed.error)}`,
  );
  assert.ok(advertisedTools(listed).length > 0, 'the 2025-era connection stopped serving its catalogue');

  // Positive control on the same executable and the same claim: on a
  // connection selected onto 2026-07-28 it is refused. The two halves together
  // show the difference is the era and not the request.
  const modernSession = startSession(t);
  await exchange(modernSession, modernRequest(1, 'tools/list'));
  const refused = await exchange(
    modernSession,
    modernRequest(2, 'tools/list', {}, { protocolVersion: '1999-01-01' }),
  );
  assert.equal(
    (refused.error as { code?: number } | undefined)?.code,
    -32022,
    'the same claim was not refused on a 2026-07-28 connection, so the legacy half proves nothing',
  );
});

test('a hybrid opening leaves the connection on the 2025 era, so a later unsupported reserved claim is still served', async (t) => {
  // The reserved claims are stripped from a hybrid opening before anything
  // else reads it, so the era is decided from the rewritten message. This is
  // what keeps a client that stamps 2026-07-28 claims onto a 2025-era
  // handshake out of the per-request revision check for the rest of its
  // connection.
  const session = startSession(t);
  const opening = legacyOpening(1, {
    protocolVersion: '2025-06-18',
    meta: {
      [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
      [CLIENT_CAPABILITIES_META_KEY]: {},
      [CLIENT_INFO_META_KEY]: { name: 'hybrid-client', version: '1.0.0' },
    },
  });
  const negotiated = await exchange(session, opening);
  assert.equal(
    (negotiated.result as Record<string, unknown> | undefined)?.protocolVersion,
    '2025-06-18',
    'the hybrid opening was not served as a 2025-era handshake',
  );
  session.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const listed = await exchange(session, modernRequest(2, 'tools/list', {}, { protocolVersion: '1999-01-01' }));
  assert.equal(
    listed.error,
    undefined,
    `a hybrid-opened 2025-era connection refused an unsupported reserved claim: ${JSON.stringify(listed.error)}`,
  );
  assert.ok(advertisedTools(listed).length > 0, 'the hybrid-opened connection stopped serving its catalogue');
});

/**
 * One `2026-07-28` notification: the reserved envelope with no `id`. Sent as
 * the opening frame of a connection, this is what `serveStdio` pins the
 * connection to 2026-07-28 on.
 */
function modernNotification(protocolVersion: string = MODERN_PROTOCOL_VERSION): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: { progressToken: 'era-probe', progress: 1, _meta: modernMeta({ protocolVersion }) },
  };
}

test('a 2026-07-28 notification pins the connection, so a later unsupported claim is refused and never reaches the plugin', async (t) => {
  const { session, plugin } = await startWithPlugin(t);
  // Nothing has been sent on stdio yet, so wait for the adapter's own startup
  // line instead of an answered request: the plugin listener is open by the
  // time it is written, and the opening frame below has no answer to wait for.
  await waitUntil(
    () => session.stderrText().includes('MCP server connected over stdio.'),
    'the adapter to report that it is serving, which is after its plugin listener opens',
  );
  await plugin.connect();
  await waitUntil(
    () => plugin.requests('revoke_scope').length >= 1,
    'the scope revocation that starts every authenticated plugin session',
  );
  const framesAfterAuthentication = plugin.frames.length;

  // The opening frame is a notification, not a request. `serveStdio` classifies
  // it from its body like any other opening message and pins the connection to
  // 2026-07-28; only its `server/discover` probe branch returns early on a
  // notification, and no probe is open here. A notification is never answered,
  // so silence is the correct observation.
  const answers = await exchangeExpectingSilence(session, modernNotification());
  assert.deepEqual(answers, [], 'a notification was answered on the wire');

  // On that pinned connection this names a real tool with valid arguments, so
  // nothing but the per-request revision check stands between it and Blockbench.
  const refused = await exchange(
    session,
    modernRequest(2, 'tools/call', { name: 'get_project_state', arguments: {} }, { protocolVersion: '2099-01-01' }),
  );
  assert.equal(refused.result, undefined, 'the tool ran on a connection pinned to a revision it does not serve');
  const error = refused.error as { code?: number; data?: Record<string, unknown> } | undefined;
  assert.equal(error?.code, -32022);
  assert.deepEqual(error?.data, { supported: [MODERN_PROTOCOL_VERSION], requested: '2099-01-01' });

  await session.settle(300);
  assert.equal(
    plugin.frames.length,
    framesAfterAuthentication,
    `the refused request reached Blockbench: ${JSON.stringify(plugin.frames.slice(framesAfterAuthentication))}`,
  );

  // Positive control on the same channel: the supported revision is served and
  // does reach the plugin, so the silence above is not a dead connection.
  const accepted = exchange(session, modernRequest(3, 'tools/call', { name: 'get_project_state', arguments: {} }));
  await waitUntil(
    () => plugin.requests('get_project_state').length >= 1,
    'the accepted tool call that proves the plugin observation channel is live',
  );
  await accepted;
});

test('a legacy initialize after a 2026-07-28 notification does not reopen the era or disarm the revision check', async (t) => {
  const session = startSession(t);
  await exchangeExpectingSilence(session, modernNotification());

  // The connection is pinned to 2026-07-28, so the dependency answers this
  // 2025-era handshake with its own refusal instead of negotiating one.
  const handshake = await exchange(session, legacyOpening(1, { protocolVersion: '2025-06-18' }));
  assert.equal(handshake.result, undefined, 'a 2025-era handshake was negotiated on a connection pinned modern');
  assert.equal((handshake.error as { code?: number } | undefined)?.code, -32022);

  // The refused handshake must not have talked the connection back down to the
  // 2025 era: the per-request revision check is still armed.
  const later = await exchange(session, modernRequest(2, 'tools/list', {}, { protocolVersion: '2099-01-01' }));
  assert.equal(later.result, undefined, 'the revision check was disarmed by a legacy initialize');
  assert.equal((later.error as { code?: number } | undefined)?.code, -32022);
});
