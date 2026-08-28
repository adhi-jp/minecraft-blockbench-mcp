// Replay of the frozen pre-migration wire corpus against the current build.
//
// Every input in `tests/fixtures/premigration/` is replayed against
// `dist/adapter/cli.js` over raw newline-delimited JSON-RPC, with the original
// request ids, the original ordering, and the original framing. The recorded
// responses are the oracle: if the executable answers differently, the parity
// assertion for that scenario fails and names the frozen file to inspect.
//
// MCP `2026-07-28` support changes a small, reviewed set of those recorded
// answers. The corpus stays immutable; instead the recorded expectation is
// rewritten through `tests/premigration-accepted-deviations.ts`, which states
// for each change what was recorded, what must appear now, and the authority
// for it. Every difference that ledger does not describe still fails here, and
// the controls at the end of this file fail if a ledger entry stops being
// exercised or starts applying somewhere it does not declare.
//
// The corpus is read from `tests/fixtures/premigration` unless
// BLOCKBENCH_MCP_BASELINE_FIXTURE_DIR names another directory, which lets a
// throwaway copy be corrupted on purpose to confirm these assertions are able
// to fail.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  INVENTORY_EXCLUDED_FILES,
  fixtureRoot,
  listScenarioNames,
  measureUnhandledTermination,
  programOf,
  readJsonFixture,
  readScenarioFixture,
  runScenarioProgram,
  scanNamedTests,
  sha256,
} from './helpers/premigration-baseline.ts';
import type {
  NamedTestInventory,
  ScenarioFixture,
  ScenarioObservation,
  TerminationKind,
  TerminationOutcome,
} from './helpers/premigration-baseline.ts';
import { CLI_ENTRY_PATH, REPO_ROOT, parseStdoutMessages } from './helpers/raw-stdio.ts';
import { REVIEWED_CONDITIONAL_SKIPS, TEST_FILE_FLOORS } from './named-test-floors.ts';
import {
  DECLARED_HOST_PLATFORM_SITES,
  MATRIX_PLATFORMS,
  PLATFORM_CAPABILITIES,
  declaredSiteKey,
  platformHasCapability,
  platformProvidesCapability,
  scanPlatformUse,
  scannedSourcesUnder,
} from './platform-capabilities.ts';
import type { PlatformSourceScan } from './platform-capabilities.ts';
import {
  ACCEPTED_DEVIATIONS,
  DeviationUsage,
  ESCALATED_DEVIATION_IDS,
  HEALTH_STRICT_ARGUMENTS_PROBE_KEY,
  HEALTH_STRICT_ARGUMENTS_PROBE_SITE,
  HEALTH_STRICT_ARGUMENTS_REJECTION_TEXT,
  HEALTH_STRICT_ID,
  applyAcceptedDeviationsToAdvertisedSchema,
  applyAcceptedDeviationsToRecordedExecutionMap,
  applyAcceptedDeviationsToRecordedMessage,
} from './premigration-accepted-deviations.ts';

const SHUTDOWN_LOG_PREFIX = '[minecraft-blockbench-mcp] Shutting down';

/**
 * Recorded messages whose exact bytes are still compared with the recording,
 * measured against the current build and the current ledger.
 *
 * Every message the accepted-deviation ledger rewrites is exempt from the byte
 * comparison, because the accepted change altered its bytes. This is the count
 * of everything that is not exempt, and it is pinned rather than floored so
 * that widening the ledger has to be a deliberate, visible edit here.
 */
const BYTE_IDENTITY_MESSAGE_COUNT = 23;

/**
 * `properties` maps compared across every advertised tool input schema,
 * measured the same way. The order of property names inside each of them is
 * what a model reads the parameters in, so losing one of these maps means the
 * order check silently covers less than it did.
 */
const ADVERTISED_PROPERTY_MAP_COUNT = 46;

/**
 * The recorded terminations the harness drives with a signal, and the signal it
 * sends for each. `stdin-eof` is deliberately absent: closing stdin is not a
 * signal, it works the same way everywhere, and it needs no control.
 */
const SIGNAL_TERMINATIONS: Readonly<Partial<Record<TerminationKind, NodeJS.Signals>>> = {
  sigint: 'SIGINT',
  sigterm: 'SIGTERM',
};

const scenarioNames = listScenarioNames();
const replays = new Map<string, Promise<ScenarioObservation>>();

/** One control child per signal, shared by every scenario that needs it. */
const terminationControls = new Map<string, Promise<TerminationOutcome>>();

/**
 * What this host does to a process that installs no handler, measured once per
 * signal. See `measureUnhandledTermination` for why the expectation is measured
 * rather than written down.
 */
function unhandledTermination(signal: NodeJS.Signals): Promise<TerminationOutcome> {
  let pending = terminationControls.get(signal);
  if (pending === undefined) {
    pending = measureUnhandledTermination(signal);
    terminationControls.set(signal, pending);
  }
  return pending;
}

/**
 * Replay one frozen scenario at most once per test run: several assertions read
 * different parts of the same recorded session, and each replay costs a child
 * process.
 */
function replay(name: string): Promise<ScenarioObservation> {
  let pending = replays.get(name);
  if (pending === undefined) {
    pending = runScenarioProgram(programOf(readScenarioFixture(name)));
    replays.set(name, pending);
  }
  return pending;
}

function fixtureOf(name: string): ScenarioFixture {
  return readScenarioFixture(name);
}

/**
 * One usage record shared by every assertion in this file. The tests below run
 * in declaration order in a single process, so by the time the controls at the
 * end run, every ledger entry that the corpus exercises has been recorded.
 */
const deviationUsage = new DeviationUsage();

/**
 * The recorded messages for one step, rewritten through the accepted-deviation
 * ledger into what must be observed now.
 */
function expectedMessages(fixture: ScenarioFixture, stepIndex: number): unknown[] {
  const step = fixture.steps[stepIndex];
  return step.expect.map((entry, messageIndex) =>
    applyAcceptedDeviationsToRecordedMessage(
      entry.message,
      {
        scenario: fixture.name,
        stepLabel: step.label,
        messageIndex,
        request: step.send,
        fixtureRoot: fixtureRoot(),
      },
      deviationUsage,
    ),
  );
}

/**
 * Whether the ledger rewrote a recorded message. A rewritten message can no
 * longer be held to its recorded byte identity, because the accepted change
 * altered its bytes; every other message still is.
 */
function ledgerRewroteMessage(fixture: ScenarioFixture, stepIndex: number, messageIndex: number): boolean {
  const recorded = fixture.steps[stepIndex].expect[messageIndex].message;
  const expected = expectedMessages(fixture, stepIndex)[messageIndex];
  return JSON.stringify(recorded) !== JSON.stringify(expected);
}

/**
 * Compare replayed stderr with the recording. Lines written during shutdown can
 * be lost when the process exits while the pipe still holds them, so a frozen
 * shutdown line is required to match only when the replay produced it. Every
 * line written before shutdown must match exactly.
 */
function assertStderrMatchesRecording(observed: readonly string[], frozen: readonly string[], scenario: string): void {
  const requiredCount = frozen.filter((line) => !line.startsWith(SHUTDOWN_LOG_PREFIX)).length;
  assert.ok(
    observed.length >= requiredCount,
    `${scenario}: expected at least ${String(requiredCount)} stderr line(s) before shutdown, saw ${String(observed.length)}: ${JSON.stringify(observed)}`,
  );
  for (let index = 0; index < Math.min(observed.length, frozen.length); index += 1) {
    assert.equal(observed[index], frozen[index], `${scenario}: stderr line ${String(index)} changed`);
  }
}

assert.ok(
  existsSync(CLI_ENTRY_PATH),
  `the built executable is missing at ${CLI_ENTRY_PATH}; run \`npm run build\` before this suite`,
);
assert.ok(scenarioNames.length > 0, `no frozen wire scenarios were found under ${fixtureRoot()}`);

for (const name of scenarioNames) {
  test(`recorded wire behaviour "${name}" is reproduced by the current build`, async () => {
    const fixture = fixtureOf(name);
    const observation = await replay(name);

    assert.deepEqual(
      observation.framingViolations,
      [],
      `${name}: stdout must stay one JSON-RPC object per line`,
    );

    fixture.steps.forEach((step, index) => {
      const observed = parseStdoutMessages(observation.stepMessages[index]);
      assert.deepEqual(
        observed,
        expectedMessages(fixture, index),
        `${name}: step ${String(index)} (${step.label}) no longer produces the recorded JSON-RPC message(s), ` +
          'and the difference is not one that tests/premigration-accepted-deviations.ts describes',
      );
    });

    assert.deepEqual(
      parseStdoutMessages(observation.trailingLines),
      fixture.termination.trailingStdoutMessages.map((entry) => entry.message),
      `${name}: ${fixture.termination.kind} must not produce stdout beyond what was recorded`,
    );
    // The recorded termination is two things under one name: `kind` is the
    // stimulus the harness applies, while `exitCode` and `signal` are the
    // outcome the recording platform observed after the adapter's own handler
    // ran. Where the stimulus cannot reach a handler at all, the recorded
    // outcome describes something that platform cannot produce. That gap is
    // declared as `posix-signal-delivery-to-a-child-process` in
    // `tests/platform-capabilities.ts`; everything else about the scenario —
    // the recorded messages, the absence of stdout after termination, the total
    // stdout count, the stderr written before shutdown — is held to the
    // recording on every platform, above and below this branch.
    const recordedOutcome = { exitCode: fixture.termination.exitCode, exitSignal: fixture.termination.signal };
    const observedOutcome = { exitCode: observation.exitCode, exitSignal: observation.exitSignal };
    const killSignal = SIGNAL_TERMINATIONS[fixture.termination.kind];
    if (killSignal !== undefined) {
      // Everything below reads the exit as evidence about the kill, which it
      // only is if the kill caused it. `child.kill` reports false when the
      // runtime refused to deliver the signal, and that is exactly what happens
      // when the adapter has already exited by itself. An adapter that ended on
      // its own after the last recorded message, on a platform where a natural
      // exit and a forced termination report the same status, would otherwise
      // satisfy both assertions below without the signal ever being sent.
      assert.equal(
        observation.terminationKillAccepted,
        true,
        `${name}: child.kill('${killSignal}') was not accepted for a live process, so the exit that followed it ` +
          'was not caused by the stimulus this scenario applies',
      );
    }
    if (killSignal !== undefined && !platformHasCapability('posix-signal-delivery-to-a-child-process')) {
      const forced = await unhandledTermination(killSignal);
      assert.deepEqual(
        observedOutcome,
        forced,
        `${name}: this platform is declared unable to deliver ${killSignal} to another process, so ` +
          `child.kill('${killSignal}') is an unconditional terminate and the adapter must end exactly as a ` +
          'control child that handles nothing ends under the same call. A difference means the adapter now ' +
          'survives or intercepts it, or the control no longer describes this host.',
      );
      assert.notDeepEqual(
        observedOutcome,
        recordedOutcome,
        `${name}: the recorded graceful outcome was reproduced on a platform declared unable to deliver ` +
          `${killSignal}, which only the adapter's own handler can produce. If signal delivery exists here ` +
          'now, the declaration posix-signal-delivery-to-a-child-process in tests/platform-capabilities.ts is ' +
          'stale and this scenario must go back to comparing against the recording.',
      );
    } else {
      assert.equal(
        observation.exitCode,
        fixture.termination.exitCode,
        `${name}: ${fixture.termination.kind} exit code changed`,
      );
      assert.equal(
        observation.exitSignal,
        fixture.termination.signal,
        `${name}: ${fixture.termination.kind} exit signal changed`,
      );
      if (killSignal !== undefined) {
        // Positive control for the branch above, on the platforms that do
        // deliver signals: the recorded outcome has to be one only a handler
        // can produce. If an unhandled process ended the same way, reproducing
        // the recording would say nothing about the adapter's shutdown path.
        assert.notDeepEqual(
          observedOutcome,
          await unhandledTermination(killSignal),
          `${name}: the recorded ${fixture.termination.kind} outcome is what killing a process that handles ` +
            'nothing produces on this host, so this scenario would pass without the adapter handling the ' +
            'signal at all',
        );
      }
    }
    assert.equal(
      observation.stdoutLines.length,
      fixture.stdout.lineCount,
      `${name}: total stdout message count changed`,
    );
  });
}

test('replaying the recorded wire corpus needs no normalization of stdout', async () => {
  for (const name of scenarioNames) {
    const fixture = fixtureOf(name);
    const observation = await replay(name);
    assert.equal(
      observation.normalizationRewroteStdout,
      fixture.stdout.normalizationRewroteStdout,
      `${name}: whether a normalization rule rewrites stdout changed; every recorded scenario expects stdout ` +
        'to contain no machine-specific path and therefore to survive normalization untouched',
    );
  }
});

test('the JSON property order emitted on the wire still matches the recording', async () => {
  const changed: string[] = [];
  let bytesChecked = 0;
  for (const name of scenarioNames) {
    const fixture = fixtureOf(name);
    const observation = await replay(name);
    fixture.steps.forEach((step, stepIndex) => {
      step.expect.forEach((entry, messageIndex) => {
        const line = observation.stepMessages[stepIndex][messageIndex];
        if (line === undefined) return;
        // A message the ledger rewrites has an accepted content change, so its
        // recorded bytes cannot be reproduced. Its content is still pinned
        // exactly, by the per-scenario assertion above.
        if (ledgerRewroteMessage(fixture, stepIndex, messageIndex)) return;
        bytesChecked += 1;
        if (sha256(line) !== entry.rawSha256) {
          changed.push(`${name} step ${String(stepIndex)} (${step.label}) message ${String(messageIndex)}`);
        }
      });
    });
  }
  assert.deepEqual(
    changed,
    [],
    'the byte-for-byte serialization of these responses changed. Property order was measured to be stable ' +
      'for the recorded build, so a difference here means the serializer or the field order changed even if ' +
      'the messages remain semantically equal; review each one before accepting it.',
  );
  // Positive control for the exemption above: most recorded messages are not
  // rewritten by the ledger, and those must still match their recorded bytes.
  // The floor is the measured count, not a round number below it: a loose floor
  // lets the ledger widen until it exempts most of the corpus while this check
  // still reports that it has reach. Adding a ledger entry that exempts another
  // recorded message therefore has to move this number down deliberately.
  assert.equal(
    bytesChecked,
    BYTE_IDENTITY_MESSAGE_COUNT,
    `${String(bytesChecked)} recorded message(s) were held to their recorded bytes, not the ` +
      `${String(BYTE_IDENTITY_MESSAGE_COUNT)} measured when this floor was set. Fewer means the ` +
      'accepted-deviation ledger now exempts more of the corpus; more means the corpus or the ledger changed ' +
      'shape. Either way, review the difference rather than adjusting the number to match.',
  );
});

test('adapter logs stay on stderr and never appear on stdout', async () => {
  for (const name of scenarioNames) {
    const fixture = fixtureOf(name);
    const observation = await replay(name);
    assertStderrMatchesRecording(observation.stderrLines, fixture.stderrLines, name);
    for (const line of observation.stdoutLines) {
      assert.ok(
        !line.includes('[minecraft-blockbench-mcp]'),
        `${name}: an adapter log line reached stdout: ${JSON.stringify(line.slice(0, 200))}`,
      );
    }
    assert.ok(
      observation.stderrLines.some((line) => line.startsWith('[minecraft-blockbench-mcp]')),
      `${name}: no adapter log line was captured on stderr, so the stdout purity check has no positive control`,
    );
  }
});

test('tools/list still advertises the recorded tool order, descriptions, and execution metadata', async () => {
  const frozen = readJsonFixture<{
    toolCount: number;
    order: string[];
    descriptions: Record<string, string>;
    execution: Record<string, unknown>;
  }>('tool-order.json');
  const observation = await replay('tools-list-inventory');
  const listMessage = parseStdoutMessages(observation.stepMessages.at(-1) ?? []).at(-1);
  const tools = ((listMessage?.result as { tools?: Array<Record<string, unknown>> } | undefined)?.tools ?? []);

  assert.equal(tools.length, frozen.toolCount, 'the number of advertised tools changed');
  assert.deepEqual(tools.map((tool) => tool.name), frozen.order, 'the advertised tool order changed');
  assert.deepEqual(
    Object.fromEntries(tools.map((tool) => [tool.name, tool.description])),
    frozen.descriptions,
    'an advertised tool description changed',
  );
  assert.deepEqual(
    Object.fromEntries(tools.map((tool) => [tool.name, tool.execution ?? null])),
    applyAcceptedDeviationsToRecordedExecutionMap(frozen.execution, deviationUsage),
    'the per-tool execution metadata advertised in tools/list changed in a way the accepted-deviation ledger ' +
      'does not describe',
  );
});

test('every advertised tool input schema still matches the recorded schema', async () => {
  const frozen = readJsonFixture<{ toolCount: number; schemas: Record<string, unknown> }>('tool-input-schemas.json');
  const observation = await replay('tools-list-inventory');
  const listMessage = parseStdoutMessages(observation.stepMessages.at(-1) ?? []).at(-1);
  const tools = ((listMessage?.result as { tools?: Array<Record<string, unknown>> } | undefined)?.tools ?? []);
  const observed = Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema]));

  assert.deepEqual(
    Object.keys(observed).sort(),
    Object.keys(frozen.schemas).sort(),
    'the set of tools with an advertised input schema changed',
  );
  for (const toolName of Object.keys(frozen.schemas)) {
    assert.deepEqual(
      observed[toolName],
      applyAcceptedDeviationsToAdvertisedSchema(toolName, frozen.schemas[toolName], deviationUsage),
      `the advertised input schema for the ${toolName} tool changed in a way the accepted-deviation ledger ` +
        'does not describe',
    );
  }
});

/**
 * The ledger accepts that members inside a schema object are serialized in a
 * different order. It does not accept a change to the order of the property
 * names themselves: that order is what a model reads the parameters in, so it
 * is held to the recording at every level of every advertised schema.
 */
test('the order of the property names inside every advertised tool input schema is unchanged', async () => {
  const frozen = readJsonFixture<{ schemas: Record<string, unknown> }>('tool-input-schemas.json');
  const observation = await replay('tools-list-inventory');
  const listMessage = parseStdoutMessages(observation.stepMessages.at(-1) ?? []).at(-1);
  const tools = (listMessage?.result as { tools?: Array<Record<string, unknown>> } | undefined)?.tools ?? [];
  const observed = Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema]));

  /** Every `properties` map in the document, keyed by where it was found. */
  function propertyNameOrder(node: unknown, pointer: string, into: Map<string, string[]>): Map<string, string[]> {
    if (Array.isArray(node)) {
      node.forEach((child, index) => propertyNameOrder(child, `${pointer}/${String(index)}`, into));
      return into;
    }
    if (typeof node !== 'object' || node === null) return into;
    const record = node as Record<string, unknown>;
    const properties = record.properties;
    if (typeof properties === 'object' && properties !== null && !Array.isArray(properties)) {
      into.set(`${pointer}/properties`, Object.keys(properties as Record<string, unknown>));
    }
    for (const [key, value] of Object.entries(record)) propertyNameOrder(value, `${pointer}/${key}`, into);
    return into;
  }

  let mapsCompared = 0;
  for (const toolName of Object.keys(frozen.schemas)) {
    // Compare against the ledger-rewritten recording, so an inlined subschema
    // is compared where the `$ref` used to stand rather than being skipped.
    const expected = propertyNameOrder(
      applyAcceptedDeviationsToAdvertisedSchema(toolName, frozen.schemas[toolName], deviationUsage),
      toolName,
      new Map(),
    );
    const actual = propertyNameOrder(observed[toolName], toolName, new Map());
    assert.deepEqual(
      [...actual.keys()].sort(),
      [...expected.keys()].sort(),
      `the ${toolName} tool advertises its object properties in a different set of places than recorded`,
    );
    for (const [location, names] of expected) {
      assert.deepEqual(
        actual.get(location),
        names,
        `the ${toolName} tool advertises the properties at ${location} in a different order than recorded`,
      );
      mapsCompared += 1;
    }
  }
  // As above, the measured count rather than a round number below it: this is
  // what stops the property-order check from quietly covering less of the
  // advertised schemas than it did.
  assert.equal(
    mapsCompared,
    ADVERTISED_PROPERTY_MAP_COUNT,
    `${String(mapsCompared)} property map(s) were compared, not the ${String(ADVERTISED_PROPERTY_MAP_COUNT)} ` +
      'measured when this floor was set, so the advertised schemas gained or lost an object level',
  );
});

test('every named test recorded before this wire corpus was added still exists', () => {
  const inventory = readJsonFixture<NamedTestInventory>('named-test-inventory.json');
  const current = scanNamedTests();
  const currentNames = new Set(current.map((entry) => `${entry.file}::${entry.name}`));
  const missing = inventory.tests
    .filter((entry) => !currentNames.has(`${entry.file}::${entry.name}`))
    .map((entry) => `${entry.file}: ${entry.name}`);

  assert.deepEqual(missing, [], 'these previously recorded tests were deleted, renamed, or moved');
  assert.ok(
    current.length >= inventory.testCount,
    `the repository now declares ${String(current.length)} named tests, fewer than the ${String(inventory.testCount)} recorded`,
  );
});

// ---------------------------------------------------------------------------
// Per-file floors, which are what stop the inventory check from going slack
// ---------------------------------------------------------------------------

const TESTS_DIRECTORY = join(REPO_ROOT, 'tests');

/** Test files on disk, excluding the one these checks live in. */
function testFilesOnDisk(): string[] {
  return readdirSync(TESTS_DIRECTORY)
    .filter((entry) => entry.endsWith('.test.ts') && !INVENTORY_EXCLUDED_FILES.includes(entry))
    .sort();
}

// The exclusion above exists so the frozen named-test inventory stays a stable
// subset. It is not a reason for the platform-capability controls to have a
// blind spot in the file they live in, so those controls take their own file
// set from `scannedSourcesUnder`, which covers this file and the helpers too.

function readTestFile(file: string): string {
  return readFileSync(join(TESTS_DIRECTORY, file), 'utf8');
}

const DECLARED_TEST_PATTERN = /^test\((['"])(.*?)\1/gm;
const ASSERTION_CALL_PATTERN = /\bassert\s*\.\s*\w+\s*\(/g;

test('every test file still declares at least the tests and assertions recorded for it', () => {
  const floors = TEST_FILE_FLOORS;
  const onDisk = testFilesOnDisk();

  // A file that disappears must fail here rather than simply stopping being
  // counted, and a file that appears must be given a floor of its own.
  assert.deepEqual(
    onDisk,
    Object.keys(floors).sort(),
    'the set of test files no longer matches the set that carries recorded floors. A new file needs a floor in ' +
      'tests/named-test-floors.ts; a deleted one has to be removed from it deliberately.',
  );

  const shortfalls: string[] = [];
  for (const [file, floor] of Object.entries(floors)) {
    const source = readTestFile(file);
    const declared = [...source.matchAll(DECLARED_TEST_PATTERN)].length;
    const assertions = [...source.matchAll(ASSERTION_CALL_PATTERN)].length;
    if (declared < floor.tests) {
      shortfalls.push(`${file}: declares ${String(declared)} test(s), recorded ${String(floor.tests)}`);
    }
    if (assertions < floor.assertions) {
      shortfalls.push(
        `${file}: declares ${String(assertions)} assertion call(s), recorded ${String(floor.assertions)}`,
      );
    }
  }
  assert.deepEqual(
    shortfalls,
    [],
    'these files lost tests or assertions. The repository-wide inventory total cannot see this: it compares ' +
      'one number against the 417 recorded before the migration, and the surplus added since would absorb the ' +
      'loss. An assertion count that fell without a test count falling is a test body that was emptied while ' +
      'its name stayed. If the removal is intended, lower the number in tests/named-test-floors.ts in the same ' +
      'change so it appears in the diff.',
  );
});

test('the per-file floors cover the frozen named-test inventory and are measured against real files', () => {
  const floors = TEST_FILE_FLOORS;
  const inventory = readJsonFixture<NamedTestInventory>('named-test-inventory.json');
  const inventoriedFiles = [...new Set(inventory.tests.map((entry) => entry.file))].sort();

  assert.deepEqual(
    Object.entries(floors)
      .filter(([, floor]) => floor.inventoried)
      .map(([file]) => file)
      .sort(),
    inventoriedFiles,
    'the files marked as covered by the frozen inventory are no longer the files it actually covers',
  );
  // The floors have to be real measurements. Zeroes would satisfy every
  // comparison above while checking nothing.
  for (const [file, floor] of Object.entries(floors)) {
    assert.ok(floor.tests > 0, `${file} carries a test floor of ${String(floor.tests)}, which checks nothing`);
    assert.ok(
      floor.assertions >= floor.tests,
      `${file} records fewer assertion calls (${String(floor.assertions)}) than tests (${String(floor.tests)}), ` +
        'so at least one test declares no assertion of its own',
    );
  }
  // And together they have to account for more than the frozen total, since the
  // migration added files the inventory never covered.
  const totalTests = Object.values(floors).reduce((sum, floor) => sum + floor.tests, 0);
  assert.ok(
    totalTests >= inventory.testCount,
    `the per-file floors total ${String(totalTests)} tests, fewer than the ${String(inventory.testCount)} the ` +
      'frozen inventory recorded',
  );
});

test('no test file disables a test except the reviewed platform-conditional skips', () => {
  // A disabled test still matches the name scan, so the inventory would keep
  // reporting it as present while it never runs again.
  const disablingPattern = /\bskip\s*:|\btodo\s*:|\.\s*skip\s*\(|\.\s*todo\s*\(/g;
  const reviewed = new Set(REVIEWED_CONDITIONAL_SKIPS.map((entry) => `${entry.file}::${entry.test}`));
  const unreviewed: string[] = [];

  for (const file of testFilesOnDisk()) {
    const source = readTestFile(file);
    for (const line of source.split('\n')) {
      disablingPattern.lastIndex = 0;
      if (!disablingPattern.test(line)) continue;
      const declaration = /^test\((['"])(.*?)\1/.exec(line);
      const name = declaration === null ? null : declaration[2];
      if (name !== null && reviewed.has(`${file}::${name}`)) continue;
      unreviewed.push(`${file}: ${line.trim().slice(0, 160)}`);
    }
  }
  assert.deepEqual(
    unreviewed,
    [],
    'a test is disabled, or something reads as a disabling marker, outside the reviewed list in ' +
      'tests/named-test-floors.ts. A skipped or todo test still satisfies the name inventory while never ' +
      'running, so each one has to be listed and justified there.',
  );
});

test('every reviewed conditional skip is still a platform guard and is still declared where it was recorded', () => {
  const missing: string[] = [];
  for (const entry of REVIEWED_CONDITIONAL_SKIPS) {
    const source = readTestFile(entry.file);
    const declaration = source
      .split('\n')
      .find((line) => line.startsWith(`test('${entry.test}'`) || line.startsWith(`test("${entry.test}"`));
    if (declaration === undefined) {
      missing.push(`${entry.file}: ${entry.test} is no longer declared`);
      continue;
    }
    if (!declaration.includes(`skip: ${entry.condition}`)) {
      missing.push(`${entry.file}: ${entry.test} no longer carries the reviewed condition ${entry.condition}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    'a reviewed conditional skip changed. These three exist so a platform-specific behaviour is checked on the ' +
      'platform it belongs to; a widened condition, or an unconditional skip, silently removes the test from ' +
      'every run instead.',
  );
  for (const entry of REVIEWED_CONDITIONAL_SKIPS) {
    assert.match(
      entry.condition,
      /process\.platform/,
      `the reviewed skip for ${entry.test} is not a platform guard, so it can disable the test everywhere`,
    );
  }
});

test('the recorded wire corpus still holds every fixture file and behaviour class', () => {
  const index = readJsonFixture<{
    requiredClasses: string[];
    files: Array<{ path: string; kind: string; covers: string[] }>;
  }>('corpus-index.json');
  const root = fixtureRoot();

  for (const entry of index.files) {
    assert.ok(existsSync(join(root, entry.path)), `the recorded fixture ${entry.path} is missing from ${root}`);
  }
  const indexedScenarios = index.files
    .filter((entry) => entry.kind === 'scenario')
    .map((entry) => entry.path.replace(/^scenarios\//, '').replace(/\.json$/, ''))
    .sort();
  assert.deepEqual(indexedScenarios, scenarioNames, 'the scenario files on disk no longer match the corpus index');

  const covered = new Set(index.files.flatMap((entry) => entry.covers));
  const uncovered = index.requiredClasses.filter((name) => !covered.has(name));
  assert.deepEqual(uncovered, [], 'these behaviour classes lost their fixture coverage');
});

// ---------------------------------------------------------------------------
// Controls on the accepted-deviation ledger itself
// ---------------------------------------------------------------------------

/**
 * Apply every ledger entry to the whole recorded corpus and report where each
 * one fired. This drives the ledger directly from the frozen files rather than
 * from a replay, so the controls below do not depend on the order the tests
 * above happened to run in, and need no child process.
 */
function recordLedgerUsageAcrossCorpus(): DeviationUsage {
  const usage = new DeviationUsage();
  for (const name of scenarioNames) {
    const fixture = fixtureOf(name);
    fixture.steps.forEach((step) => {
      step.expect.forEach((entry, messageIndex) => {
        applyAcceptedDeviationsToRecordedMessage(
          entry.message,
          {
            scenario: fixture.name,
            stepLabel: step.label,
            messageIndex,
            request: step.send,
            fixtureRoot: fixtureRoot(),
          },
          usage,
        );
      });
    });
  }
  const order = readJsonFixture<{ execution: Record<string, unknown> }>('tool-order.json');
  applyAcceptedDeviationsToRecordedExecutionMap(order.execution, usage);
  const schemas = readJsonFixture<{ schemas: Record<string, unknown> }>('tool-input-schemas.json');
  for (const [toolName, schema] of Object.entries(schemas.schemas)) {
    applyAcceptedDeviationsToAdvertisedSchema(toolName, schema, usage);
  }
  return usage;
}

/**
 * The `health` strictness entry declares a live-probe location, because the
 * difference it accepts is in what the server enforces and the corpus never
 * sent `health` an undeclared argument key. This runs exactly that call against
 * the current build and returns the tool result it produced.
 *
 * The call is made on a 2025-era connection, the same era every recorded
 * scenario uses, so what it observes is comparable with the corpus around it.
 */
async function probeHealthWithUnrecognizedArgumentKey(): Promise<Record<string, unknown>> {
  const observed = await runScenarioProgram({
    args: ['--direct'],
    termination: 'stdin-eof',
    steps: [
      {
        label: 'initialize with protocolVersion 2025-11-25',
        send: {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'premigration-wire-recorder', version: '1.0.0' },
          },
        },
        awaitStdoutMessages: 1,
      },
      {
        label: 'notifications/initialized carries no response',
        send: { jsonrpc: '2.0', method: 'notifications/initialized' },
        awaitStdoutMessages: 0,
      },
      {
        label: 'tools/call health with an unrecognized argument key',
        send: {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'health', arguments: { [HEALTH_STRICT_ARGUMENTS_PROBE_KEY]: 1 } },
        },
        awaitStdoutMessages: 1,
      },
    ],
  });
  return JSON.parse(observed.stepMessages[2][0]) as Record<string, unknown>;
}

/** One child process for the probe, shared by the assertion and the controls. */
let healthStrictProbe: Promise<Record<string, unknown>> | null = null;

function healthStrictProbeResult(): Promise<Record<string, unknown>> {
  healthStrictProbe ??= probeHealthWithUnrecognizedArgumentKey();
  return healthStrictProbe;
}

/**
 * Observe the live-probe locations and record the entries they exercise, so the
 * controls below hold a live-probe entry to its declared location exactly as
 * they hold a rewrite entry to its recorded one. The observation is asserted
 * here: an entry is recorded as exercised only when the behaviour it declares
 * is what actually came back.
 */
async function recordLedgerUsage(): Promise<DeviationUsage> {
  const usage = recordLedgerUsageAcrossCorpus();
  const answered = await healthStrictProbeResult();
  const result = answered.result as { isError?: unknown; content?: Array<{ text?: unknown }> } | undefined;
  if (result?.isError === true && result.content?.[0]?.text === HEALTH_STRICT_ARGUMENTS_REJECTION_TEXT) {
    usage.note(HEALTH_STRICT_ID, HEALTH_STRICT_ARGUMENTS_PROBE_SITE);
  }
  return usage;
}

test('tools/call health rejects an unrecognized argument key, which the accepted deviation ledger declares and the corpus does not record', async () => {
  // The recorded build advertised `additionalProperties: false` for `health`
  // while enforcing a plain object schema that strips unknown members, so this
  // call succeeded then and is refused now. Nothing in the frozen corpus shows
  // the difference: it never sent `health` an undeclared key, so this call is
  // the evidence the ledger entry stands on.
  const answered = await healthStrictProbeResult();
  const result = answered.result as { isError?: unknown; content?: Array<{ type?: string; text?: string }> } | undefined;

  assert.equal(result?.isError, true, 'the undeclared argument key was accepted, as it was before the migration');
  assert.equal(result?.content?.[0]?.type, 'text');
  assert.equal(result?.content?.[0]?.text, HEALTH_STRICT_ARGUMENTS_REJECTION_TEXT);
  // The rejection is the dependency validation layer's, not a JSON-RPC error:
  // the boundary between the two validation layers is unchanged.
  assert.equal(answered.error, undefined, 'the rejection was raised as a JSON-RPC error instead of a tool result');
});

test('every accepted wire deviation is still exercised, at exactly the recorded locations it declares', async () => {
  const usage = await recordLedgerUsage();
  const unexercised: string[] = [];
  for (const deviation of ACCEPTED_DEVIATIONS) {
    const sites = usage.sitesFor(deviation.id);
    if (sites.length === 0) {
      unexercised.push(deviation.id);
      continue;
    }
    assert.deepEqual(
      sites,
      [...deviation.expectedSites].sort(),
      `the accepted deviation ${deviation.id} no longer applies at the recorded locations it declares. ` +
        'Applying somewhere new means it has widened beyond what was reviewed; applying at fewer places ' +
        'means the declaration is stale.',
    );
  }
  assert.deepEqual(
    unexercised,
    [],
    'these accepted deviations were never exercised by the recorded corpus. An entry that nothing reaches ' +
      'is dead weight that would mask a future regression at the location it claims to cover; remove it or ' +
      'restore the coverage.',
  );
});

test('the accepted wire deviation ledger applies nothing it has not declared', async () => {
  const usage = await recordLedgerUsage();
  const declared = ACCEPTED_DEVIATIONS.map((deviation) => deviation.id).sort();
  assert.deepEqual(
    usage.usedIds(),
    declared,
    'a rewrite fired under an identifier the ledger does not list, or a listed identifier never fired',
  );
  assert.equal(new Set(declared).size, declared.length, 'two accepted deviations share an identifier');
  for (const deviation of ACCEPTED_DEVIATIONS) {
    assert.ok(deviation.was.length > 0, `${deviation.id} does not record what the corpus recorded`);
    assert.ok(deviation.now.length > 0, `${deviation.id} does not state what must be observed now`);
    assert.ok(deviation.reason.length > 0, `${deviation.id} cites no authority`);
    assert.ok(deviation.appliesTo.length > 0, `${deviation.id} does not name what it applies to`);
  }
});

test('every wire deviation outside the migration plan adjudicated list is declared for review', () => {
  const escalated = ACCEPTED_DEVIATIONS.filter((deviation) => deviation.authority === 'escalated-for-adjudication')
    .map((deviation) => deviation.id)
    .sort();
  assert.deepEqual(
    escalated,
    [...ESCALATED_DEVIATION_IDS].sort(),
    'the set of accepted deviations that carry no adjudicated authority changed. Every one of them has to be ' +
      'reviewed against the target specification before it is accepted, so it cannot be added or dropped ' +
      'without updating ESCALATED_DEVIATION_IDS and reporting the change.',
  );
});

// ---------------------------------------------------------------------------
// Controls on the platform-capability registry
// ---------------------------------------------------------------------------

/**
 * The guard's whole reach: every `.ts` source directly under `tests/` and under
 * `tests/helpers/`, scanned once and reused by the three controls below.
 *
 * Helpers are in deliberately. A narrowing hidden in a helper is invisible from
 * the test that calls it, and the helpers are where this repository puts its
 * real platform dispatch, so they are exactly where the rule has to reach.
 */
function scanEverySource(): Array<{ file: string; scan: PlatformSourceScan }> {
  return scannedSourcesUnder(TESTS_DIRECTORY).map((file) => ({
    file,
    scan: scanPlatformUse(file, readFileSync(join(TESTS_DIRECTORY, file), 'utf8')),
  }));
}

test('no source under tests/ interrogates the host platform through a known platform interface except at a declared site', () => {
  // What this enforces, exactly: none of the interfaces enumerated in
  // tests/platform-capabilities.ts - process.platform however it is spelled or
  // destructured, the process binding itself once it is laundered into another
  // name, the host-identity members of node:os, the host-shaped members of
  // node:path, and the environment variables that name the operating system -
  // is read anywhere under tests/ except at a construct declared there. It is a
  // syntax scan, so it sees through layout, comments and string literals; it is
  // only a syntax scan, so it does not see a try/catch that removes an
  // assertion on the platform that throws, or any other way of learning what
  // the host is. That residual is stated in the registry header and is not
  // claimed here.
  const undeclared = scanEverySource()
    .flatMap((entry) => entry.scan.undeclared)
    .map(
      (mention) =>
        `${mention.file}:${String(mention.line)} in ${mention.container}: reads ${mention.api} - ` +
        `${mention.note} - ${mention.construct.slice(0, 160)}`,
    );
  assert.deepEqual(
    undeclared,
    [],
    'these constructs ask the host what platform it is without declaring what that decides. A branch that ' +
      'removes an assertion has to go through platformHasCapability, naming an entry in ' +
      'tests/platform-capabilities.ts that states the invariant, the mechanism it is absent for, and what must ' +
      'be asserted instead. A read that decides something else has to be listed, with its reason, in ' +
      'DECLARED_HOST_PLATFORM_SITES, which pins the construct rather than the line it sits on.',
  );

  const declaredIds = new Set<string>(PLATFORM_CAPABILITIES.map((capability) => capability.id));
  const unreadable: string[] = [];
  const unknown: string[] = [];
  for (const entry of scanEverySource()) {
    unreadable.push(...entry.scan.unreadableCalls);
    for (const id of entry.scan.narrowedIds) {
      if (!declaredIds.has(id)) unknown.push(`${entry.file}: ${id}`);
    }
  }
  assert.deepEqual(
    unreadable,
    [],
    'a platform-capability narrowing cannot be read from the source. The id has to be a string literal, the ' +
      'call takes that id and nothing else, its answer has to be used, and it has to sit in code that can run - ' +
      'otherwise the control below cannot see that the entry is still used and an entry could go dead ' +
      'unnoticed. Asking about a platform the source names is platformProvidesCapability, which reads nothing ' +
      'about the host.',
  );
  assert.deepEqual(unknown, [], 'a test narrows on a platform capability that tests/platform-capabilities.ts does not declare');
});

test('every declared platform capability still narrows something and selects only platforms the matrix runs', () => {
  const named = new Set(scanEverySource().flatMap((entry) => entry.scan.narrowedIds));
  assert.deepEqual(
    PLATFORM_CAPABILITIES.filter((capability) => !named.has(capability.id)).map((capability) => capability.id),
    [],
    'these platform capability gaps are declared but nothing narrows on them any more. A declaration nothing ' +
      'reaches is dead weight that would justify a branch which no longer exists; remove it, or restore the ' +
      'branch it describes. Only a readable call counts: an id inside a comment or a string, an answer that is ' +
      'thrown away, and a call in a block that can never run are all not uses.',
  );

  const ids = PLATFORM_CAPABILITIES.map((capability) => capability.id);
  assert.equal(new Set(ids).size, ids.length, 'two platform capabilities share an identifier');
  for (const capability of PLATFORM_CAPABILITIES) {
    assert.ok(capability.invariant.length > 0, `${capability.id} does not state the invariant it is about`);
    assert.ok(capability.mechanism.length > 0, `${capability.id} does not name the mechanism it is absent for`);
    assert.ok(capability.assertInstead.length > 0, `${capability.id} does not say what must be asserted instead`);
    assert.ok(capability.alsoCoveredBy.length > 0, `${capability.id} does not say what else covers the intent`);
    assert.ok(
      capability.absentOn.length > 0,
      `${capability.id} names no platform that lacks the invariant, so every branch on it is unreachable`,
    );
    // An entry may only be absent on a platform the matrix actually runs. A gap
    // declared on a platform no leg exercises would satisfy every control here
    // while narrowing nothing that ever runs.
    for (const platform of capability.absentOn) {
      assert.ok(
        MATRIX_PLATFORMS.includes(platform),
        `${capability.id} is declared absent on ${platform}, which no leg of the platform matrix runs, so the ` +
          'declaration narrows nothing anywhere',
      );
    }
    // An entry has to select. One that answered the same everywhere would
    // either silence its assertions on every platform or never fire at all.
    for (const platform of capability.absentOn) {
      assert.equal(
        platformProvidesCapability(capability.id, platform),
        false,
        `${capability.id} is declared absent on ${platform} but reports itself present there`,
      );
    }
    const present = MATRIX_PLATFORMS.filter((platform) => !capability.absentOn.includes(platform));
    assert.ok(
      present.length > 0,
      `${capability.id} is declared absent on every platform this suite runs on, so the assertions it guards ` +
        'can never run anywhere',
    );
    for (const platform of present) {
      assert.equal(
        platformProvidesCapability(capability.id, platform),
        true,
        `${capability.id} is not declared absent on ${platform} but reports itself missing there`,
      );
    }
  }
});

test('every declared host-platform site is still on disk as the reachable construct it was reviewed as', () => {
  const matched = new Set(scanEverySource().flatMap((entry) => entry.scan.matchedSites));
  const stale = DECLARED_HOST_PLATFORM_SITES.filter((site) => !matched.has(declaredSiteKey(site))).map((site) =>
    declaredSiteKey(site).slice(0, 200),
  );
  assert.deepEqual(
    stale,
    [],
    'a site listed in DECLARED_HOST_PLATFORM_SITES is no longer on disk as the construct it was reviewed as. ' +
      'The listing is what exempts that construct from the rule, so a construct that changed has to be reviewed ' +
      'again rather than keeping an exemption granted to different code. Only a real read in code that can run ' +
      'satisfies an entry: matching text in a comment, in a string, or inside a block that can never execute ' +
      'does not.',
  );
  for (const site of DECLARED_HOST_PLATFORM_SITES) {
    assert.ok(site.why.length > 0, `${site.file} declares a host-platform read with no reason`);
    assert.ok(site.construct.length > 0, `${site.file} declares a host-platform read pinned to nothing`);
    assert.ok(site.container.length > 0, `${site.file} declares a host-platform read with no container`);
  }
});
