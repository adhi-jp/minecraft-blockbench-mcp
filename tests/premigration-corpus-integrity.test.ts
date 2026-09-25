// The frozen wire corpus is evidence, so its bytes are pinned here and its
// ability to fail is demonstrated here.
//
// `tests/fixtures/premigration/` is replayed by
// `tests/premigration-wire-baseline.test.ts` as the oracle for what the stdio
// executable puts on the wire. An oracle is only worth what its integrity is
// worth, and until this file existed two things were true of it: nothing
// computed a digest over the recorded files, so an edit anywhere inside them
// changed the oracle silently; and the only demonstration that the oracle can
// fail was a `cp`-and-edit recipe in the fixture README that a person had to
// run by hand.
//
// Both are closed here:
//
//   - `FROZEN_CORPUS_DIGEST` is a canonical digest over every recorded file,
//     stored in this file rather than inside the corpus, so a corpus that
//     edited itself cannot also edit the value it is checked against.
//   - The mutation-sensitivity test copies the corpus to a throwaway directory,
//     perturbs three named load-bearing fields in the copy, replays each
//     through the real oracle via the BLOCKBENCH_MCP_BASELINE_FIXTURE_DIR
//     override, and requires each one to fail a named assertion. The checked-in
//     corpus is never written to, and a clean control run of the same
//     assertions proves the harness can pass as well as fail.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { test } from 'node:test';

import { DEFAULT_FIXTURE_ROOT, FIXTURE_ROOT_ENV_VAR } from './helpers/premigration-baseline.ts';
import { CLI_ENTRY_PATH, REPO_ROOT } from './helpers/raw-stdio.ts';

/** The corpus path every digest line is keyed by, relative to the repository root. */
const CORPUS_RELATIVE_ROOT = 'tests/fixtures/premigration';

/**
 * Canonical digest of the frozen corpus.
 *
 * Recomputed by `corpusDigest()` below: SHA-256 over the concatenation of one
 * `<sha256-of-file-bytes>  <repository-relative-path>\n` line per file, ordered
 * by that path. It is the same value `find tests/fixtures/premigration -type f |
 * sort | xargs sha256sum | sha256sum` produces from the repository root, so it
 * can be checked from a shell without running this suite.
 *
 * This constant lives outside `tests/fixtures/premigration/` on purpose. A
 * digest stored inside the directory it covers is not a control: whatever edits
 * the corpus edits the expectation with it.
 *
 * If this assertion fails, the corpus was edited, regenerated, or partially
 * restored. The corpus is evidence recorded from
 * `93a203ee825161c747bb50a5df8258f43119f65f` before the dependency change, so
 * an unexplained failure means restoring the recorded files, not updating this
 * constant. Update it only together with a deliberate, reviewed corpus change.
 */
const FROZEN_CORPUS_DIGEST = '2de05dc886383e4b2fd400b5a88d3cf338ee0868fbcae47163797b46bc857bf4';

/** The number of files the corpus held when the digest above was taken. */
const FROZEN_CORPUS_FILE_COUNT = 26;

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

interface CorpusFile {
  /** Repository-relative path, always with forward slashes. */
  relativePath: string;
  absolutePath: string;
}

function listCorpusFiles(directory: string = DEFAULT_FIXTURE_ROOT, base: string = CORPUS_RELATIVE_ROOT): CorpusFile[] {
  const found: CorpusFile[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = posix.join(base, entry.name);
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...listCorpusFiles(absolutePath, relativePath));
    else found.push({ relativePath, absolutePath });
  }
  return found.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
}

/** One `<hash>  <path>` line per file, in path order, hashed as a whole. */
function corpusDigest(files: readonly CorpusFile[]): string {
  const manifest = files.map((file) => `${sha256(readFileSync(file.absolutePath))}  ${file.relativePath}\n`).join('');
  return sha256(manifest);
}

test('the frozen wire corpus still hashes to the digest recorded when it was captured', () => {
  const files = listCorpusFiles();

  assert.equal(
    files.length,
    FROZEN_CORPUS_FILE_COUNT,
    `the frozen corpus holds ${String(files.length)} file(s), not the ${String(FROZEN_CORPUS_FILE_COUNT)} recorded. ` +
      'A file was added to or removed from immutable evidence.',
  );
  assert.equal(
    corpusDigest(files),
    FROZEN_CORPUS_DIGEST,
    `the frozen wire corpus under ${CORPUS_RELATIVE_ROOT} no longer matches the digest taken when it was ` +
      'recorded, so at least one recorded byte changed. Restore the recorded files; do not update the ' +
      'constant in tests/premigration-corpus-integrity.test.ts to match the new content.',
  );
});

test('the corpus digest is sensitive to a single changed byte anywhere in the corpus', () => {
  // Without this the digest above could pass with a hash function that ignores
  // its input, an empty file list, or a manifest that omits the file bodies.
  const files = listCorpusFiles();
  const baseline = corpusDigest(files);
  assert.equal(baseline, FROZEN_CORPUS_DIGEST);

  for (const file of files) {
    const perturbed = files.map((entry) =>
      entry === file
        ? `${sha256(Buffer.concat([readFileSync(entry.absolutePath), Buffer.from(' ')]))}  ${entry.relativePath}\n`
        : `${sha256(readFileSync(entry.absolutePath))}  ${entry.relativePath}\n`,
    );
    assert.notEqual(
      sha256(perturbed.join('')),
      baseline,
      `appending one byte to ${file.relativePath} left the corpus digest unchanged`,
    );
  }
  // Renaming a file has to move the digest too, so the manifest really is keyed
  // by path and not only by content.
  const renamed = files
    .map((entry, index) => `${sha256(readFileSync(entry.absolutePath))}  ${entry.relativePath}${index === 0 ? '.moved' : ''}\n`)
    .join('');
  assert.notEqual(sha256(renamed), baseline, 'renaming a recorded file left the corpus digest unchanged');
});

// ---------------------------------------------------------------------------
// Mutation sensitivity, run rather than described
// ---------------------------------------------------------------------------

assert.ok(
  existsSync(CLI_ENTRY_PATH),
  `the built executable is missing at ${CLI_ENTRY_PATH}; run \`npm run build\` before this suite`,
);

const BASELINE_TEST_FILE = 'tests/premigration-wire-baseline.test.ts';
const ORACLE_RUN_TIMEOUT_MS = 180_000;

interface OracleRun {
  status: number | null;
  output: string;
}

/**
 * Run the real parity oracle against `fixtureDirectory`, restricted to the
 * assertions whose names match `namePattern`.
 *
 * This spawns `node --test` rather than calling into the oracle, because the
 * oracle is a test file: its assertions are what has to be shown to fail, and
 * an in-process call could only observe a thrown error from whichever assertion
 * happened to run first.
 */
async function runOracleAgainst(fixtureDirectory: string, namePattern: string): Promise<OracleRun> {
  // `node --test` marks the processes it spawns, and refuses to start a test
  // run inside one. This run is a separate, deliberate one, so the marker is
  // cleared rather than inherited.
  const env: Record<string, string | undefined> = { ...process.env, [FIXTURE_ROOT_ENV_VAR]: fixtureDirectory };
  delete env.NODE_TEST_CONTEXT;

  return await new Promise<OracleRun>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--test', '--import', 'tsx', '--test-name-pattern', namePattern, BASELINE_TEST_FILE],
      {
        cwd: REPO_ROOT,
        env: env as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (output += chunk));
    child.stderr.on('data', (chunk: string) => (output += chunk));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the oracle run for ${JSON.stringify(namePattern)} did not finish in time`));
    }, ORACLE_RUN_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, output });
    });
  });
}

/** A throwaway copy of the corpus, removed when the test that made it ends. */
function copyCorpus(cleanup: (dispose: () => void) => void): string {
  const root = mkdtempSync(join(tmpdir(), 'blockbench-mcp-corpus-mutation-'));
  const copy = join(root, 'premigration');
  cpSync(DEFAULT_FIXTURE_ROOT, copy, { recursive: true });
  cleanup(() => rmSync(root, { recursive: true, force: true }));
  return copy;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * One perturbation: what is changed in the copy, which oracle assertions are
 * run against it, and the wording the failure has to carry.
 */
interface Perturbation {
  label: string;
  /** Regular expression passed to `node --test --test-name-pattern`. */
  namePattern: string;
  /** Substring the failing oracle run must report. */
  expectedFailureText: string;
  perturb(corpusCopy: string): void;
}

const PERTURBATIONS: readonly Perturbation[] = [
  {
    label: 'an advertised tool description in tool-order.json',
    namePattern: 'tool order, descriptions, and execution metadata',
    expectedFailureText: 'an advertised tool description changed',
    perturb(corpusCopy) {
      const path = join(corpusCopy, 'tool-order.json');
      const document = readJson(path);
      const descriptions = document.descriptions as Record<string, string>;
      assert.equal(typeof descriptions.health, 'string', 'the corpus copy records no health tool description');
      descriptions.health = `${descriptions.health} (perturbed by the corpus mutation-sensitivity check)`;
      writeJson(path, document);
    },
  },
  {
    label: 'a value inside an advertised input schema in tool-input-schemas.json',
    namePattern: 'every advertised tool input schema still matches',
    expectedFailureText: 'the advertised input schema for the read_file tool changed',
    perturb(corpusCopy) {
      const path = join(corpusCopy, 'tool-input-schemas.json');
      const document = readJson(path);
      const schemas = document.schemas as Record<string, { properties?: Record<string, { type?: string }> }>;
      const pathProperty = schemas.read_file?.properties?.path;
      assert.equal(pathProperty?.type, 'string', 'the corpus copy no longer records read_file.path as a string');
      pathProperty.type = 'number';
      writeJson(path, document);
    },
  },
  {
    label: 'an E_* envelope code inside a recorded scenario response',
    namePattern: 'plugin-absent-health-and-relay',
    expectedFailureText: 'no longer produces the recorded JSON-RPC message(s)',
    perturb(corpusCopy) {
      const path = join(corpusCopy, 'scenarios', 'plugin-absent-health-and-relay.json');
      const recorded = readFileSync(path, 'utf8');
      assert.ok(
        recorded.includes('E_PLUGIN_NOT_CONNECTED'),
        'the corpus copy no longer records an E_PLUGIN_NOT_CONNECTED envelope to perturb',
      );
      writeFileSync(path, recorded.split('E_PLUGIN_NOT_CONNECTED').join('E_PLUGIN_UNREACHABLE'), 'utf8');
    },
  },
];

test('the parity oracle fails a named assertion when a load-bearing recorded field is perturbed in a copy of the corpus', async (t) => {
  const disposers: Array<() => void> = [];
  t.after(() => {
    for (const dispose of disposers) dispose();
  });
  const remember = (dispose: () => void): void => {
    disposers.push(dispose);
  };

  const observed: Record<string, string> = {};
  for (const perturbation of PERTURBATIONS) {
    const corpusCopy = copyCorpus(remember);
    const before = corpusDigest(listCorpusFiles());
    perturbation.perturb(corpusCopy);

    const run = await runOracleAgainst(corpusCopy, perturbation.namePattern);
    observed[perturbation.label] =
      run.status === 0
        ? 'the oracle passed, so this perturbation is invisible to it'
        : run.output.includes(perturbation.expectedFailureText)
          ? 'failed the expected named assertion'
          : `failed, but not with ${JSON.stringify(perturbation.expectedFailureText)}: ${run.output.slice(-1_200)}`;

    // The checked-in corpus is never the thing being edited, and this proves it
    // for every perturbation rather than once at the end.
    assert.equal(
      corpusDigest(listCorpusFiles()),
      before,
      `perturbing ${perturbation.label} changed the checked-in corpus; only the throwaway copy may be written`,
    );
  }

  assert.deepEqual(
    observed,
    Object.fromEntries(PERTURBATIONS.map((entry) => [entry.label, 'failed the expected named assertion'])),
    'a perturbed recording did not fail the oracle assertion that is supposed to catch it',
  );
});

test('the parity oracle passes on an unperturbed copy of the corpus, so its failures come from the perturbation', async (t) => {
  const disposers: Array<() => void> = [];
  t.after(() => {
    for (const dispose of disposers) dispose();
  });
  const corpusCopy = copyCorpus((dispose) => disposers.push(dispose));

  // The same assertions the perturbations are checked against, run together on
  // an untouched copy. Without this control a perturbation could "fail" because
  // the harness cannot pass at all — a wrong directory, a missing build, an
  // override that is not read.
  const namePattern = PERTURBATIONS.map((entry) => `(${entry.namePattern})`).join('|');
  const run = await runOracleAgainst(corpusCopy, namePattern);

  assert.equal(
    run.status,
    0,
    `the oracle failed on an unmodified copy of the corpus, so the mutation-sensitivity result above is not ` +
      `attributable to the perturbations:\n${run.output.slice(-2_000)}`,
  );
  // And it really ran those assertions rather than matching none of them: an
  // exit status of 0 is also what a run that selected no test at all produces.
  const passed = Number(/^\D*pass (\d+)$/m.exec(run.output)?.[1] ?? '0');
  assert.ok(
    passed >= PERTURBATIONS.length,
    `only ${String(passed)} oracle assertion(s) passed against the clean copy, fewer than the ` +
      `${String(PERTURBATIONS.length)} the perturbations rely on:\n${run.output.slice(-2_000)}`,
  );
});
