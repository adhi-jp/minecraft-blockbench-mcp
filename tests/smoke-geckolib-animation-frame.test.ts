import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SmokeError,
  buildSmokeReport,
  classifySetupIssue,
  classifyToolFailure,
  createRunDirectory,
  decodePngDataUrl,
  generateReviewChecklist,
  parseSmokeArgs,
  sanitizeForReport,
  selectRunDirectory,
  writePngDataUrl,
} from '../scripts/smoke-geckolib-animation-frame.mjs';

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

test('parseSmokeArgs prefers env secret and accepts port, output parent, and timeout overrides', () => {
  const options = parseSmokeArgs(['--port', '40123', '--out', '/tmp/gecko-smoke', '--timeout-ms=120000'], {
    BLOCKBENCH_MCP_SECRET: 'env-secret',
    BLOCKBENCH_MCP_PORT: '39731',
  });

  assert.equal(options.port, 40123);
  assert.equal(options.secret, 'env-secret');
  assert.equal(options.authSource, 'environment');
  assert.equal(options.lessSafeSecretFlag, false);
  assert.equal(options.outParent, '/tmp/gecko-smoke');
  assert.equal(options.timeoutMs, 120_000);
});

test('parseSmokeArgs supports the less-safe CLI secret flag without requiring raw argv in outputs', () => {
  const options = parseSmokeArgs(['--secret', 'cli-secret'], { BLOCKBENCH_MCP_SECRET: 'env-secret' });

  assert.equal(options.secret, 'cli-secret');
  assert.equal(options.authSource, 'cli');
  assert.equal(options.lessSafeSecretFlag, true);
});

test('parseSmokeArgs rejects missing and invalid option values', () => {
  assert.throws(() => parseSmokeArgs(['--port', '0'], { BLOCKBENCH_MCP_SECRET: 's' }), /--port/);
  assert.throws(() => parseSmokeArgs(['--out'], { BLOCKBENCH_MCP_SECRET: 's' }), /Missing value/);
  assert.throws(() => parseSmokeArgs(['--unknown'], { BLOCKBENCH_MCP_SECRET: 's' }), /Unknown option/);
});

test('selectRunDirectory creates unique GeckoLib live smoke run directories under the chosen parent', () => {
  const selected = selectRunDirectory({
    outParent: '/tmp/smoke-parent',
    now: new Date('2026-07-11T01:02:03.004Z'),
    randomHex: 'abcd1234',
  });

  assert.equal(selected.parent, '/tmp/smoke-parent');
  assert.equal(selected.runId, 'geckolib-live-smoke-2026-07-11T01-02-03-004Z-abcd1234');
  assert.equal(selected.runDir, '/tmp/smoke-parent/geckolib-live-smoke-2026-07-11T01-02-03-004Z-abcd1234');
});

test('createRunDirectory refuses to overwrite an existing run directory', async (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'gecko-smoke-test-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const fixed = { outParent: parent, now: new Date('2026-07-11T01:02:03.004Z'), randomHex: 'abcd1234' };

  const first = await createRunDirectory(fixed);
  assert.equal(existsSync(first.runDir), true);

  await assert.rejects(() => createRunDirectory(fixed), (error) => {
    assert.equal(error instanceof SmokeError, true);
    assert.equal((error as SmokeError).code, 'E_FILE_EXISTS');
    return true;
  });
});

test('decodePngDataUrl and writePngDataUrl validate PNG data URLs and hash bytes', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gecko-smoke-png-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const png = decodePngDataUrl(PNG_DATA_URL);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

  const file = join(dir, 'frame-0.png');
  const result = await writePngDataUrl(PNG_DATA_URL, file);
  assert.equal(result.bytes, readFileSync(file).length);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);

  assert.throws(() => decodePngDataUrl('data:image/jpeg;base64,AAAA'), /PNG/);
  assert.throws(() => decodePngDataUrl('data:image/png;base64,AAAA'), /PNG payload/);
});

test('sanitizeForReport redacts known secrets, base64 secrets, and secret-like keys', () => {
  const secret = 'top-secret-value';
  const sanitized = sanitizeForReport(
    {
      message: `do not leak ${secret}`,
      encoded: Buffer.from(secret, 'utf8').toString('base64'),
      nested: { sharedSecret: secret, token: 'abc' },
    },
    [secret],
  );
  const serialized = JSON.stringify(sanitized);

  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(Buffer.from(secret, 'utf8').toString('base64')), false);
  assert.equal((sanitized as { nested: { sharedSecret: string; token: string } }).nested.sharedSecret, '[redacted]');
  assert.equal((sanitized as { nested: { sharedSecret: string; token: string } }).nested.token, '[redacted]');
});

test('buildSmokeReport records human review handoff and excludes secrets and raw screenshot data', () => {
  const secret = 'report-secret';
  const report = buildSmokeReport({
    status: 'ready_for_human_review',
    startedAt: '2026-07-11T00:00:00.000Z',
    completedAt: '2026-07-11T00:00:01.000Z',
    options: {
      port: 39731,
      secret,
      authSource: 'environment',
      lessSafeSecretFlag: false,
      timeoutMs: 90_000,
    },
    runDir: '/tmp/geckolib-live-smoke-run',
    adapterPid: 123,
    health: { result: { plugin_connected: true, secret } },
    pluginStatus: { result: { capabilities: ['geckolib_model'] } },
    commands: [{ command: 'capture_geckolib_animation_frame', ok: true, result: { width: 512 } }],
    frames: [
      {
        index: 0,
        file: '/tmp/frame-0.png',
        bytes: 68,
        sha256: 'a'.repeat(64),
        metadata: { animation: 'animation.smoke.pose_check', time: 0, width: 512, height: 512 },
      },
    ],
    sanityChecks: [{ name: 'captured-frame-hashes-distinct', ok: true }],
    knownSecrets: [secret],
  });
  const serialized = JSON.stringify(report);

  assert.equal(report.human_review_required, true);
  assert.equal(report.review_status, 'pending_human_review');
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('data:image/png'), false);
  assert.equal(report.config.auth.source, 'environment');
  assert.equal(report.config.cli_auth_override_used, false);
});

test('generateReviewChecklist includes required human visual review items', () => {
  const checklist = generateReviewChecklist({ reportFile: 'smoke-report.json', frameFiles: ['frame-0.png', 'frame-1.png'] });

  assert.match(checklist, /visibly different GeckoLib poses/);
  assert.match(checklist, /no playback started/);
  assert.match(checklist, /sound, particle, or timeline effects/);
  assert.match(checklist, /Blockbench remains usable/);
  assert.match(checklist, /Close or discard the unsaved smoke project tab/);
});

test('failure classification gives actionable precondition remediation without process killing', () => {
  const portConflict = classifySetupIssue({ code: 'E_PORT_IN_USE', message: 'busy' }, 40123);
  assert.equal(portConflict.category, 'port_conflict');
  assert.match(portConflict.remediation.join('\n'), /Do not kill unknown processes/);
  assert.match(portConflict.remediation.join('\n'), /same port/);

  const disconnected = classifyToolFailure('health', { code: 'E_PLUGIN_NOT_CONNECTED' });
  assert.equal(disconnected.category, 'plugin_disconnected');
  assert.match(disconnected.remediation.join('\n'), /reinstall or reload/);
  assert.match(disconnected.remediation.join('\n'), /stale protocol/);

  const geckolib = classifyToolFailure('create_geckolib_project', { code: 'E_PLUGIN_DEPENDENCY_MISSING' });
  assert.equal(geckolib.category, 'geckolib_unavailable');
});
