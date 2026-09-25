// The tool contract is the same contract whichever MCP wire era carries it.
//
// A 2026-07-28 result is wrapped differently from a 2025-era one: it carries
// `resultType`, a reserved `_meta` server identity, and on the cacheable
// surfaces `ttlMs`/`cacheScope`. Nothing inside the tool contract may change
// with it — not the catalogue, not a schema, not the JSON text envelope, not
// an `E_*` code, not which of the two validation layers answers.
//
// Every test here runs the same exchange on a legacy connection and on a
// modern one and compares the two directly, so a difference is reported as a
// difference rather than as two separately recorded expectations.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { TestContext } from 'node:test';

import {
  advertisedTools,
  envelopeOf,
  errorCodeOf,
  exchange,
  legacyRequest,
  modernRequest,
  openLegacyConnection,
} from './helpers/mcp-era-wire.ts';
import { CLI_ENTRY_PATH, startRawStdioServer } from './helpers/raw-stdio.ts';
import type { RawStdioSession } from './helpers/raw-stdio.ts';
import { createRuntimeRoot, removeRuntimeRoot } from './helpers/runtime-root.ts';
import { WireFakePlugin, waitUntil } from './helpers/wire-plugin.ts';

assert.ok(
  existsSync(CLI_ENTRY_PATH),
  `the built executable is missing at ${CLI_ENTRY_PATH}; run \`npm run build\` before this suite`,
);

const SECRET = 'tool-contract-dual-era-secret-1357';
let nextPort = 42_300;

function allocatePort(): number {
  const port = nextPort++;
  assert.ok(port <= 42_399, 'the dual-era tool contract tests must stay inside the reserved 42300-42399 port range');
  return port;
}

type Era = 'legacy' | 'modern';
const ERAS: readonly Era[] = ['legacy', 'modern'];

/**
 * One connection per era. `request` frames a request the way that era does, so
 * a caller writes the exchange once and both arms run it.
 */
interface EraConnection {
  era: Era;
  session: RawStdioSession;
  request(id: number | string, method: string, params?: Record<string, unknown>): Record<string, unknown>;
}

interface EraOptions {
  /** Adapter mode; `brokered` with no reachable broker is a setup-failure state. */
  mode?: 'direct' | 'brokered';
  /** Attach a fake Blockbench plugin on a private port. */
  withPlugin?: boolean;
}

interface EraWorld {
  connection: EraConnection;
  plugin: WireFakePlugin | null;
}

async function openEra(t: TestContext, era: Era, options: EraOptions = {}): Promise<EraWorld> {
  const mode = options.mode ?? 'direct';
  const root = await mkdtemp(join(tmpdir(), `blockbench-mcp-tool-contract-${era}-`));
  const runtimeRoot = await createRuntimeRoot('bbtc-');
  const env: Record<string, string> = {
    XDG_RUNTIME_DIR: runtimeRoot,
    BLOCKBENCH_MCP_REQUEST_TIMEOUT_MS: '5000',
  };
  let plugin: WireFakePlugin | null = null;
  if (options.withPlugin === true) {
    const port = allocatePort();
    const configPath = join(root, 'config.json');
    await writeFile(
      configPath,
      `${JSON.stringify({ version: 1, mode: 'shared-secret', port, secret: SECRET }, null, 2)}\n`,
      { mode: 0o600 },
    );
    env.BLOCKBENCH_MCP_CONFIG = configPath;
    plugin = new WireFakePlugin({ port, secret: SECRET });
  }
  if (mode === 'brokered') env.BLOCKBENCH_MCP_BROKER = '1';

  const session = startRawStdioServer({ args: mode === 'direct' ? ['--direct'] : [], env });
  t.after(async () => {
    if (plugin !== null) await plugin.close();
    await session.dispose();
    await rm(root, { recursive: true, force: true });
    await removeRuntimeRoot(runtimeRoot);
  });

  if (era === 'legacy') {
    await openLegacyConnection(session, { protocolVersion: '2025-06-18' });
  } else {
    // A request that is not `server/discover` is what pins the era.
    await exchange(session, modernRequest(1, 'tools/list'), 15_000);
  }
  if (plugin !== null) {
    await plugin.connect();
    await waitUntil(
      () => plugin!.requests('revoke_scope').length >= 1,
      'the scope revocation that starts every authenticated plugin session',
    );
  }

  const connection: EraConnection = {
    era,
    session,
    request: (id, method, params = {}) =>
      era === 'legacy' ? legacyRequest(id, method, params) : modernRequest(id, method, params),
  };
  return { connection, plugin };
}

/** Run the same exchange on both eras and return the two answers, keyed by era. */
async function onBothEras(
  t: TestContext,
  options: EraOptions,
  run: (world: EraWorld) => Promise<Record<string, unknown>>,
): Promise<Record<Era, Record<string, unknown>>> {
  const answers = {} as Record<Era, Record<string, unknown>>;
  for (const era of ERAS) {
    answers[era] = await run(await openEra(t, era, options));
  }
  return answers;
}

/** The result members a modern connection adds around an unchanged payload. */
const MODERN_RESULT_WRAPPERS: readonly string[] = ['resultType', 'ttlMs', 'cacheScope', '_meta'];

function payloadOf(message: Record<string, unknown>): Record<string, unknown> {
  const result = { ...(message.result as Record<string, unknown>) };
  for (const member of MODERN_RESULT_WRAPPERS) delete result[member];
  return result;
}

test('the advertised tool catalogue is identical on a legacy connection and on a 2026-07-28 connection', async (t) => {
  const answers = await onBothEras(t, {}, async ({ connection }) =>
    exchange(connection.session, connection.request(50, 'tools/list')),
  );
  const legacyTools = advertisedTools(answers.legacy);
  const modernTools = advertisedTools(answers.modern);

  assert.ok(legacyTools.length > 0, 'the legacy arm advertised no tools, so this comparison proves nothing');
  assert.deepEqual(
    modernTools.map((tool) => tool.name),
    legacyTools.map((tool) => tool.name),
    'the advertised tool order differs between the two eras',
  );
  assert.equal(
    JSON.stringify(modernTools),
    JSON.stringify(legacyTools),
    'the advertised catalogue differs between the two eras, down to the bytes: names, descriptions, schemas, ' +
      'strictness, and member order must all be era-independent',
  );
  // Positive control that the two answers really are from different eras.
  assert.equal((answers.modern.result as Record<string, unknown>).resultType, 'complete');
  assert.equal((answers.legacy.result as Record<string, unknown>).resultType, undefined);
});

/** Every array node under `node` that spells a tuple with `prefixItems`, keyed by JSON pointer. */
function prefixItemsNodes(node: unknown, pointer: string, found: Map<string, Record<string, unknown>>): void {
  if (Array.isArray(node)) {
    node.forEach((child, index) => prefixItemsNodes(child, `${pointer}/${index}`, found));
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const record = node as Record<string, unknown>;
  if (record.prefixItems !== undefined) found.set(pointer, record);
  for (const [key, value] of Object.entries(record)) prefixItemsNodes(value, `${pointer}/${key}`, found);
}

test('every advertised fixed-length tuple also carries a homogeneous items schema and its length bound on both eras', async (t) => {
  // A client that reads only `items` (draft-07 readers, function-calling front
  // ends) otherwise sees an array of anything and can send strings for numbers.
  const answers = await onBothEras(t, {}, async ({ connection }) =>
    exchange(connection.session, connection.request(55, 'tools/list')),
  );

  for (const era of ERAS) {
    const tuples = new Map<string, Record<string, unknown>>();
    for (const tool of advertisedTools(answers[era])) {
      prefixItemsNodes(tool.inputSchema, String(tool.name), tuples);
    }
    assert.ok(tuples.size > 0, `${era}: no tuple was advertised, so this check proves nothing`);
    for (const [pointer, tuple] of tuples) {
      const prefixItems = tuple.prefixItems as unknown[];
      assert.equal(tuple.type, 'array', `${era}: ${pointer} is not an array schema`);
      assert.ok(
        typeof tuple.items === 'object' && tuple.items !== null && !Array.isArray(tuple.items),
        `${era}: ${pointer} advertises prefixItems without an items schema`,
      );
      for (const [index, element] of prefixItems.entries()) {
        assert.deepEqual(element, tuple.items, `${era}: ${pointer}/prefixItems/${index} differs from items`);
      }
      assert.equal(tuple.minItems, prefixItems.length, `${era}: ${pointer} does not advertise minItems`);
      assert.equal(tuple.maxItems, prefixItems.length, `${era}: ${pointer} does not advertise maxItems`);
    }
    assert.deepEqual(
      tuples.get('create_cubes/properties/cubes/items/properties/from'),
      {
        type: 'array',
        prefixItems: [{ type: 'number' }, { type: 'number' }, { type: 'number' }],
        items: { type: 'number' },
        minItems: 3,
        maxItems: 3,
      },
      `${era}: create_cubes cube.from is not advertised as a three-number tuple`,
    );
  }
});

test('a successful tool call returns the same JSON text envelope on both eras', async (t) => {
  const answers = await onBothEras(t, {}, async ({ connection }) =>
    exchange(connection.session, connection.request(51, 'tools/call', { name: 'health', arguments: {} })),
  );
  const legacyEnvelope = envelopeOf(answers.legacy);
  const modernEnvelope = envelopeOf(answers.modern);

  assert.equal(legacyEnvelope.ok, true, 'the legacy health call did not succeed');
  assert.equal(modernEnvelope.ok, true, 'the modern health call did not succeed');
  assert.equal(legacyEnvelope.summary, modernEnvelope.summary, 'the envelope summary differs between eras');
  assert.deepEqual(
    Object.keys(modernEnvelope.result as Record<string, unknown>),
    Object.keys(legacyEnvelope.result as Record<string, unknown>),
    'the health payload member set differs between eras',
  );
  assert.deepEqual(payloadOf(answers.modern), payloadOf(answers.legacy), 'the tool result payload differs between eras');
});

test('a tool-domain failure keeps isError and its E_* code on both eras', async (t) => {
  const answers = await onBothEras(t, {}, async ({ connection }) =>
    exchange(connection.session, connection.request(52, 'tools/call', { name: 'get_project_state', arguments: {} })),
  );

  for (const era of ERAS) {
    const message = answers[era];
    assert.equal(message.error, undefined, `${era}: a tool-domain failure became a JSON-RPC error`);
    assert.equal((message.result as Record<string, unknown>).isError, true, `${era}: isError was not set`);
    assert.equal(errorCodeOf(envelopeOf(message)), 'E_PLUGIN_NOT_CONNECTED', `${era}: the E_* code changed`);
  }
  assert.deepEqual(
    payloadOf(answers.modern),
    payloadOf(answers.legacy),
    'a direct-mode disconnected-plugin failure is reported differently on the two eras',
  );
});

test('the dependency validation layer rejects a schema-invalid argument before the handler on both eras', async (t) => {
  const answers = await onBothEras(t, { withPlugin: true }, async ({ connection, plugin }) => {
    const answered = await exchange(
      connection.session,
      connection.request(53, 'tools/call', { name: 'read_file', arguments: { path: 123 } }),
    );
    await connection.session.settle(200);
    assert.deepEqual(
      plugin?.requests('read_file') ?? [],
      [],
      `${connection.era}: a schema-invalid argument reached Blockbench`,
    );
    // Positive control on the same plugin channel: a well-formed call does
    // reach it, so the absence above is about validation and not a dead plugin.
    const relayed = exchange(
      connection.session,
      connection.request(54, 'tools/call', { name: 'get_project_state', arguments: {} }),
    );
    await waitUntil(
      () => (plugin?.requests('get_project_state').length ?? 0) >= 1,
      `${connection.era}: the accepted tool call that proves the plugin channel is live`,
    );
    await relayed;
    return answered;
  });

  for (const era of ERAS) {
    const result = answers[era].result as Record<string, unknown>;
    assert.equal(answers[era].error, undefined, `${era}: dependency-layer validation became a JSON-RPC error`);
    assert.equal(result.isError, true, `${era}: dependency-layer validation did not set isError`);
    const text = (result.content as Array<{ text: string }>)[0].text;
    assert.match(
      text,
      /^Input validation error: Invalid arguments for tool read_file: /,
      `${era}: the dependency-layer rejection text lost its shape`,
    );
    assert.ok(!text.startsWith('{'), `${era}: dependency-layer validation answered with the handler envelope`);
  }
  assert.deepEqual(
    payloadOf(answers.modern),
    payloadOf(answers.legacy),
    'the dependency validation layer answers differently on the two eras',
  );
});

test('the handler validation layer answers E_INVALID_PARAMS with its issue details on both eras', async (t) => {
  const answers = await onBothEras(t, {}, async ({ connection }) =>
    exchange(
      connection.session,
      connection.request(55, 'tools/call', { name: 'validate_geckolib_file', arguments: {} }),
    ),
  );

  for (const era of ERAS) {
    const envelope = envelopeOf(answers[era]);
    assert.equal(envelope.ok, false, `${era}: the refined-schema rejection reported success`);
    assert.equal(errorCodeOf(envelope), 'E_INVALID_PARAMS', `${era}: the handler-layer E_* code changed`);
    const details = (envelope.error as { details?: unknown[] }).details ?? [];
    assert.ok(details.length > 0, `${era}: the handler-layer rejection carried no issue details`);
    assert.equal(envelope.command, 'validate_geckolib_file', `${era}: the envelope named a different command`);
  }
  assert.deepEqual(
    payloadOf(answers.modern),
    payloadOf(answers.legacy),
    'the handler validation layer answers differently on the two eras',
  );
});

test('the two validation layers stay on their own sides of the boundary on both eras', async (t) => {
  // The advertised schema accepts `{}` for this tool; only the refinement the
  // handler re-runs rejects it. The pair below proves the boundary has not
  // moved: one input is caught by the dependency, the other by the handler,
  // and each answers in its own shape.
  const answers = await onBothEras(t, {}, async ({ connection }) => {
    const dependencyLayer = await exchange(
      connection.session,
      connection.request(56, 'tools/call', { name: 'set_cube_uv', arguments: { uuid: 42 } }),
    );
    const handlerLayer = await exchange(
      connection.session,
      connection.request(57, 'tools/call', { name: 'set_cube_uv', arguments: { uuid: 'cube-uuid' } }),
    );
    return { dependencyLayer, handlerLayer };
  });

  for (const era of ERAS) {
    const { dependencyLayer, handlerLayer } = answers[era] as unknown as {
      dependencyLayer: Record<string, unknown>;
      handlerLayer: Record<string, unknown>;
    };
    const dependencyText = ((dependencyLayer.result as Record<string, unknown>).content as Array<{ text: string }>)[0]
      .text;
    assert.match(
      dependencyText,
      /^Input validation error: Invalid arguments for tool set_cube_uv: /,
      `${era}: the dependency layer stopped catching a schema-invalid argument`,
    );
    assert.equal(
      errorCodeOf(envelopeOf(handlerLayer)),
      'E_INVALID_PARAMS',
      `${era}: the handler layer stopped catching what the advertised schema accepts`,
    );
  }
});

test('an unknown tool is a JSON-RPC -32602 protocol error on both eras', async (t) => {
  const answers = await onBothEras(t, {}, async ({ connection }) =>
    exchange(
      connection.session,
      connection.request(58, 'tools/call', { name: 'not_a_registered_tool', arguments: {} }),
    ),
  );

  for (const era of ERAS) {
    assert.equal(answers[era].result, undefined, `${era}: an unknown tool was answered with a result`);
    const error = answers[era].error as { code?: number; message?: string } | undefined;
    assert.equal(error?.code, -32602, `${era}: an unknown tool must be a -32602 protocol error`);
    assert.match(String(error?.message), /not_a_registered_tool/, `${era}: the error did not name the unknown tool`);
  }
  assert.deepEqual(answers.modern.error, answers.legacy.error, 'the unknown-tool error differs between eras');
});

test('a brokered setup failure is reported through the same health envelope on both eras', async (t) => {
  const answers = await onBothEras(t, { mode: 'brokered' }, async ({ connection }) =>
    exchange(connection.session, connection.request(59, 'tools/call', { name: 'health', arguments: {} }), 15_000),
  );

  for (const era of ERAS) {
    const envelope = envelopeOf(answers[era]);
    const result = envelope.result as Record<string, unknown>;
    assert.equal(envelope.ok, true, `${era}: health failed instead of reporting the setup error`);
    assert.equal(result.mode, 'brokered', `${era}: the adapter did not report brokered mode`);
    assert.equal(result.broker_connected, false, `${era}: a broker was unexpectedly reachable`);
    assert.deepEqual(
      (result.setup_errors as Array<{ code: string }>).map((issue) => issue.code),
      ['E_SECRET_MISSING'],
      `${era}: the brokered setup failure changed shape`,
    );
  }
  assert.deepEqual(
    payloadOf(answers.modern),
    payloadOf(answers.legacy),
    'a brokered setup failure is reported differently on the two eras',
  );
});

test('a tool call answered by a connected plugin returns plugin-generated content on both eras', async (t) => {
  const answers = await onBothEras(t, { withPlugin: true }, async ({ connection, plugin }) => {
    const answered = await exchange(
      connection.session,
      connection.request(60, 'tools/call', { name: 'get_project_state', arguments: {} }),
    );
    assert.ok(
      (plugin?.requests('get_project_state').length ?? 0) >= 1,
      `${connection.era}: the call never reached the plugin`,
    );
    return answered;
  });

  for (const era of ERAS) {
    const envelope = envelopeOf(answers[era]);
    assert.equal(envelope.ok, true, `${era}: a plugin-answered call did not succeed`);
    assert.equal((answers[era].result as Record<string, unknown>).isError, undefined, `${era}: isError was set`);
  }
  const legacyResult = envelopeOf(answers.legacy).result as Record<string, unknown>;
  const modernResult = envelopeOf(answers.modern).result as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(modernResult),
    Object.keys(legacyResult),
    'the plugin-generated payload shape differs between eras',
  );
});
