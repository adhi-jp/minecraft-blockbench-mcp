// Unit coverage for the pure parts of the AC-21 scope-isolation live smoke.
//
// The live path needs a real Blockbench, a real plugin, and a human, so it
// cannot run here. What can run here is everything that decides what the live
// run means: how arguments are read, where this run's own broker record lives,
// which process the helper is willing to signal, how one scoped call by the
// second client is classified, and — the part that matters most — the verdict
// model, which must never let a scenario that was not driven come back as a
// pass.
//
// These tests take the host platform as a parameter rather than reading it, so
// the Windows and POSIX branches of the helper are both exercised on every
// machine in the matrix and no host narrowing appears in this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';

import {
  SCOPE_DENIAL_CODES,
  SmokeError,
  adapterEnvForMode,
  assertKillableBrokerRecord,
  brokerRecordPathFor,
  buildSmokeReport,
  classifyScopedAttempt,
  classifySetupIssue,
  classifyToolFailure,
  createRunDirectory,
  decideVerdict,
  describeHumanStep,
  disruptionForMode,
  expectedModeForPlatform,
  generateReviewChecklist,
  helpText,
  parseSmokeArgs,
  resolveModeRequest,
  sanitizeForReport,
  selectRunDirectory,
  verdictExitCode,
} from '../scripts/smoke-scope-isolation.mjs';

/**
 * Parents for the run-directory tests. The helper resolves `--out` with
 * `path.resolve`, which is absolute-path-preserving but host-relative, so a
 * POSIX literal would come back drive-prefixed on Windows. Building them from
 * the host's own temp directory keeps `resolve` the identity on them and the
 * assertions exact whole-path comparisons. Neither creates anything on disk.
 */
const SMOKE_OUT_PARENT = join(tmpdir(), 'ac21-smoke-out');
const SMOKE_RUN_PARENT = join(tmpdir(), 'ac21-smoke-parent');
const SMOKE_SCOPE_DIR = join(tmpdir(), 'ac21-smoke-scope');

/** A fully satisfied set of phase records: the one input shape that is allowed
 * to produce PASS. Every INCONCLUSIVE test below starts from this and removes
 * exactly one thing, so each gate is shown to be load-bearing on its own. */
function satisfiedPhases(): Record<string, unknown> {
  return {
    establish: {
      status: 'passed',
      scope_confirmed: true,
      positive_control: { write_ok: true, read_ok: true, content_matched: true },
    },
    disrupt: { status: 'passed', applied: true, kind: 'broker_crash', plugin_reconnected: true },
    assert: {
      status: 'observed',
      negative_controls: { health_ok: true, get_plugin_status_ok: true },
      plugin_scope_state: 'revoked',
      scoped_operation: { command: 'read_file', outcome: 'denied_by_invariant', code: 'E_SCOPE_REVOKED' },
    },
    reestablish: { status: 'passed', scope_confirmed: true, content_matched: true },
  };
}

test('parseSmokeArgs prefers the env secret and accepts mode, port, output, scope, and timeout overrides', () => {
  const options = parseSmokeArgs(
    ['--mode', 'brokered', '--port', '40123', '--out', SMOKE_OUT_PARENT, '--scope-dir', SMOKE_SCOPE_DIR, '--timeout-ms=120000', '--confirm-timeout-ms', '240000', '--reconnect-timeout-ms', '90000', '--no-prompt'],
    { BLOCKBENCH_MCP_SECRET: 'env-secret', BLOCKBENCH_MCP_PORT: '39731' },
  );

  assert.equal(options.mode, 'brokered');
  assert.equal(options.port, 40123);
  assert.equal(options.secret, 'env-secret');
  assert.equal(options.authSource, 'environment');
  assert.equal(options.lessSafeSecretFlag, false);
  assert.equal(options.outParent, SMOKE_OUT_PARENT);
  assert.equal(options.scopeDir, SMOKE_SCOPE_DIR);
  assert.equal(options.timeoutMs, 120_000);
  assert.equal(options.confirmTimeoutMs, 240_000);
  assert.equal(options.reconnectTimeoutMs, 90_000);
  assert.equal(options.prompt, false);
});

test('parseSmokeArgs defaults to the auto mode and keeps the less-safe CLI secret flag distinguishable', () => {
  const defaults = parseSmokeArgs([], { BLOCKBENCH_MCP_SECRET: 'env-secret' });
  assert.equal(defaults.mode, 'auto');
  assert.equal(defaults.prompt, true);
  assert.equal(defaults.authSource, 'environment');

  const overridden = parseSmokeArgs(['--secret', 'cli-secret'], { BLOCKBENCH_MCP_SECRET: 'env-secret' });
  assert.equal(overridden.secret, 'cli-secret');
  assert.equal(overridden.authSource, 'cli');
  assert.equal(overridden.lessSafeSecretFlag, true);

  const missing = parseSmokeArgs([], {});
  assert.equal(missing.secret, undefined);
  assert.equal(missing.authSource, 'missing');
});

test('parseSmokeArgs rejects missing values, out-of-range numbers, unknown options, and unknown modes', () => {
  assert.throws(() => parseSmokeArgs(['--port', '0'], { BLOCKBENCH_MCP_SECRET: 's' }), /--port/);
  assert.throws(() => parseSmokeArgs(['--out'], { BLOCKBENCH_MCP_SECRET: 's' }), /Missing value/);
  assert.throws(() => parseSmokeArgs(['--unknown'], { BLOCKBENCH_MCP_SECRET: 's' }), /Unknown option/);
  assert.throws(() => parseSmokeArgs(['--mode', 'sideways'], { BLOCKBENCH_MCP_SECRET: 's' }), /--mode must be one of/);
  assert.throws(() => parseSmokeArgs(['--secret', ''], { BLOCKBENCH_MCP_SECRET: 's' }), /--secret/);
});

test('helpText documents the three verdicts and their distinct exit codes', () => {
  const help = helpText();

  assert.match(help, /0\s+PASS/);
  assert.match(help, /1\s+FAIL/);
  assert.match(help, /2\s+INCONCLUSIVE/);
  assert.match(help, /never a pass/);
  assert.match(help, /--mode/);
});

test('selectRunDirectory names each run uniquely under the chosen parent', () => {
  const selected = selectRunDirectory({
    outParent: SMOKE_RUN_PARENT,
    now: new Date('2026-08-23T01:02:03.004Z'),
    randomHex: 'abcd1234',
  });

  assert.equal(selected.parent, SMOKE_RUN_PARENT);
  assert.equal(selected.runId, 'ac21-scope-isolation-smoke-2026-08-23T01-02-03-004Z-abcd1234');
  assert.equal(selected.runDir, join(SMOKE_RUN_PARENT, 'ac21-scope-isolation-smoke-2026-08-23T01-02-03-004Z-abcd1234'));
});

test('createRunDirectory refuses to overwrite an existing run directory', async (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'ac21-smoke-test-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const fixed = { outParent: parent, now: new Date('2026-08-23T01:02:03.004Z'), randomHex: 'abcd1234' };

  const first = await createRunDirectory(fixed);
  assert.equal(existsSync(first.runDir), true);

  await assert.rejects(() => createRunDirectory(fixed), (error) => {
    assert.equal(error instanceof SmokeError, true);
    assert.equal((error as SmokeError).code, 'E_FILE_EXISTS');
    return true;
  });
});

test('the platform default mode and its disruption mirror the adapter: brokered on POSIX, direct on Windows', () => {
  assert.equal(expectedModeForPlatform('linux'), 'brokered');
  assert.equal(expectedModeForPlatform('darwin'), 'brokered');
  assert.equal(expectedModeForPlatform('win32'), 'direct');

  const windowsAuto = resolveModeRequest({ requested: 'auto', platform: 'win32' });
  assert.equal(windowsAuto.platformDefault, 'direct');
  assert.equal(windowsAuto.expected, 'direct');

  const windowsBrokered = resolveModeRequest({ requested: 'brokered', platform: 'win32' });
  assert.equal(windowsBrokered.platformDefault, 'direct');
  assert.equal(windowsBrokered.expected, 'brokered');

  const posixDirect = resolveModeRequest({ requested: 'direct', platform: 'darwin' });
  assert.equal(posixDirect.platformDefault, 'brokered');
  assert.equal(posixDirect.expected, 'direct');

  // AC-21 names both disruptions; each mode gets the one that is meaningful.
  assert.equal(disruptionForMode('brokered').kind, 'broker_crash');
  assert.equal(disruptionForMode('direct').kind, 'adapter_restart');
});

test('adapterEnvForMode always writes or removes both mode switches so an inherited one cannot decide the run', () => {
  const inherited = { BLOCKBENCH_MCP_DIRECT: '1', BLOCKBENCH_MCP_BROKER: '1', PATH: '/usr/bin' };

  const brokered = adapterEnvForMode('brokered', inherited);
  assert.equal(brokered.BLOCKBENCH_MCP_BROKER, '1');
  assert.equal(brokered.BLOCKBENCH_MCP_DIRECT, undefined);
  assert.equal(brokered.PATH, '/usr/bin');

  const direct = adapterEnvForMode('direct', inherited);
  assert.equal(direct.BLOCKBENCH_MCP_DIRECT, '1');
  assert.equal(direct.BLOCKBENCH_MCP_BROKER, undefined);

  // The caller resolves `auto` to a concrete mode before this is called, so an
  // unrecognised value must still strip both rather than leaving one behind.
  const neither = adapterEnvForMode('auto', inherited);
  assert.equal(neither.BLOCKBENCH_MCP_DIRECT, undefined);
  assert.equal(neither.BLOCKBENCH_MCP_BROKER, undefined);
  assert.equal(inherited.BLOCKBENCH_MCP_DIRECT, '1');
});

test('brokerRecordPathFor reproduces the adapter runtime-directory rules on both platform branches', () => {
  const posixConfig = '/tmp/ac21-run/adapter-config.json';
  const posixIdentity = createHash('sha256').update(posixConfig).digest('hex').slice(0, 16);

  const withoutOverride = brokerRecordPathFor({ resolvedConfigPath: posixConfig, platform: 'linux' });
  assert.equal(withoutOverride.configIdentity, posixIdentity);
  assert.equal(withoutOverride.runtimeDir, posix.join('/tmp/ac21-run', 'run'));
  assert.equal(withoutOverride.recordPath, `${posix.join('/tmp/ac21-run', 'run')}/broker-${posixIdentity}.json`);

  const withOverride = brokerRecordPathFor({ resolvedConfigPath: posixConfig, platform: 'linux', runtimeDirOverride: '/tmp/bbmcp-override' });
  assert.equal(withOverride.runtimeDir, posix.join('/tmp/bbmcp-override', 'minecraft-blockbench-mcp'));

  // A blank or relative BLOCKBENCH_MCP_RUNTIME_DIR is ignored, exactly as the
  // adapter ignores it, so the two never disagree about which record to read.
  assert.equal(brokerRecordPathFor({ resolvedConfigPath: posixConfig, platform: 'linux', runtimeDirOverride: '  ' }).runtimeDir, withoutOverride.runtimeDir);
  assert.equal(brokerRecordPathFor({ resolvedConfigPath: posixConfig, platform: 'linux', runtimeDirOverride: 'relative/dir' }).runtimeDir, withoutOverride.runtimeDir);

  const windowsConfig = 'C:\\smoke\\ac21-run\\adapter-config.json';
  const windowsIdentity = createHash('sha256').update(windowsConfig).digest('hex').slice(0, 16);
  const windows = brokerRecordPathFor({ resolvedConfigPath: windowsConfig, platform: 'win32' });
  assert.equal(windows.configIdentity, windowsIdentity);
  assert.equal(windows.runtimeDir, win32.join('C:\\smoke\\ac21-run', 'run'));
  assert.equal(windows.recordPath, `${win32.join('C:\\smoke\\ac21-run', 'run')}/broker-${windowsIdentity}.json`);
  assert.notEqual(windows.configIdentity, posixIdentity);
});

test('assertKillableBrokerRecord signals only a record that is recognisably the broker this run started', () => {
  const record = { broker_pid: 4242, ws_port: 39731, endpoint: '/run/x.sock', broker_instance_id: 'abc' };
  assert.equal(assertKillableBrokerRecord(record, { port: 39731, selfPid: 11 }), 4242);

  assert.throws(() => assertKillableBrokerRecord(null, { port: 39731, selfPid: 11 }), /no broker crash could be applied/);
  assert.throws(() => assertKillableBrokerRecord({ broker_pid: 0, ws_port: 39731 }, { port: 39731, selfPid: 11 }), /usable broker pid/);
  assert.throws(() => assertKillableBrokerRecord({ broker_pid: -3, ws_port: 39731 }, { port: 39731, selfPid: 11 }), /usable broker pid/);
  assert.throws(() => assertKillableBrokerRecord({ broker_pid: 11, ws_port: 39731 }, { port: 39731, selfPid: 11 }), /own pid/);
  assert.throws(() => assertKillableBrokerRecord({ broker_pid: 4242, ws_port: 40000 }, { port: 39731, selfPid: 11 }), /different WebSocket port/);
});

test('sanitizeForReport redacts known secrets, base64 secrets, secret-like keys, and the operator home path', () => {
  const secret = 'top-secret-value';
  const home = '/home/tester';
  const sanitized = sanitizeForReport(
    {
      message: `do not leak ${secret}`,
      encoded: Buffer.from(secret, 'utf8').toString('base64'),
      nested: { sharedSecret: secret, token: 'abc', scope_dir: `${home}/projects/scope` },
      windowsPath: 'C:\\Users\\tester\\AppData\\Local\\Temp\\run',
    },
    [secret],
    home,
  );
  const serialized = JSON.stringify(sanitized);

  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(Buffer.from(secret, 'utf8').toString('base64')), false);
  assert.equal(serialized.includes(home), false);
  assert.equal((sanitized as { nested: { scope_dir: string } }).nested.scope_dir, '~/projects/scope');
  assert.equal((sanitized as { nested: { sharedSecret: string; token: string } }).nested.sharedSecret, '[redacted]');
  assert.equal((sanitized as { nested: { token: string } }).nested.token, '[redacted]');

  const windows = sanitizeForReport({ path: 'C:\\Users\\tester\\run\\file.txt' }, [], 'C:\\Users\\tester');
  assert.equal((windows as { path: string }).path, '~\\run\\file.txt');
});

test('classifyScopedAttempt separates a grant, a scoped-state denial, and a denial for some other reason', () => {
  const probe = 'ac21-probe-content';

  const granted = classifyScopedAttempt({ ok: true, result: { content: probe, bytes: 18 } }, probe);
  assert.equal(granted.outcome, 'granted');
  assert.equal(granted.content_matched_prior_client_probe, true);
  assert.equal(granted.code, null);

  const grantedOther = classifyScopedAttempt({ ok: true, result: { content: 'something else', bytes: 3 } }, probe);
  assert.equal(grantedOther.outcome, 'granted');
  assert.equal(grantedOther.content_matched_prior_client_probe, false);

  for (const code of SCOPE_DENIAL_CODES) {
    const denied = classifyScopedAttempt({ ok: false, error: { code, message: 'no' } }, probe);
    assert.equal(denied.outcome, 'denied_by_invariant');
    assert.equal(denied.code, code);
  }

  const otherDenial = classifyScopedAttempt({ ok: false, error: { code: 'E_PLUGIN_NOT_CONNECTED', message: 'gone' } }, probe);
  assert.equal(otherDenial.outcome, 'denied_other');
  assert.equal(otherDenial.content_matched_prior_client_probe, false);
});

test('decideVerdict reports FAIL for an observed grant even when the rest of the run is incomplete', () => {
  const phases = satisfiedPhases();
  (phases.assert as Record<string, unknown>).scoped_operation = {
    command: 'read_file',
    outcome: 'granted',
    code: null,
    content_matched_prior_client_probe: true,
  };

  const decided = decideVerdict(phases);
  assert.equal(decided.verdict, 'FAIL');
  assert.equal(decided.code, 'E_AC21_SCOPE_INHERITED');
  assert.match(decided.message, /invariant was violated/);

  // A grant is a violation however the run got there, so it outranks every
  // missing precondition rather than being masked by one.
  const barelyRun = {
    establish: { status: 'failed' },
    disrupt: { status: 'not_run', applied: false },
    assert: { scoped_operation: { outcome: 'granted' } },
    reestablish: { status: 'not_run' },
  };
  assert.equal(decideVerdict(barelyRun).verdict, 'FAIL');
});

test('decideVerdict returns PASS only when all four phases are affirmatively satisfied', () => {
  const decided = decideVerdict(satisfiedPhases());

  assert.equal(decided.verdict, 'PASS');
  assert.equal(decided.code, 'AC21_SCOPE_ISOLATION_HELD');
  assert.deepEqual(decided.remediation, []);
  assert.match(decided.message, /refused the same operation/);
});

test('decideVerdict turns every missing precondition into INCONCLUSIVE rather than a pass', () => {
  const cases: Array<{ name: string; code: string; mutate: (phases: Record<string, any>) => void }> = [
    { name: 'no phases at all', code: 'E_AC21_ESTABLISH_INCOMPLETE', mutate: () => undefined },
    { name: 'positive control never proved', code: 'E_AC21_ESTABLISH_INCOMPLETE', mutate: (p) => { p.establish.status = 'failed'; } },
    { name: 'disruption never applied', code: 'E_AC21_DISRUPTION_NOT_APPLIED', mutate: (p) => { p.disrupt.applied = false; } },
    { name: 'plugin never seen to reconnect', code: 'E_AC21_RECONNECT_NOT_OBSERVED', mutate: (p) => { p.disrupt.plugin_reconnected = false; } },
    { name: 'assertion never attempted', code: 'E_AC21_ASSERTION_NOT_REACHED', mutate: (p) => { p.assert.status = 'not_run'; delete p.assert.scoped_operation; } },
    { name: 'adapter-level control failed', code: 'E_AC21_NEGATIVE_CONTROL_FAILED', mutate: (p) => { p.assert.negative_controls.health_ok = false; } },
    { name: 'plugin round-trip control failed', code: 'E_AC21_NEGATIVE_CONTROL_FAILED', mutate: (p) => { p.assert.negative_controls.get_plugin_status_ok = false; } },
    { name: 'grant expired with a reloaded plugin instead of being revoked', code: 'E_AC21_SCOPE_NOT_REVOKED', mutate: (p) => { p.assert.plugin_scope_state = 'expired'; } },
    { name: 'plugin never held a grant to revoke', code: 'E_AC21_SCOPE_NOT_REVOKED', mutate: (p) => { p.assert.plugin_scope_state = 'unconfirmed'; } },
    { name: 'denied for a reason that is not the scope state', code: 'E_AC21_DENIAL_NOT_SCOPED', mutate: (p) => { p.assert.scoped_operation = { outcome: 'denied_other', code: 'E_PLUGIN_NOT_CONNECTED' }; } },
    { name: 'a fresh confirmation did not restore access', code: 'E_AC21_RECOVERY_UNPROVEN', mutate: (p) => { p.reestablish.status = 'failed'; } },
  ];

  for (const item of cases) {
    const phases = satisfiedPhases();
    item.mutate(phases as Record<string, any>);
    const decided = decideVerdict(item.name === 'no phases at all' ? {} : phases);
    assert.equal(decided.verdict, 'INCONCLUSIVE', `${item.name} must not be a pass`);
    assert.equal(decided.code, item.code, item.name);
    assert.ok(decided.remediation.length > 0, `${item.name} must tell the operator what to fix`);
  }
});

test('verdictExitCode keeps INCONCLUSIVE non-zero and distinct from FAIL', () => {
  assert.equal(verdictExitCode('PASS'), 0);
  assert.equal(verdictExitCode('FAIL'), 1);
  assert.equal(verdictExitCode('INCONCLUSIVE'), 2);
  assert.notEqual(verdictExitCode('INCONCLUSIVE'), verdictExitCode('FAIL'));
  assert.notEqual(verdictExitCode('INCONCLUSIVE'), verdictExitCode('PASS'));
  // Anything unrecognised is treated as not-run, never as a pass.
  assert.equal(verdictExitCode('something-else'), 2);
});

test('buildSmokeReport records the observed mode and the verdict without leaking secrets or home paths', () => {
  const secret = 'report-secret';
  const home = '/home/tester';
  const report = buildSmokeReport({
    verdict: 'PASS',
    verdictReason: { code: 'AC21_SCOPE_ISOLATION_HELD', message: 'held', remediation: [] },
    startedAt: '2026-08-23T00:00:00.000Z',
    completedAt: '2026-08-23T00:05:00.000Z',
    options: {
      port: 39731,
      secret,
      authSource: 'environment',
      lessSafeSecretFlag: false,
      timeoutMs: 90_000,
      confirmTimeoutMs: 180_000,
      reconnectTimeoutMs: 120_000,
      prompt: true,
    },
    runDir: `${home}/runs/ac21`,
    scopeDir: `${home}/runs/ac21/scope-root`,
    modeRequest: { requested: 'auto', platformDefault: 'brokered', expected: 'brokered' },
    observedMode: 'brokered',
    clients: { a: { pid: 10, label: 'ac21-client-a' }, b: { pid: 11, label: 'ac21-client-b' } },
    phases: satisfiedPhases(),
    commands: [{ client: 'B', command: 'read_file', ok: false, error: { code: 'E_SCOPE_REVOKED' } }],
    knownSecrets: [secret],
    homeDir: home,
    runtime: { node: 'v22.0.0', platform: 'linux', arch: 'x64' },
  });
  const serialized = JSON.stringify(report);

  assert.equal(report.verdict, 'PASS');
  assert.equal(report.acceptance_criterion, 'AC-21');
  assert.equal(report.runtime.observed_mode, 'brokered');
  assert.equal(report.runtime.mode_honoured, true);
  assert.equal(report.config.requested_mode, 'auto');
  assert.equal(report.config.platform_default_mode, 'brokered');
  assert.equal(report.config.auth.source, 'environment');
  assert.equal(report.config.cli_auth_override_used, false);
  assert.equal(report.human_confirmation_required, true);
  assert.equal(report.config.scope_dir, '~/runs/ac21/scope-root');
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(home), false);
  assert.equal(report.phases.assert.scoped_operation.code, 'E_SCOPE_REVOKED');

  const mismatched = buildSmokeReport({
    verdict: 'INCONCLUSIVE',
    verdictReason: { code: 'E_AC21_MODE_NOT_HONOURED', message: 'wrong mode', remediation: [] },
    startedAt: '2026-08-23T00:00:00.000Z',
    options: { port: 1, authSource: 'missing', lessSafeSecretFlag: false, timeoutMs: 1_000, confirmTimeoutMs: 1_000, reconnectTimeoutMs: 1_000, prompt: false },
    runDir: '/runs',
    scopeDir: '/runs/scope',
    modeRequest: { requested: 'brokered', platformDefault: 'direct', expected: 'brokered' },
    observedMode: 'direct',
  });
  assert.equal(mismatched.runtime.mode_honoured, false);
  assert.equal(mismatched.config.auth.configured, false);
});

test('generateReviewChecklist and describeHumanStep tell the operator what to do before anything blocks', () => {
  const checklist = generateReviewChecklist({ reportFile: '/runs/smoke-report.json', scopeDir: '/runs/scope-root', mode: 'brokered', port: 40123 });

  assert.match(checklist, /40123/);
  assert.match(checklist, /First confirmation/);
  assert.match(checklist, /Second confirmation/);
  assert.match(checklist, /Do not touch Blockbench/);
  assert.match(checklist, /INCONCLUSIVE/);
  assert.match(checklist, /What to send back/);
  assert.match(checklist, /\/runs\/scope-root/);

  const first = describeHumanStep('confirm_a', { scopeDir: '/runs/scope-root', confirmTimeoutMs: 180_000 }).join('\n');
  assert.match(first, /PHASE 1 of 4/);
  assert.match(first, /\/runs\/scope-root/);
  assert.match(first, /120 seconds/);

  const disrupt = describeHumanStep('disrupt', {}).join('\n');
  assert.match(disrupt, /No human action is needed/);
  assert.match(disrupt, /do not reload the plugin/i);

  const assertStep = describeHumanStep('assert', {}).join('\n');
  assert.match(assertStep, /must be denied/);

  const second = describeHumanStep('confirm_b', { scopeDir: '/runs/scope-root' }).join('\n');
  assert.match(second, /PHASE 4 of 4/);
  assert.match(second, /second client/);
});

test('precondition classification gives actionable remediation without killing unknown processes', () => {
  const portConflict = classifySetupIssue({ code: 'E_PORT_IN_USE', message: 'busy' }, 40123);
  assert.equal(portConflict.category, 'port_conflict');
  assert.match(portConflict.remediation.join('\n'), /Do not kill unknown processes/);
  assert.match(portConflict.remediation.join('\n'), /same port/);

  const missingSecret = classifySetupIssue({ code: 'E_SECRET_MISSING' }, 40123);
  assert.equal(missingSecret.category, 'missing_secret');

  const brokerless = classifySetupIssue({ code: 'E_BROKER_UNAVAILABLE' }, 40123);
  assert.equal(brokerless.category, 'broker_unavailable');

  const disconnected = classifyToolFailure('read_file', { code: 'E_PLUGIN_NOT_CONNECTED' });
  assert.equal(disconnected.category, 'plugin_disconnected');
  assert.match(disconnected.remediation.join('\n'), /Leave Blockbench running/);

  const denied = classifyToolFailure('read_file', { code: 'E_SCOPE_REVOKED' });
  assert.equal(denied.category, 'scope_denied');
  assert.equal(denied.code, 'E_SCOPE_REVOKED');
});
