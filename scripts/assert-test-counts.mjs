// Runs the project's test suite once and asserts the pass/skip counts the
// platform matrix expects for the platform it is running on. The suite is the
// same on every platform, but a handful of cases are skipped where the
// behaviour under test cannot exist (no unix sockets on Windows, for example),
// so the count is the only signal that separates "correctly skipped here" from
// "silently stopped running everywhere". A green `npm test` alone cannot tell
// those apart; this gate can.
//
// The expected counts are inputs, never constants: the workflow passes the row
// for its own platform, so re-measuring a platform means editing the workflow,
// not this script.
//
// Exit codes are deliberately distinct so a CI leg can report *why* it failed:
//   0 suite passed and every count matched
//   1 the suite itself failed
//   2 the suite passed but a count moved
//   3 harness failure (bad arguments, a `scripts.test` that no longer has
//     the shape this gate was written against, spawn error, unparseable
//     summary)

import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

export const EXIT_OK = 0;
export const EXIT_SUITE_FAIL = 1;
export const EXIT_COUNT_MISMATCH = 2;
export const EXIT_HARNESS_ERROR = 3;

/** Every key of the runner's trailing summary block this gate reads. */
const SUMMARY_KEYS = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];

/**
 * Counts that are pinned to zero rather than passed in. A platform that starts
 * cancelling or todo-ing tests has changed what it verifies just as much as one
 * that starts skipping them, and that has to fail loudly instead of exiting 0.
 */
const ALWAYS_ZERO_KEYS = ['cancelled', 'todo'];

/** Printed for a count the summary never gave us, so a receipt is never silently wrong. */
const UNKNOWN_COUNT = 'UNKNOWN';

/**
 * The trailing summary is emitted in one of two shapes depending on which
 * reporter the runner defaulted to, and that default is Node-version dependent:
 * the `spec` reporter writes `<U+2139> pass 12`, the `tap` reporter writes
 * `# pass 12`. CI pins a Node major that may not be the one this was written
 * against, so both shapes are accepted rather than guessed at.
 */
const SUMMARY_LINE = /^\s*(?:ℹ|#)\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/;

/** Colour escapes survive when a reporter is told to force colour; strip before matching. */
const ANSI_ESCAPE = /\u001B\[[0-9;]*m/g;

/**
 * The looser shape that decides which lines belong to the same summary block.
 * Deliberately not `SUMMARY_LINE`: the runner's real block is not six
 * consecutive `SUMMARY_LINE` matches. The spec reporter emits
 *
 *   <U+2139> tests 594
 *   <U+2139> suites 0
 *   <U+2139> pass 594
 *   <U+2139> fail 0
 *   <U+2139> cancelled 0
 *   <U+2139> skipped 0
 *   <U+2139> todo 0
 *   <U+2139> duration_ms 156.451862
 *
 * where `suites` is not a key this gate reads and `duration_ms` carries a
 * float, so neither line matches `SUMMARY_LINE`. Treating them as boundaries
 * would cut the one real block into three. They are block MEMBERS here, and
 * only `SUMMARY_LINE` decides which members are counts.
 *
 * The capture groups carry the line's indentation and marker, which are part of
 * a block's identity: a subtest block is indented under the run-level block it
 * precedes, and without that the two run together as one.
 */
const SUMMARY_BLOCK_LINE = /^(\s*)(ℹ|#)\s+[A-Za-z_]+\s+[0-9]+(?:\.[0-9]+)?\s*$/;

/**
 * Pull the summary counts out of a whole captured run, reading the LAST summary
 * block only.
 *
 * Subtest output carries earlier lines in the same shape, which is why this
 * cannot simply take the first match. It used to take the last occurrence of
 * each key anywhere in the output, and that could return a false PASS: if the
 * run-level block were truncated, every key missing from it was silently
 * inherited from an earlier complete subtest block and the gate exited 0. Only
 * the keys present in the trailing block are the run-level totals, so only they
 * are read.
 *
 * A block is a maximal run of consecutive summary-shaped lines sharing one
 * indentation and marker — see `SUMMARY_BLOCK_LINE` for why membership is
 * decided by that looser shape and not by `SUMMARY_LINE`. Keys absent from that
 * block are left undefined so `decide` fails closed rather than defaulting them
 * to zero.
 */
export function parseSummary(output) {
  let block = [];
  let blockPrefix = null;
  let lastBlock = [];

  const endBlock = () => {
    if (block.length > 0) lastBlock = block;
    block = [];
    blockPrefix = null;
  };

  for (const rawLine of String(output).replace(ANSI_ESCAPE, '').split(/\r?\n/)) {
    const member = SUMMARY_BLOCK_LINE.exec(rawLine);
    if (member === null) {
      endBlock();
      continue;
    }
    const prefix = `${member[1]}${member[2]}`;
    if (blockPrefix !== null && prefix !== blockPrefix) endBlock();
    blockPrefix = prefix;
    block.push(rawLine);
  }
  endBlock();

  const counts = {};
  for (const rawLine of lastBlock) {
    const match = SUMMARY_LINE.exec(rawLine);
    if (match !== null) counts[match[1]] = Number.parseInt(match[2], 10);
  }
  return counts;
}

/**
 * Decide the verdict from the child's own exit status and the parsed counts.
 * Kept separate from the spawn so the gating rules can be exercised against a
 * captured run without launching the suite again.
 *
 * Precedence, in order:
 *   1. A nonzero child exit is the authoritative gate status, so it wins even
 *      when the summary is missing — a suite that died before printing its
 *      totals failed as a suite, it did not fail as a harness.
 *   2. An unparseable summary after a clean exit is a harness failure. Failing
 *      closed here is the point: a reporter change that hides the counts must
 *      never be able to read as "all counts matched".
 *   3. More failures than expected is a suite failure even on a clean exit.
 *   4. Anything else that moved is a count mismatch.
 */
export function decide({ childExit, counts, expected }) {
  const missing = SUMMARY_KEYS.filter((key) => counts[key] === undefined);

  if (childExit !== 0) {
    return {
      verdict: 'SUITE-FAIL',
      exitCode: EXIT_SUITE_FAIL,
      reasons: [
        `test suite exited ${childExit}`,
        ...(missing.length > 0 ? [`summary block was incomplete (missing: ${missing.join(', ')})`] : []),
      ],
    };
  }

  if (missing.length > 0) {
    return {
      verdict: 'HARNESS-ERROR',
      exitCode: EXIT_HARNESS_ERROR,
      reasons: [
        `could not parse the test summary block (missing: ${missing.join(', ')})`,
        'the suite exited 0, but with no counts to check this gate cannot pass',
      ],
    };
  }

  if (counts.fail > expected.fail) {
    return {
      verdict: 'SUITE-FAIL',
      exitCode: EXIT_SUITE_FAIL,
      reasons: [`fail: expected ${expected.fail}, got ${counts.fail}`],
    };
  }

  const reasons = [];
  for (const [key, want] of [
    ['pass', expected.pass],
    ['skipped', expected.skipped],
    ['fail', expected.fail],
    ...ALWAYS_ZERO_KEYS.map((key) => [key, 0]),
  ]) {
    if (counts[key] !== want) reasons.push(`${key}: expected ${want}, got ${counts[key]}`);
  }
  if (reasons.length > 0) {
    return { verdict: 'COUNT-MISMATCH', exitCode: EXIT_COUNT_MISMATCH, reasons };
  }

  return { verdict: 'PASS', exitCode: EXIT_OK, reasons: [] };
}

/**
 * Run the suite as a real child process, streaming its output through live so
 * CI logs stay readable while the same bytes are buffered for parsing.
 *
 * Deliberately not a shell pipeline: piping the suite into a parser would hand
 * back the parser's status and let a failing inner gate report success. The
 * child's own exit code is resolved here and gated on by the caller.
 */
export function runSuite({ command, args, cwd = REPO_ROOT }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      // Nothing in the suite reads stdin, and leaving it open can wedge a CI
      // leg on a child that decides to wait for input.
      stdio: ['ignore', 'pipe', 'pipe'],
      // No `shell` option, on any platform. See `suiteCommand` below.
    });

    // Both streams still go through to the parent live and in arrival order, so
    // the CI log is unchanged, but they are buffered apart because only stdout
    // is parsed: the reporter writes the summary there, and a stderr write that
    // lands mid-line would corrupt a summary line in a merged buffer. That
    // fails closed rather than green, but a noisy runner reporting a harness
    // error it did not have is an avoidable flake.
    const stdoutChunks = [];
    const stderrChunks = [];
    const capture = (stream, sink, chunks) => {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        chunks.push(chunk);
        sink.write(chunk);
      });
    };
    capture(child.stdout, process.stdout, stdoutChunks);
    capture(child.stderr, process.stderr, stderrChunks);

    child.on('error', (error) => reject(error));
    child.on('close', (code, signal) => {
      resolve({
        // A signalled death has no exit code; report it as a nonzero status so
        // it can never be mistaken for a clean run.
        exitCode: code === null ? 128 : code,
        signal,
        // `output` is the stdout buffer and is the only thing parsed; stderr is
        // returned alongside it for callers that want the whole picture.
        output: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
      });
    });
  });
}

/** The `scripts.test` prefix this gate requires before it will spawn anything. */
const REQUIRED_TEST_SCRIPT_PREFIX = ['node', '--test'];

/**
 * Tokens that mean something to a shell and nothing to a direct spawn. The
 * child is spawned with no shell, so a chained or redirected test script would
 * not be executed as written: `&&` and everything after it would arrive as
 * literal argv entries and the first command would run with arguments it never
 * asked for. Matched as WHOLE tokens, so a value that merely contains one of
 * these characters (`--test-name-pattern=foo|bar`) is untouched.
 */
const SHELL_OPERATOR_TOKENS = new Set(['&&', '||', ';', '|', '&', '>', '>>', '<', '<<']);

/**
 * Turn `package.json`'s `scripts.test` into the argv this gate spawns, and
 * refuse anything that is not the shape it was written against.
 *
 * The shape check is deliberate drift detection, not defensive noise. This gate
 * only means something if it runs what `npm test` runs; a future edit that
 * pointed the test script at another runner, wrapped it, or chained commands
 * would otherwise be token-sliced into something else that still printed a
 * plausible count. Refusing (exit 3) is the only outcome that makes such an
 * edit visible instead of silently changing what is being asserted.
 *
 * Only the leading `node` is dropped: it is replaced by `process.execPath`, so
 * the child is the same Node binary running this script rather than whatever a
 * PATH lookup would have found.
 */
export function suiteArgsFromTestScript(testScript, { testTimeoutMs } = {}) {
  const script = String(testScript ?? '');
  const tokens = script.trim().split(/\s+/).filter((token) => token.length > 0);

  if (REQUIRED_TEST_SCRIPT_PREFIX.some((want, index) => tokens[index] !== want)) {
    const found = tokens.length === 0 ? '(empty)' : tokens.slice(0, REQUIRED_TEST_SCRIPT_PREFIX.length).join(' ');
    throw new Error(
      `package.json scripts.test must start with ${JSON.stringify(REQUIRED_TEST_SCRIPT_PREFIX.join(' '))}, ` +
        `found ${JSON.stringify(found)} in ${JSON.stringify(script)}`,
    );
  }

  const operator = tokens.find((token) => SHELL_OPERATOR_TOKENS.has(token));
  if (operator !== undefined) {
    throw new Error(
      `package.json scripts.test contains the shell operator ${JSON.stringify(operator)}, which a ` +
        `direct spawn cannot honour, in ${JSON.stringify(script)}`,
    );
  }

  // Splitting on whitespace cannot preserve a quoted argument that contains a
  // space, so a test script that needed one would also have to be rejected
  // here. None does today, and the prefix check above is what a future one runs
  // into first.
  const args = tokens.slice(1);
  if (testTimeoutMs === undefined) return args;

  // `--test-timeout=<ms>` goes immediately after `--test`. Spawning Node
  // directly is the ONLY route that carries it; both alternatives were measured
  // on 2026-08-22, Node v24.13.0:
  //
  //  * NODE_OPTIONS is refused outright. `NODE_OPTIONS='--test-timeout=5000'`
  //    dies with `node: --test-timeout= is not allowed in NODE_OPTIONS`,
  //    exit 9.
  //  * `npm test -- <node flags>` does not forward them as Node options. Proven
  //    with a control: `npm test -- --test-reporter=tap` still emitted the spec
  //    reporter, so `npm test -- --test-timeout=...` would have been a silent
  //    no-op rather than a gate.
  //  * Passed straight to `node --test` it works. A synthetic test sleeping
  //    3000ms under `--test-timeout=500` produced `pass 0`, `fail 0`, exit 1.
  //    Note the COUNTING: a timed-out test is counted as `cancelled`, not as
  //    `fail`. `decide` above already fails on any nonzero `cancelled` and on
  //    any nonzero child exit, so a bounded hang is caught on both paths
  //    without relaxing or adding a rule.
  //
  // The value has to sit far ABOVE the slowest legitimate test, because an
  // aggressive one is actively harmful rather than merely tight: at
  // `--test-timeout=2000`, `tests/broker-e2e.test.ts` produced no output at all
  // within 120 seconds, while the same file at 30000 and with no timeout both
  // completed identically (14 tests, 14 pass, 30.0 seconds). Legitimate tests
  // reach ~20.5 seconds on the development machine and run slower on hosted
  // runners. This flag is a bound on a hang, not a performance budget.
  return [args[0], `--test-timeout=${testTimeoutMs}`, ...args.slice(1)];
}

/**
 * The command the suite runs under, derived from `package.json` rather than
 * hardcoded here, so this gate and `npm test` cannot drift apart unnoticed.
 *
 * Node is spawned DIRECTLY instead of through `npm test`, with no `shell`
 * option on any platform. Three reasons, in order of how much they cost:
 *
 *  * A per-test timeout cannot reach Node any other way — see the injection
 *    site in `suiteArgsFromTestScript` for the two routes that were measured
 *    and rejected.
 *  * `npm` is `npm.cmd` on Windows and Node will not spawn a `.cmd` without a
 *    shell, so the npm route put `cmd.exe` between this gate and the runner on
 *    exactly the platform whose behaviour is least reproducible locally.
 *  * `close` fires only once every inherited stdio pipe has closed, so any
 *    process the suite leaves behind can wedge this gate indefinitely after the
 *    suite itself has finished. Every intermediate process removed is one fewer
 *    holder of those pipes.
 *
 * Nothing is lost by dropping the shell: Node expands the `tests/*.test.ts`
 * glob itself when spawned without one (measured 2026-08-22 on Node v24.13.0 —
 * `['--test', '--import', 'tsx', 'tests/adapter-*.test.ts']` ran 18 tests with
 * no shell), and the full suite through this path was measured identical to
 * `npm test`: exit 0, 594 tests / 594 pass / 0 fail / 0 cancelled / 0 skipped.
 */
export function suiteCommand({ cwd = REPO_ROOT, testTimeoutMs } = {}) {
  const manifestPath = join(cwd, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`could not read the test script out of ${manifestPath}: ${error.message}`);
  }
  return {
    command: process.execPath,
    args: suiteArgsFromTestScript(manifest?.scripts?.test, { testTimeoutMs }),
    cwd,
  };
}

function parseNonNegativeInteger(value, flag) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${flag} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return Number.parseInt(value, 10);
}

/**
 * Stricter than `parseNonNegativeInteger` because zero is not a usable timeout:
 * `--test-timeout=0` would be a request the runner cannot honour, and silently
 * accepting it would turn a typo into an unbounded run.
 */
function parsePositiveInteger(value, flag) {
  if (!/^\d+$/.test(value) || Number.parseInt(value, 10) === 0) {
    throw new Error(`${flag} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return Number.parseInt(value, 10);
}

export function parseCliArguments(argv) {
  const { values } = parseArgs({
    args: argv,
    // Strict, and no positionals: an unknown or misspelled flag has to be an
    // error, otherwise a workflow typo silently downgrades the gate.
    strict: true,
    allowPositionals: false,
    options: {
      'expect-pass': { type: 'string' },
      'expect-skipped': { type: 'string' },
      'expect-fail': { type: 'string' },
      // Optional. Absent means no per-test timeout is injected at all and the
      // suite runs exactly as `npm test` would.
      'test-timeout-ms': { type: 'string' },
      label: { type: 'string' },
    },
  });

  for (const required of ['expect-pass', 'expect-skipped']) {
    if (values[required] === undefined) throw new Error(`--${required} is required`);
  }

  return {
    expected: {
      pass: parseNonNegativeInteger(values['expect-pass'], '--expect-pass'),
      skipped: parseNonNegativeInteger(values['expect-skipped'], '--expect-skipped'),
      fail: values['expect-fail'] === undefined ? 0 : parseNonNegativeInteger(values['expect-fail'], '--expect-fail'),
    },
    testTimeoutMs:
      values['test-timeout-ms'] === undefined
        ? undefined
        : parsePositiveInteger(values['test-timeout-ms'], '--test-timeout-ms'),
    label: values.label ?? '-',
  };
}

/** One grep-able line per run, printed on every path including the failures. */
export function formatReceipt({ label, childExit, counts, expected, verdict, testTimeoutMs }) {
  const count = (key) => (counts[key] === undefined ? UNKNOWN_COUNT : String(counts[key]));
  // Appended at the END, after `verdict`, on purpose: the workflow's receipt
  // reader matches whole `name=value` tokens anywhere on the line, so a new
  // trailing field is free while reordering or renaming an existing one is not.
  const timeout = testTimeoutMs === undefined || testTimeoutMs === null ? 'none' : String(testTimeoutMs);
  return (
    `ASSERT-TEST-COUNTS ${label} child_exit=${childExit} ` +
    `tests=${count('tests')} pass=${count('pass')} fail=${count('fail')} skipped=${count('skipped')} ` +
    `cancelled=${count('cancelled')} todo=${count('todo')} ` +
    `expected_pass=${expected.pass} expected_skipped=${expected.skipped} expected_fail=${expected.fail} ` +
    `verdict=${verdict} test_timeout_ms=${timeout}`
  );
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseCliArguments(argv);
  } catch (error) {
    process.stderr.write(
      `assert-test-counts: ${error.message}\n` +
        'usage: node scripts/assert-test-counts.mjs --expect-pass <n> --expect-skipped <n> ' +
        '[--expect-fail <n>] [--test-timeout-ms <n>] [--label <text>]\n',
    );
    process.stdout.write(
      `${formatReceipt({
        label: '-',
        childExit: UNKNOWN_COUNT,
        counts: {},
        expected: { pass: UNKNOWN_COUNT, skipped: UNKNOWN_COUNT, fail: UNKNOWN_COUNT },
        verdict: 'HARNESS-ERROR',
        // Not `none`: the arguments never parsed, so which timeout would have
        // been in force is unknown, exactly like every other field on this line.
        testTimeoutMs: UNKNOWN_COUNT,
      })}\n`,
    );
    return EXIT_HARNESS_ERROR;
  }

  const { expected, label, testTimeoutMs } = parsed;
  let run;
  try {
    // Both the `scripts.test` shape check and the spawn itself land here: a
    // test script this gate no longer recognises is a harness failure in the
    // same sense a failed spawn is, and both have to be loud rather than green.
    run = await runSuite(suiteCommand({ testTimeoutMs }));
  } catch (error) {
    process.stderr.write(`assert-test-counts: could not run the test suite: ${error.message}\n`);
    process.stdout.write(
      `${formatReceipt({ label, childExit: UNKNOWN_COUNT, counts: {}, expected, verdict: 'HARNESS-ERROR', testTimeoutMs })}\n`,
    );
    return EXIT_HARNESS_ERROR;
  }

  const counts = parseSummary(run.output);
  const { verdict, exitCode, reasons } = decide({ childExit: run.exitCode, counts, expected });

  if (exitCode !== EXIT_OK) {
    const seen = (key) => (counts[key] === undefined ? UNKNOWN_COUNT : String(counts[key]));
    process.stderr.write(
      `\nassert-test-counts: ${verdict} for ${label}\n` +
        `${reasons.map((reason) => `  - ${reason}\n`).join('')}` +
        `  child exit: ${run.exitCode}${run.signal ? ` (signal ${run.signal})` : ''}\n` +
        `  counts (expected vs actual):\n` +
        `    pass:      ${expected.pass} vs ${seen('pass')}\n` +
        `    skipped:   ${expected.skipped} vs ${seen('skipped')}\n` +
        `    fail:      ${expected.fail} vs ${seen('fail')}\n` +
        `    cancelled: 0 vs ${seen('cancelled')}\n` +
        `    todo:      0 vs ${seen('todo')}\n` +
        `    tests:     (not asserted) ${seen('tests')}\n`,
    );
  }

  process.stdout.write(
    `${formatReceipt({ label, childExit: run.exitCode, counts, expected, verdict, testTimeoutMs })}\n`,
  );
  return exitCode;
}

/**
 * Only run when invoked as a script. The helpers above stay importable so the
 * gating rules can be checked against a captured run without spending a full
 * suite execution on it.
 */
function invokedAsScript() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsScript()) {
  process.exitCode = await main(process.argv.slice(2));
}
