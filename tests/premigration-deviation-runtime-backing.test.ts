// Executable backing for the runtime claims the accepted-deviation ledger makes.
//
// `tests/premigration-accepted-deviations.ts` justifies several entries with a
// sentence beginning "Measured:" — a statement about what the current build
// does at runtime, not about what it advertises. The frozen corpus cannot check
// those: it records advertisements and recorded responses, and each of these
// claims is about a call the recording never made. Left alone they are prose,
// and prose is what a reviewer has to take on trust.
//
// Every such claim is made here against the built executable, at the exact
// pointer the entry names, and each test records the entry it backs. The
// control at the end then requires every escalated entry to carry backing, so a
// future entry cannot be added to the ledger on prose alone.
//
// Two entries are backed by named assertions in
// `tests/premigration-wire-baseline.test.ts` rather than here: the member-order
// entry, whose claim is about serialization and is held by the byte-identity
// and property-order assertions there, and the `health` strictness entry, whose
// live probe already lives there. Those are declared as delegated backing and
// the assertion names are checked against that file's source, so renaming one
// fails here instead of quietly leaving the entry unbacked.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { TestContext } from 'node:test';

import {
  ACCEPTED_DEVIATIONS,
  ESCALATED_DEVIATION_IDS,
  ESCALATED_DEVIATION_NOTES,
} from './premigration-accepted-deviations.ts';
import { envelopeOf, exchange, legacyRequest, openLegacyConnection } from './helpers/mcp-era-wire.ts';
import { CLI_ENTRY_PATH, REPO_ROOT, startRawStdioServer } from './helpers/raw-stdio.ts';
import type { RawStdioSession } from './helpers/raw-stdio.ts';
import { createRuntimeRoot, removeRuntimeRoot } from './helpers/runtime-root.ts';
import { WireFakePlugin, waitUntil } from './helpers/wire-plugin.ts';

assert.ok(
  existsSync(CLI_ENTRY_PATH),
  `the built executable is missing at ${CLI_ENTRY_PATH}; run \`npm run build\` before this suite`,
);

const SECRET = 'deviation-runtime-backing-secret-8642';
let nextPort = 42_600;

function allocatePort(): number {
  const port = nextPort++;
  assert.ok(port <= 42_649, 'the deviation runtime-backing tests must stay inside the reserved 42600-42649 port range');
  return port;
}

// ---------------------------------------------------------------------------
// The backing register
// ---------------------------------------------------------------------------

type BackingKind = 'measured-here' | 'delegated';

interface Backing {
  /** The ledger claim this backing is responsible for, in one line. */
  claim: string;
  kind: BackingKind;
  /**
   * For delegated backing, the test names in
   * `tests/premigration-wire-baseline.test.ts` that carry the claim.
   */
  delegatedTo?: readonly string[];
}

/** Which ledger entry each executable claim belongs to, filled in as tests run. */
const proven = new Map<string, string>();

function recordProven(deviationId: string, observation: string): void {
  proven.set(deviationId, observation);
}

const ADDITIONAL_PROPERTIES_ID = 'non-strict-nested-object-stops-advertising-additional-properties-false';
const SAFE_INTEGER_ID = 'safe-integer-upper-bound-advertised-on-integer-property';
const ONE_OF_ID = 'discriminated-union-advertised-as-one-of';
const NUMERIC_UNION_ID = 'numeric-literal-union-advertised-as-any-of-const';
const PROPERTY_NAMES_ID = 'record-key-schema-advertised-as-property-names';
const TUPLE_ID = 'fixed-length-tuple-advertised-with-prefix-items';
const MEMBER_ORDER_ID = 'advertised-schema-member-order-changed';
const HEALTH_STRICT_ID = 'no-parameter-tool-health-now-rejects-unrecognized-arguments';
const PACKAGE_VERSION_ID = 'reported-package-version-is-0-2-0';

/**
 * Every ledger entry whose justification rests on runtime behaviour, and where
 * that behaviour is asserted. Adding an escalated entry to the ledger without
 * adding a row here fails the control at the end of this file.
 */
const RUNTIME_BACKING: ReadonlyMap<string, Backing> = new Map<string, Backing>([
  [
    ADDITIONAL_PROPERTIES_ID,
    {
      claim: 'an unrecognized member inside cubes[0].rotation of create_cubes is still accepted and relayed',
      kind: 'measured-here',
    },
  ],
  [
    SAFE_INTEGER_ID,
    {
      claim: 'set_texture_resolution with width 1e300 is now rejected against the safe-integer ceiling',
      kind: 'measured-here',
    },
  ],
  [
    ONE_OF_ID,
    {
      claim: 'an assign_texture source carrying both branches’ payloads is rejected',
      kind: 'measured-here',
    },
  ],
  [
    NUMERIC_UNION_ID,
    {
      claim: 'the permitted per-face rotation set is unchanged: 90 is accepted and 45 is rejected',
      kind: 'measured-here',
    },
  ],
  [
    PROPERTY_NAMES_ID,
    {
      claim: 'an unrecognized set_cube_uv faces key is still rejected and the six permitted keys still pass',
      kind: 'measured-here',
    },
  ],
  [
    TUPLE_ID,
    {
      claim: 'a fourth element in a three-element tuple is still rejected under the 2020-12 prefixItems spelling',
      kind: 'measured-here',
    },
  ],
  [
    MEMBER_ORDER_ID,
    {
      claim: 'member order carries no protocol meaning, while property-name order and unrewritten bytes stay pinned',
      kind: 'delegated',
      delegatedTo: [
        'the JSON property order emitted on the wire still matches the recording',
        'the order of the property names inside every advertised tool input schema is unchanged',
      ],
    },
  ],
  [
    HEALTH_STRICT_ID,
    {
      claim: 'tools/call health with an undeclared argument key is now rejected by the dependency validation layer',
      kind: 'delegated',
      delegatedTo: [
        'tools/call health rejects an unrecognized argument key, which the accepted deviation ledger declares and the corpus does not record',
      ],
    },
  ],
  [
    PACKAGE_VERSION_ID,
    {
      claim:
        'the reported package version at every declared serverInfo.version and health adapter_version site is what the current build actually emits, not merely what the ledger says it must be',
      kind: 'delegated',
      delegatedTo: [
        'every accepted wire deviation is still exercised, at exactly the recorded locations it declares',
        'the accepted wire deviation ledger applies nothing it has not declared',
      ],
    },
  ],
]);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface BackingWorld {
  session: RawStdioSession;
  plugin: WireFakePlugin;
}

/** The built executable in direct mode with a fake Blockbench plugin attached. */
async function startWorld(t: TestContext): Promise<BackingWorld> {
  const port = allocatePort();
  const root = await mkdtemp(join(tmpdir(), 'blockbench-mcp-deviation-backing-'));
  const runtimeRoot = await createRuntimeRoot('bbdrb-');
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

  await openLegacyConnection(session, { protocolVersion: '2025-06-18' });
  await plugin.connect();
  await waitUntil(
    () => plugin.requests('revoke_scope').length >= 1,
    'the scope revocation that starts every authenticated plugin session',
  );
  return { session, plugin };
}

let nextRequestId = 1;

async function callTool(
  session: RawStdioSession,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return await exchange(session, legacyRequest(nextRequestId++, 'tools/call', { name, arguments: args }));
}

/**
 * The dependency validation layer's rejection text for this call, or null if
 * the call got past that layer.
 *
 * The two layers answer in different shapes: the dependency layer produces a
 * bare `Input validation error: …` string, while the handler layer and the
 * plugin produce the JSON text envelope. Telling them apart is what makes
 * "rejected" mean rejected by the advertised schema rather than by anything
 * further in.
 */
function dependencyLayerRejection(message: Record<string, unknown>): string | null {
  const result = message.result as { isError?: unknown; content?: Array<{ text?: unknown }> } | undefined;
  if (result?.isError !== true) return null;
  const text = result.content?.[0]?.text;
  if (typeof text !== 'string' || !text.startsWith('Input validation error: ')) return null;
  return text;
}

// ---------------------------------------------------------------------------
// The measured claims
// ---------------------------------------------------------------------------

test('an unrecognized member inside a create_cubes rotation is still accepted and relayed, so dropping additionalProperties changed no enforcement', async (t) => {
  const { session, plugin } = await startWorld(t);

  const accepted = await callTool(session, 'create_cubes', {
    cubes: [
      {
        from: [0, 0, 0],
        to: [1, 1, 1],
        rotation: { axis: 'y', angle: 45, this_member_is_not_declared: 'kept out of the schema on purpose' },
      },
    ],
  });

  assert.equal(
    dependencyLayerRejection(accepted),
    null,
    'an unrecognized member inside cubes[0].rotation was rejected, so the ledger entry that says the recorded ' +
      'additionalProperties: false over-stated what the server enforces no longer holds',
  );
  await waitUntil(() => plugin.requests('create_cubes').length === 1, 'the accepted create_cubes to reach the plugin');

  // The non-strict object strips the member rather than forwarding it, which is
  // the behaviour the ledger describes: unknown members are dropped, not
  // refused and not relayed.
  const relayed = plugin.requests('create_cubes')[0].params as {
    cubes?: Array<{ rotation?: Record<string, unknown> }>;
  };
  const rotation = relayed.cubes?.[0]?.rotation ?? {};
  assert.deepEqual(Object.keys(rotation).sort(), ['angle', 'axis'], 'the relayed rotation changed shape');

  // Control on the same connection: the enclosing cube object IS strict, so an
  // unrecognized member one level out is refused. Without this the assertion
  // above could pass on a build that validates nothing at all.
  const refused = await callTool(session, 'create_cubes', {
    cubes: [{ from: [0, 0, 0], to: [1, 1, 1], this_member_is_not_declared: true }],
  });
  assert.match(
    String(dependencyLayerRejection(refused)),
    /Unrecognized key/,
    'an unrecognized member on the strict cube object was accepted, so this check cannot tell strict from non-strict',
  );
  assert.equal(plugin.requests('create_cubes').length, 1, 'the refused call must not have been relayed');

  recordProven(ADDITIONAL_PROPERTIES_ID, 'create_cubes cubes[0].rotation accepted the undeclared member and relayed');
});

test('set_texture_resolution rejects a width above the safe-integer ceiling that the recorded build accepted', async (t) => {
  const { session, plugin } = await startWorld(t);

  const rejected = await callTool(session, 'set_texture_resolution', { width: 1e300, height: 64 });
  const text = dependencyLayerRejection(rejected);

  assert.ok(
    text !== null,
    'a width of 1e300 was accepted. The ledger records this as a runtime narrowing the migration introduced, ' +
      'not as an advertisement-only change, so it must still be refused.',
  );
  assert.match(
    text,
    /9007199254740991/,
    `the rejection did not name the safe-integer ceiling it is supposed to enforce: ${text}`,
  );
  assert.equal(plugin.requests('set_texture_resolution').length, 0, 'the rejected width reached the plugin');

  // Control: an ordinary width passes the same layer and is relayed, so the
  // rejection above is about the value and not about the tool.
  const accepted = await callTool(session, 'set_texture_resolution', { width: 64, height: 64 });
  assert.equal(dependencyLayerRejection(accepted), null, 'an ordinary width was rejected too');
  await waitUntil(
    () => plugin.requests('set_texture_resolution').length === 1,
    'the accepted set_texture_resolution to reach the plugin',
  );

  recordProven(SAFE_INTEGER_ID, 'set_texture_resolution width 1e300 refused against the safe-integer ceiling');
});

test('an assign_texture source carrying both union branches is rejected, so the branches really are mutually exclusive', async (t) => {
  const { session, plugin } = await startWorld(t);

  const rejected = await callTool(session, 'assign_texture', {
    source: { kind: 'path', path: 'textures/block.png', data_url: 'data:image/png;base64,iVBORw0KGgo=' },
    apply_to: 'all',
  });
  assert.ok(
    dependencyLayerRejection(rejected) !== null,
    'a source carrying both branches’ payloads was accepted. The ledger moves this union from anyOf to oneOf ' +
      'on the grounds that at most one branch can ever match, and that only holds while a value like this is refused.',
  );
  assert.equal(plugin.requests('assign_texture').length, 0, 'the ambiguous source reached the plugin');

  // Control: each branch on its own is accepted and relayed, so the refusal
  // above is about carrying both and not about the tool being unusable.
  for (const source of [
    { kind: 'path', path: 'textures/block.png' },
    { kind: 'data_url', data_url: 'data:image/png;base64,iVBORw0KGgo=' },
  ]) {
    const accepted = await callTool(session, 'assign_texture', { source, apply_to: 'all' });
    assert.equal(
      dependencyLayerRejection(accepted),
      null,
      `the ${String(source.kind)} branch on its own was rejected: ${JSON.stringify(source)}`,
    );
  }
  await waitUntil(() => plugin.requests('assign_texture').length === 2, 'both single-branch calls to reach the plugin');

  recordProven(ONE_OF_ID, 'assign_texture source carrying both branch payloads refused, each branch alone accepted');
});

test('a fourth element in a three-element tuple is still rejected, which prefixItems alone no longer advertises', async (t) => {
  const { session, plugin } = await startWorld(t);

  // The advertisement moved to the 2020-12 `prefixItems` spelling. This is the
  // assertion that the enforced length did not move with it.
  const tooLong = await callTool(session, 'create_cubes', {
    cubes: [{ from: [0, 0, 0, 0], to: [1, 1, 1] }],
  });
  assert.ok(
    dependencyLayerRejection(tooLong) !== null,
    'a four-element value was accepted for a three-element tuple, so runtime length enforcement was lost along ' +
      'with the draft-07 tuple spelling',
  );
  const tooShort = await callTool(session, 'create_cubes', { cubes: [{ from: [0, 0], to: [1, 1, 1] }] });
  assert.ok(dependencyLayerRejection(tooShort) !== null, 'a two-element value was accepted for a three-element tuple');
  assert.equal(plugin.requests('create_cubes').length, 0, 'a wrong-length tuple reached the plugin');

  // Control: exactly three elements pass and are relayed.
  const exact = await callTool(session, 'create_cubes', { cubes: [{ from: [0, 0, 0], to: [1, 1, 1] }] });
  assert.equal(dependencyLayerRejection(exact), null, 'a three-element tuple was rejected');
  await waitUntil(() => plugin.requests('create_cubes').length === 1, 'the well-formed create_cubes to reach the plugin');

  recordProven(TUPLE_ID, 'create_cubes from with four and with two elements refused, three accepted');
});

test('the permitted per-face texture rotation set is unchanged: a quarter turn is accepted and 45 degrees is rejected', async (t) => {
  const { session } = await startWorld(t);

  for (const rotation of [0, 90, 180, 270]) {
    const accepted = await callTool(session, 'set_cube_uv', {
      uuid: 'cube-uuid',
      faces: { north: { uv: [0, 0, 4, 4], rotation } },
    });
    assert.equal(
      dependencyLayerRejection(accepted),
      null,
      `a permitted quarter-turn rotation ${String(rotation)} was rejected, so the branch list is not equivalent ` +
        'to the recorded enum',
    );
  }
  const refused = await callTool(session, 'set_cube_uv', {
    uuid: 'cube-uuid',
    faces: { north: { uv: [0, 0, 4, 4], rotation: 45 } },
  });
  assert.ok(
    dependencyLayerRejection(refused) !== null,
    'rotation 45 was accepted, so advertising the union branch by branch widened what the server takes',
  );

  recordProven(NUMERIC_UNION_ID, 'set_cube_uv face rotations 0/90/180/270 accepted and 45 refused');
});

test('the set_cube_uv faces record still takes exactly the six named faces and rejects any other key', async (t) => {
  const { session } = await startWorld(t);

  for (const face of ['north', 'south', 'east', 'west', 'up', 'down']) {
    const accepted = await callTool(session, 'set_cube_uv', {
      uuid: 'cube-uuid',
      faces: { [face]: { uv: [0, 0, 4, 4] } },
    });
    assert.equal(
      dependencyLayerRejection(accepted),
      null,
      `the permitted face key ${face} was rejected, so advertising the key type narrowed the permitted key set`,
    );
  }
  const refused = await callTool(session, 'set_cube_uv', {
    uuid: 'cube-uuid',
    faces: { northeast: { uv: [0, 0, 4, 4] } },
  });
  assert.ok(
    dependencyLayerRejection(refused) !== null,
    'an unrecognized faces key was accepted, so stating the key type alongside the enum lost the enforcement',
  );

  recordProven(PROPERTY_NAMES_ID, 'set_cube_uv faces accepted all six named keys and refused an unnamed one');
});

// ---------------------------------------------------------------------------
// The control
// ---------------------------------------------------------------------------

const BASELINE_TEST_SOURCE_PATH = join(REPO_ROOT, 'tests', 'premigration-wire-baseline.test.ts');

/** Every `test('…')` name declared in the parity oracle's source. */
function namedTestsInBaselineFile(): Set<string> {
  const source = readFileSync(BASELINE_TEST_SOURCE_PATH, 'utf8');
  const found = new Set<string>();
  for (const match of source.matchAll(/^test\((['"])(.*?)\1/gm)) found.add(match[2]);
  return found;
}

test('every escalated wire deviation is backed by an executable assertion rather than by its own prose', () => {
  const ledgerIds = new Set(ACCEPTED_DEVIATIONS.map((deviation) => deviation.id));

  // Nothing may claim to back an entry that does not exist.
  for (const id of RUNTIME_BACKING.keys()) {
    assert.ok(ledgerIds.has(id), `the backing register names ${id}, which is not an accepted deviation`);
  }

  const unbacked = [...ESCALATED_DEVIATION_IDS].filter((id) => !RUNTIME_BACKING.has(id)).sort();
  assert.deepEqual(
    unbacked,
    [],
    'these escalated deviations rest on prose alone. Every entry that carries no adjudicated authority has to ' +
      'be checkable: add an assertion here that observes the behaviour the entry claims, and register it in ' +
      'RUNTIME_BACKING, or withdraw the entry.',
  );

  const notProven: string[] = [];
  const missingDelegate: string[] = [];
  const baselineTestNames = namedTestsInBaselineFile();
  for (const [id, backing] of RUNTIME_BACKING) {
    if (backing.kind === 'measured-here') {
      if (!proven.has(id)) notProven.push(id);
      continue;
    }
    for (const name of backing.delegatedTo ?? []) {
      if (!baselineTestNames.has(name)) missingDelegate.push(`${id} -> ${name}`);
    }
  }
  assert.deepEqual(
    notProven,
    [],
    'these entries declare that their runtime claim is measured in this file, but the assertion that measures ' +
      'it did not run or did not record itself',
  );
  assert.deepEqual(
    missingDelegate,
    [],
    `these entries delegate their backing to a named assertion in ${BASELINE_TEST_SOURCE_PATH}, and that ` +
      'assertion no longer exists under that name',
  );
});

test('every recorded runtime note in the accepted-deviation ledger names a real entry that carries backing', () => {
  // `ESCALATED_DEVIATION_NOTES` is where the ledger writes down what it measured
  // about runtime behaviour. Reading it here is what stops it from being an
  // export nothing consumes: a note about an entry that does not exist, or
  // about a runtime claim nothing asserts, fails.
  const ledgerIds = new Set(ACCEPTED_DEVIATIONS.map((deviation) => deviation.id));
  const noteIds = Object.keys(ESCALATED_DEVIATION_NOTES).sort();

  assert.ok(noteIds.length > 0, 'the ledger records no runtime notes at all, so this control has nothing to check');
  for (const id of noteIds) {
    assert.ok(ledgerIds.has(id), `a runtime note is recorded for ${id}, which is not an accepted deviation`);
    assert.ok(
      ESCALATED_DEVIATION_NOTES[id].length > 0,
      `the runtime note recorded for ${id} is empty, so it states nothing that could be checked`,
    );
    assert.ok(
      RUNTIME_BACKING.has(id),
      `the ledger records a measured runtime note for ${id} but nothing asserts that behaviour. A note is a ` +
        'claim about the running build; it needs an assertion, not a sentence.',
    );
  }
});
