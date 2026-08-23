// Handler-path file-safety tests: the REAL file-command handlers registered by
// registerModelCommands, driven through the real dispatcher (bridge → session),
// with a scoped-FS implementation backed by a temp directory. Proves the
// handlers invoke the shared containment/symlink/overwrite/preflight rules
// before any I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import WsClient from 'ws';

import { WsBridge } from '../src/adapter/ws-bridge.js';
import { PluginSession, type WebSocketLike } from '../src/plugin/session.js';
import { ScopeManager, type ScopedFsLike } from '../src/plugin/scope-manager.js';
import { registerModelCommands } from '../src/plugin/commands/model-commands.js';
import { registerScopeCommands } from '../src/plugin/commands/scope-commands.js';
import { normalizePath } from '../src/shared/scope.js';

const SECRET = 'file-cmd-secret-77';
let nextPort = 40600;

/** Simulates Blockbench's scoped FS passthrough (the containment rules under
 * test live in the shared scope logic, not in this adapter). */
const nodeFsAdapter: ScopedFsLike = {
  readFileSync: (path, options) => nodeFs.readFileSync(path as string, options as never),
  writeFileSync: (path, content, options) => nodeFs.writeFileSync(path as string, content as never, options as never),
  existsSync: (path) => nodeFs.existsSync(path),
  mkdirSync: (path, options) => nodeFs.mkdirSync(path as string, options as never),
  readdirSync: (path, options) => nodeFs.readdirSync(path as string, options as never),
  statSync: (path) => nodeFs.statSync(path as string),
};

interface Harness {
  bridge: WsBridge;
  session: PluginSession;
  scope: ScopeManager;
  scopeDir: string;
  cleanup: () => Promise<void>;
}

async function makeHarness(options: { confirm?: boolean; previousScopeMemo?: string } = {}): Promise<Harness> {
  const port = nextPort++;
  const scopeDir = nodeFs.mkdtempSync(join(tmpdir(), 'bbmcp-files-'));

  const bridge = new WsBridge({
    port,
    secret: SECRET,
    requestTimeoutMs: 2_000,
    heartbeatIntervalMs: 200,
    heartbeatMissLimit: 3,
    handshakeTimeoutMs: 1_000,
    maxMessageBytes: 4 * 1024 * 1024,
    log: () => {},
  });
  const started = await bridge.start();
  assert.deepEqual(started, { ok: true });

  const scope = new ScopeManager({
    confirmDialog: () => Promise.resolve(options.confirm ?? true),
    acquireScopedFs: () => nodeFsAdapter,
    memo: { get: () => options.previousScopeMemo ?? null, set: () => {} },
  });

  const session = new PluginSession({
    createWebSocket: (url) => new WsClient(url) as unknown as WebSocketLike,
    url: () => `ws://127.0.0.1:${port}`,
    secret: () => SECRET,
    pluginVersion: '0.1.0',
    blockbenchVersion: () => '5.1.4',
    capabilities: () => ['java_block'],
    backoffInitialMs: 50,
    backoffMaxMs: 200,
  });
  session.registerHandler('propose_scoped_directory', (params) => {
    const { path, reason } = params as { path: string; reason?: string };
    return scope.propose(path, reason);
  });
  registerModelCommands(session, scope);
  // The shipped plugin registers this too (src/plugin/main.ts); the adapter
  // revokes any inherited scoped directory before it relays a first command.
  registerScopeCommands(session, scope);
  session.start();

  const start = Date.now();
  while (!(session.status === 'connected' && bridge.connected)) {
    if (Date.now() - start > 3_000) throw new Error('harness did not connect');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  return {
    bridge,
    session,
    scope,
    scopeDir,
    cleanup: async () => {
      session.stop();
      await bridge.stop();
      nodeFs.rmSync(scopeDir, { recursive: true, force: true });
    },
  };
}

async function confirmScope(harness: Harness): Promise<string> {
  const outcome = await harness.bridge.request('propose_scoped_directory', { path: harness.scopeDir });
  assert.equal(outcome.ok, true, `scope proposal failed: ${JSON.stringify(outcome.error)}`);
  return (outcome.result as { normalized_path: string }).normalized_path;
}

test('file commands before scope confirmation fail with E_SCOPE_NOT_CONFIRMED through the dispatcher', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);

  const read = await harness.bridge.request('read_file', { path: 'model.json' });
  assert.equal(read.ok, false);
  assert.equal(read.error?.code, 'E_SCOPE_NOT_CONFIRMED');

  const write = await harness.bridge.request('write_files', {
    files: [{ path: 'model.json', content: '{}' }],
  });
  assert.equal(write.ok, false);
  assert.equal(write.error?.code, 'E_SCOPE_NOT_CONFIRMED');
});

test('write and read round-trip inside the confirmed scope, including base64 and nested directories', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  await confirmScope(harness);

  const write = await harness.bridge.request('write_files', {
    files: [
      { path: 'models/block/stone.json', content: '{"parent":"block/cube_all"}' },
      { path: 'textures/data.bin', content: Buffer.from('binary-data').toString('base64'), encoding: 'base64' },
    ],
  });
  assert.equal(write.ok, true, JSON.stringify(write.error));
  const results = (write.result as { results: Array<{ path: string; status: string; bytes: number }> }).results;
  assert.equal(results.length, 2);
  assert.equal(results[0].status, 'created');
  assert.ok(results[0].path.endsWith('/models/block/stone.json'), 'result carries the normalized path');

  const onDisk = nodeFs.readFileSync(join(harness.scopeDir, 'models/block/stone.json'), 'utf8');
  assert.equal(onDisk, '{"parent":"block/cube_all"}');
  assert.equal(nodeFs.readFileSync(join(harness.scopeDir, 'textures/data.bin'), 'utf8'), 'binary-data');

  const read = await harness.bridge.request('read_file', { path: 'models/block/stone.json' });
  assert.equal(read.ok, true);
  const readResult = read.result as { content: string; encoding: string; bytes: number };
  assert.equal(readResult.content, '{"parent":"block/cube_all"}');

  const readB64 = await harness.bridge.request('read_file', { path: 'textures/data.bin', encoding: 'base64' });
  assert.equal(readB64.ok, true);
  assert.equal((readB64.result as { content: string }).content, Buffer.from('binary-data').toString('base64'));
});

test('an existing destination without the explicit overwrite flag is rejected with E_FILE_EXISTS and the file is untouched', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  await confirmScope(harness);
  nodeFs.writeFileSync(join(harness.scopeDir, 'existing.json'), 'original');

  const write = await harness.bridge.request('write_files', {
    files: [{ path: 'existing.json', content: 'replaced' }],
  });
  assert.equal(write.ok, false);
  assert.equal(write.error?.code, 'E_FILE_EXISTS');
  assert.equal(nodeFs.readFileSync(join(harness.scopeDir, 'existing.json'), 'utf8'), 'original');

  const flagged = await harness.bridge.request('write_files', {
    files: [{ path: 'existing.json', content: 'replaced', overwrite: true }],
  });
  assert.equal(flagged.ok, true);
  const results = (flagged.result as { results: Array<{ status: string }> }).results;
  assert.equal(results[0].status, 'overwritten');
  assert.equal(nodeFs.readFileSync(join(harness.scopeDir, 'existing.json'), 'utf8'), 'replaced');
});

test('a multi-file batch with any blocker writes nothing and reports the full blocker list', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  await confirmScope(harness);
  nodeFs.writeFileSync(join(harness.scopeDir, 'conflict.json'), 'original');

  const write = await harness.bridge.request('write_files', {
    files: [
      { path: 'fresh.json', content: '{}' },
      { path: 'conflict.json', content: 'x' },
      { path: '../escape.json', content: 'x' },
    ],
  });
  assert.equal(write.ok, false);
  assert.equal(write.error?.code, 'E_PREFLIGHT_FAILED');
  const blockers = (write.error?.details as { blockers: Array<{ code: string }> }).blockers;
  assert.deepEqual(
    blockers.map((b) => b.code).sort(),
    ['E_FILE_EXISTS', 'E_PATH_OUTSIDE_SCOPE'],
  );
  assert.equal(nodeFs.existsSync(join(harness.scopeDir, 'fresh.json')), false, 'no file may be written on preflight failure');
});

test('escape attempts through the dispatcher are rejected with E_PATH_OUTSIDE_SCOPE', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  await confirmScope(harness);

  const read = await harness.bridge.request('read_file', { path: '../../etc/passwd' });
  assert.equal(read.ok, false);
  assert.equal(read.error?.code, 'E_PATH_OUTSIDE_SCOPE');

  const absolute = await harness.bridge.request('read_file', { path: '/etc/passwd' });
  assert.equal(absolute.ok, false);
  assert.equal(absolute.error?.code, 'E_PATH_OUTSIDE_SCOPE');
});

test('a symlinked component inside the scope is rejected before any write', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  await confirmScope(harness);

  const outside = nodeFs.mkdtempSync(join(tmpdir(), 'bbmcp-outside-'));
  t.after(() => nodeFs.rmSync(outside, { recursive: true, force: true }));
  nodeFs.symlinkSync(outside, join(harness.scopeDir, 'link'));

  const write = await harness.bridge.request('write_files', {
    files: [{ path: 'link/escaped.json', content: '{}' }],
  });
  assert.equal(write.ok, false);
  assert.equal(write.error?.code, 'E_PATH_OUTSIDE_SCOPE');
  assert.equal(nodeFs.existsSync(join(outside, 'escaped.json')), false);
});

test('revoking the scope mid-session flips file commands to E_SCOPE_REVOKED', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  await confirmScope(harness);
  harness.scope.revoke();

  const read = await harness.bridge.request('read_file', { path: 'anything.json' });
  assert.equal(read.ok, false);
  assert.equal(read.error?.code, 'E_SCOPE_REVOKED');
});

test('read_file reports E_NOT_FOUND for missing files and E_INVALID_PARAMS beyond max_bytes', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  await confirmScope(harness);

  const missing = await harness.bridge.request('read_file', { path: 'nope.json' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error?.code, 'E_NOT_FOUND');

  nodeFs.writeFileSync(join(harness.scopeDir, 'big.bin'), Buffer.alloc(2_048));
  const tooBig = await harness.bridge.request('read_file', { path: 'big.bin', max_bytes: 1_024 });
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.error?.code, 'E_INVALID_PARAMS');
});

test('a rejected scope proposal reports user rejection through the dispatcher', async (t) => {
  const harness = await makeHarness({ confirm: false });
  t.after(harness.cleanup);

  const outcome = await harness.bridge.request('propose_scoped_directory', { path: harness.scopeDir });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_SCOPE_NOT_CONFIRMED');
  assert.deepEqual(
    (outcome.error?.details as { reason: string }).reason,
    'user_rejected',
  );
});

test('a previous-session grant reports E_SCOPE_EXPIRED through the dispatcher until reconfirmed', async (t) => {
  const harness = await makeHarness({ previousScopeMemo: '/home/user/previous-scope' });
  t.after(harness.cleanup);

  const read = await harness.bridge.request('read_file', { path: 'model.json' });
  assert.equal(read.ok, false);
  assert.equal(read.error?.code, 'E_SCOPE_EXPIRED');

  await confirmScope(harness);
  nodeFs.writeFileSync(join(harness.scopeDir, 'model.json'), '{}');
  const afterConfirm = await harness.bridge.request('read_file', { path: 'model.json' });
  assert.equal(afterConfirm.ok, true);
});

test('the plugin re-validates parameters itself even when the adapter is bypassed', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  await confirmScope(harness);

  // bridge.request skips adapter-side zod validation, so this exercises the
  // plugin-side trust boundary directly.
  const emptyBatch = await harness.bridge.request('write_files', { files: [] });
  assert.equal(emptyBatch.ok, false);
  assert.equal(emptyBatch.error?.code, 'E_INVALID_PARAMS');

  const badLimit = await harness.bridge.request('read_file', { path: 'x.json', max_bytes: -1 });
  assert.equal(badLimit.ok, false);
  assert.equal(badLimit.error?.code, 'E_INVALID_PARAMS');
});

test('Blockbench-dependent commands degrade to structured errors when no Blockbench runtime exists', async (t) => {
  // In this Node harness the Blockbench globals are absent; the dispatcher
  // must convert the resulting exception into E_BLOCKBENCH_ERROR instead of
  // crashing the session.
  const harness = await makeHarness();
  t.after(harness.cleanup);

  const outcome = await harness.bridge.request('get_project_state', {});
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_BLOCKBENCH_ERROR');
  assert.equal(harness.session.status, 'connected');
});

test('normalized scope paths flow through results (separator policy)', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  await confirmScope(harness);

  const expectedRoot = normalizePath(harness.scopeDir)!;
  const write = await harness.bridge.request('write_files', {
    files: [{ path: 'sub\\dir\\win-style.json', content: '{}' }],
  });
  assert.equal(write.ok, true, JSON.stringify(write.error));
  const results = (write.result as { results: Array<{ path: string }> }).results;
  assert.equal(results[0].path, `${expectedRoot}/sub/dir/win-style.json`);
});
