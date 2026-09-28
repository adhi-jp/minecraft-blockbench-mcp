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
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import {
  DEFAULT_FIXTURE_ROOT,
  REPO_ROOT,
  runScenarioProgram,
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
}

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

process.stdout.write(`recorded ${String(definitions.length)} scenarios\n`);
