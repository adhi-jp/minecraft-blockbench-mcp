#!/usr/bin/env node
// Record the public wire behaviour of the built stdio MCP executable into
// `tests/fixtures/premigration/`.
//
// The recording is a frozen description of the protocol surface as it exists
// before any dependency change, so that the same inputs can later be replayed
// against a rebuilt executable and compared. Everything it writes is derived
// from a live child process driven over raw newline-delimited JSON-RPC; nothing
// is transcribed by hand.
//
// Run with:  node scripts/capture-premigration-baseline.mjs
// Re-running on an unchanged build must produce byte-identical files.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import {
  DEFAULT_FIXTURE_ROOT,
  REPO_ROOT,
  INVENTORY_EXCLUDED_FILES,
  runScenarioProgram,
  scanNamedTests,
  toRecordedMessages,
} from '../tests/helpers/premigration-baseline.ts';
import {
  REQUIRED_FIXTURE_CLASSES,
  scenarioDefinitions,
} from '../tests/helpers/premigration-scenario-definitions.ts';
import { CLI_ENTRY_PATH } from '../tests/helpers/raw-stdio.ts';

const require = createRequire(import.meta.url);

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  process.stdout.write(`wrote ${path.slice(REPO_ROOT.length + 1)}\n`);
}

function fail(message) {
  process.stderr.write(`capture-premigration-baseline: ${message}\n`);
  process.exit(1);
}

if (!existsSync(CLI_ENTRY_PATH)) {
  fail(`the built executable is missing at ${CLI_ENTRY_PATH}; run \`npm run build\` first`);
}

const scenarioRoot = join(DEFAULT_FIXTURE_ROOT, 'scenarios');
mkdirSync(scenarioRoot, { recursive: true });

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

function gitHead() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

const packageJson = require(join(REPO_ROOT, 'package.json'));
const provenance = {
  note:
    'Recorded from the built stdio MCP executable before any dependency change. Regenerate with ' +
    '`node scripts/capture-premigration-baseline.mjs`. No capture timestamp is stored so that ' +
    're-recording an unchanged build produces byte-identical files.',
  gitHead: gitHead(),
  packageVersion: packageJson.version,
  declaredDependencies: packageJson.dependencies,
  installedSdkVersion: require(join(REPO_ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json')).version,
  installedZodVersion: require(join(REPO_ROOT, 'node_modules', 'zod', 'package.json')).version,
  nodeVersion: process.version,
  platform: process.platform,
  adapterMode: 'direct (pinned with --direct; POSIX defaults to brokered)',
  environment: 'isolated-empty-config-home',
};

// ---------------------------------------------------------------------------
// Scenario recordings
// ---------------------------------------------------------------------------

const definitions = scenarioDefinitions();
const knownScenarioFiles = new Set(definitions.map((definition) => `${definition.name}.json`));
for (const entry of readdirSync(scenarioRoot)) {
  if (entry.endsWith('.json') && !knownScenarioFiles.has(entry)) {
    rmSync(join(scenarioRoot, entry));
    process.stdout.write(`removed stale scenario ${entry}\n`);
  }
}

const indexEntries = [];
let toolsListResult = null;

for (const definition of definitions) {
  const observation = await runScenarioProgram(definition.program);

  if (observation.framingViolations.length > 0) {
    fail(
      `scenario ${definition.name} produced stdout that is not one JSON-RPC object per line:\n  ` +
        observation.framingViolations.join('\n  '),
    );
  }

  const fixture = {
    name: definition.name,
    proves: definition.proves,
    covers: definition.covers,
    process: { args: definition.program.args, environment: 'isolated-empty-config-home' },
    steps: definition.program.steps.map((step, index) => {
      const recorded = { label: step.label };
      if (step.sendRawLine !== undefined) recorded.sendRawLine = step.sendRawLine;
      else recorded.send = step.send;
      recorded.awaitStdoutMessages = step.awaitStdoutMessages;
      if (step.settleMs !== undefined) recorded.settleMs = step.settleMs;
      recorded.expect = toRecordedMessages(observation.stepMessages[index]);
      return recorded;
    }),
    termination: {
      kind: definition.program.termination,
      exitCode: observation.exitCode,
      signal: observation.exitSignal,
      trailingStdoutMessages: toRecordedMessages(observation.trailingLines),
    },
    stdout: {
      lineCount: observation.stdoutLines.length,
      everyLineIsOneJsonRpcObject: true,
      normalizationRewroteStdout: observation.normalizationRewroteStdout,
    },
    stderrLines: observation.stderrLines,
  };

  writeJson(join(scenarioRoot, `${definition.name}.json`), fixture);
  indexEntries.push({ path: `scenarios/${definition.name}.json`, kind: 'scenario', covers: definition.covers });

  if (definition.name === 'tools-list-inventory') {
    const last = observation.stepMessages.at(-1);
    toolsListResult = JSON.parse(last[0]).result;
  }
}

if (toolsListResult === null) fail('the tools-list-inventory scenario did not record a tools/list result');

// ---------------------------------------------------------------------------
// Derived tool views
// ---------------------------------------------------------------------------

const tools = toolsListResult.tools;
const toolOrder = {
  note:
    'The advertised tool order and the exact descriptions from tools/list, split out so an ordering or ' +
    'wording change is a one-line diff.',
  toolCount: tools.length,
  order: tools.map((tool) => tool.name),
  descriptions: Object.fromEntries(tools.map((tool) => [tool.name, tool.description])),
  execution: Object.fromEntries(tools.map((tool) => [tool.name, tool.execution ?? null])),
};
writeJson(join(DEFAULT_FIXTURE_ROOT, 'tool-order.json'), toolOrder);
indexEntries.push({ path: 'tool-order.json', kind: 'derived', covers: ['tool-inventory'] });

const toolInputSchemas = {
  note:
    'Every advertised tools/list input schema, keyed by tool name. Two of these schemas come from a shared ' +
    'schema with a top-level refinement, which is advertised unwrapped and re-validated inside the handler; ' +
    'see the tool-arguments-invalid-handler-layer scenario.',
  toolCount: tools.length,
  schemas: Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema])),
};
writeJson(join(DEFAULT_FIXTURE_ROOT, 'tool-input-schemas.json'), toolInputSchemas);
indexEntries.push({ path: 'tool-input-schemas.json', kind: 'derived', covers: ['tool-input-schemas'] });

// ---------------------------------------------------------------------------
// Named-test inventory
// ---------------------------------------------------------------------------

const staticTests = scanNamedTests();
const testFiles = readdirSync(join(REPO_ROOT, 'tests'))
  .filter((entry) => entry.endsWith('.test.ts') && !INVENTORY_EXCLUDED_FILES.includes(entry))
  .sort();

function runSuiteOnce() {
  const run = spawnSync(
    process.execPath,
    ['--test', '--import', 'tsx', '--test-reporter=tap', ...testFiles.map((file) => join('tests', file))],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (run.error !== undefined && run.error !== null) fail(`could not run the test suite: ${String(run.error)}`);
  const passed = [];
  const failed = [];
  for (const line of String(run.stdout).split('\n')) {
    const okMatch = /^ok \d+ - (.*)$/.exec(line);
    if (okMatch !== null) {
      passed.push(okMatch[1]);
      continue;
    }
    const notOkMatch = /^not ok \d+ - (.*)$/.exec(line);
    if (notOkMatch !== null) failed.push(notOkMatch[1]);
  }
  return { passed, failed, status: run.status };
}

process.stdout.write(`running ${String(testFiles.length)} test file(s) to confirm the inventory...\n`);
// A couple of existing bridge tests assert on short wall-clock timeouts and can
// lose a race when this machine is loaded. One retry keeps the recording
// reproducible without hiding a genuine failure: a second failing run stops here.
let attempt = runSuiteOnce();
if (attempt.failed.length > 0 || attempt.status !== 0) {
  process.stdout.write(`retrying the suite once after: ${attempt.failed.join(', ')}\n`);
  attempt = runSuiteOnce();
}
if (attempt.failed.length > 0) {
  fail(`the test suite reported failures, refusing to record an inventory:\n  ${attempt.failed.join('\n  ')}`);
}
if (attempt.status !== 0) fail(`the test suite exited with status ${String(attempt.status)}`);
const passed = attempt.passed;

const staticNames = staticTests.map((entry) => entry.name).sort();
const observedNames = passed.slice().sort();
if (staticNames.length !== observedNames.length || staticNames.some((name, index) => name !== observedNames[index])) {
  const onlyStatic = staticNames.filter((name) => !observedNames.includes(name));
  const onlyObserved = observedNames.filter((name) => !staticNames.includes(name));
  fail(
    'the statically scanned test names do not match the names the runner reported.\n' +
      `  only in the source scan: ${JSON.stringify(onlyStatic)}\n` +
      `  only in the run: ${JSON.stringify(onlyObserved)}`,
  );
}

writeJson(join(DEFAULT_FIXTURE_ROOT, 'named-test-inventory.json'), {
  note:
    'Every named test that existed and passed before this wire corpus was added. The replay test re-scans ' +
    'the test sources and fails if any of these names disappears, so a later change cannot quietly drop or ' +
    'rename an existing test.',
  provenance,
  excludedFiles: INVENTORY_EXCLUDED_FILES,
  verifiedByRun: true,
  fileCount: testFiles.length,
  testCount: staticTests.length,
  tests: staticTests,
});
indexEntries.push({ path: 'named-test-inventory.json', kind: 'inventory', covers: ['named-test-inventory'] });

// ---------------------------------------------------------------------------
// Corpus index
// ---------------------------------------------------------------------------

indexEntries.sort((a, b) => a.path.localeCompare(b.path));
const coveredClasses = new Set(indexEntries.flatMap((entry) => entry.covers));
const missingClasses = REQUIRED_FIXTURE_CLASSES.filter((name) => !coveredClasses.has(name));
if (missingClasses.length > 0) fail(`no fixture covers these behaviour classes: ${missingClasses.join(', ')}`);

writeJson(join(DEFAULT_FIXTURE_ROOT, 'corpus-index.json'), {
  note:
    'What this corpus contains and which behaviour class each file covers. The replay test compares this ' +
    'index against the files on disk, so an added or deleted fixture cannot go unnoticed.',
  provenance,
  requiredClasses: REQUIRED_FIXTURE_CLASSES,
  files: indexEntries,
});

process.stdout.write(
  `recorded ${String(definitions.length)} scenarios and ${String(staticTests.length)} named tests\n`,
);
