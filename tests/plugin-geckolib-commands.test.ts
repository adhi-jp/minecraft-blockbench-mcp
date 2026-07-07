// GeckoLib handler tests through the real dispatcher (bridge → session), with
// Blockbench globals injected on globalThis. node --test runs each file in its
// own process, so the global assignments stay file-local. Handlers that need
// the full Blockbench runtime (newProject, codecs) are covered by manual smoke
// testing against a live Blockbench; these tests prove the dependency/format
// guards, the .bbmodel format precheck, and the scoped file-validation path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import WsClient from 'ws';

import { WsBridge } from '../src/adapter/ws-bridge.js';
import { PluginSession, type WebSocketLike } from '../src/plugin/session.js';
import { ScopeManager, type ScopedFsLike } from '../src/plugin/scope-manager.js';
import { registerGeckolibCommands } from '../src/plugin/commands/geckolib-commands.js';
import { registerModelCommands } from '../src/plugin/commands/model-commands.js';
import { PROTOCOL_VERSION } from '../src/shared/protocol.js';

const SECRET = 'geckolib-cmd-secret-42';
let nextPort = 40700;

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'geckolib');

const nodeFsAdapter: ScopedFsLike = {
  readFileSync: (path, options) => nodeFs.readFileSync(path as string, options as never),
  writeFileSync: (path, content, options) => nodeFs.writeFileSync(path as string, content as never, options as never),
  existsSync: (path) => nodeFs.existsSync(path),
  mkdirSync: (path, options) => nodeFs.mkdirSync(path as string, options as never),
  readdirSync: (path, options) => nodeFs.readdirSync(path as string, options as never),
  statSync: (path) => nodeFs.statSync(path as string),
};

const GECKOLIB_COMMANDS = [
  'create_geckolib_project',
  'open_geckolib_model',
  'export_geckolib_model',
  'export_geckolib_animations',
  'validate_geckolib_file',
] as const;

const MINIMAL_GECKOLIB_ARGS: Record<(typeof GECKOLIB_COMMANDS)[number], Record<string, unknown>> = {
  create_geckolib_project: { modid: 'examplemod', model_type: 'Entity', identifier: 'ghost' },
  open_geckolib_model: { path: 'ghost.bbmodel' },
  export_geckolib_model: { path: 'ghost.geo.json' },
  export_geckolib_animations: { path: 'ghost.animation.json' },
  validate_geckolib_file: { geo_path: 'ghost.geo.json' },
};

const injectedGlobals = globalThis as Record<string, unknown>;

function clearBlockbenchGlobals(): void {
  delete injectedGlobals.Formats;
  delete injectedGlobals.Format;
  delete injectedGlobals.Project;
  delete injectedGlobals.Plugins;
}

interface Harness {
  bridge: WsBridge;
  session: PluginSession;
  scopeDir: string;
  cleanup: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const port = nextPort++;
  const scopeDir = nodeFs.mkdtempSync(join(tmpdir(), 'bbmcp-geckolib-'));

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
    confirmDialog: () => Promise.resolve(true),
    acquireScopedFs: () => nodeFsAdapter,
    memo: { get: () => null, set: () => {} },
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
  registerGeckolibCommands(session, scope);
  session.start();

  const start = Date.now();
  while (!(session.status === 'connected' && bridge.connected)) {
    if (Date.now() - start > 3_000) throw new Error('harness did not connect');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const confirmed = await bridge.request('propose_scoped_directory', { path: scopeDir });
  assert.equal(confirmed.ok, true, `scope proposal failed: ${JSON.stringify(confirmed.error)}`);

  return {
    bridge,
    session,
    scopeDir,
    cleanup: async () => {
      session.stop();
      await bridge.stop();
      nodeFs.rmSync(scopeDir, { recursive: true, force: true });
      clearBlockbenchGlobals();
    },
  };
}

test('every geckolib command fails with E_PLUGIN_DEPENDENCY_MISSING while the GeckoLib format is absent', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  clearBlockbenchGlobals();

  for (const command of GECKOLIB_COMMANDS) {
    const outcome = await harness.bridge.request(command, MINIMAL_GECKOLIB_ARGS[command]);
    assert.equal(outcome.ok, false, `${command} must fail without the GeckoLib plugin`);
    assert.equal(outcome.error?.code, 'E_PLUGIN_DEPENDENCY_MISSING', `${command} must report the missing dependency`);
    const details = outcome.error?.details as { plugin_id: string; remediation: string };
    assert.equal(details.plugin_id, 'geckolib');
    assert.match(details.remediation, /Plugins/, 'the error names the install remediation');
  }
  assert.equal(harness.session.status, 'connected', 'the session must survive every guarded failure');
});

test('the GeckoLib format is detected per call, not cached from the handshake', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);

  injectedGlobals.Formats = { geckolib_model: {} };
  injectedGlobals.Format = { id: 'java_block' };
  injectedGlobals.Project = null;

  // Present on the first call: the dependency guard passes and the command
  // proceeds to the project guard, which reports E_NOT_FOUND for Project null.
  const first = await harness.bridge.request('export_geckolib_model', { path: 'ghost.geo.json' });
  assert.equal(first.ok, false);
  assert.equal(first.error?.code, 'E_NOT_FOUND', 'with no open project the project guard reports E_NOT_FOUND');

  // Removed between two calls on the same connected session: the same command
  // must now fail at the dependency guard.
  delete injectedGlobals.Formats;
  const second = await harness.bridge.request('export_geckolib_model', { path: 'ghost.geo.json' });
  assert.equal(second.ok, false);
  assert.equal(second.error?.code, 'E_PLUGIN_DEPENDENCY_MISSING');
});

test('geckolib commands on a non-geckolib project fail with E_FORMAT_UNSUPPORTED naming the actual format', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);

  injectedGlobals.Formats = { geckolib_model: {} };
  injectedGlobals.Format = { id: 'java_block' };
  injectedGlobals.Project = { saved: true, name: 'block' };

  for (const command of ['export_geckolib_model', 'export_geckolib_animations'] as const) {
    const outcome = await harness.bridge.request(command, { path: 'out.json' });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error?.code, 'E_FORMAT_UNSUPPORTED', `${command} must reject the wrong format`);
    assert.match(outcome.error?.message ?? '', /java_block/, 'the error names the actual project format');
  }
});

test('open_geckolib_model rejects .bbmodel files whose meta.model_format is not geckolib_model', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);

  injectedGlobals.Formats = { geckolib_model: {} };
  injectedGlobals.Project = null;

  nodeFs.writeFileSync(
    join(harness.scopeDir, 'java.bbmodel'),
    JSON.stringify({ meta: { format_version: '5.0', model_format: 'java_block' }, name: 'block' }),
  );
  const outcome = await harness.bridge.request('open_geckolib_model', { path: 'java.bbmodel' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_FORMAT_UNSUPPORTED');
  const details = outcome.error?.details as { model_format?: string };
  assert.equal(details.model_format, 'java_block');

  nodeFs.writeFileSync(join(harness.scopeDir, 'not-json.bbmodel'), 'not json at all');
  const notJson = await harness.bridge.request('open_geckolib_model', { path: 'not-json.bbmodel' });
  assert.equal(notJson.ok, false);
  assert.equal(notJson.error?.code, 'E_INVALID_PARAMS');
});

test('validate_geckolib_file validates scoped files end-to-end and reuses scope errors', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);

  injectedGlobals.Formats = { geckolib_model: {} };

  nodeFs.copyFileSync(join(fixturesDir, 'valid.geo.json'), join(harness.scopeDir, 'ghost.geo.json'));
  nodeFs.copyFileSync(join(fixturesDir, 'valid.animation.json'), join(harness.scopeDir, 'ghost.animation.json'));

  const clean = await harness.bridge.request('validate_geckolib_file', {
    geo_path: 'ghost.geo.json',
    animation_path: 'ghost.animation.json',
  });
  assert.equal(clean.ok, true, JSON.stringify(clean.error));
  assert.deepEqual(clean.result, { diagnostics: [], profile: 'gl4' });

  const corrupted = JSON.parse(nodeFs.readFileSync(join(fixturesDir, 'valid.geo.json'), 'utf8'));
  corrupted.format_version = '1.21.0';
  corrupted['minecraft:geometry'][0].bones.push({ name: 'Body' });
  nodeFs.writeFileSync(join(harness.scopeDir, 'broken.geo.json'), JSON.stringify(corrupted));
  const flagged = await harness.bridge.request('validate_geckolib_file', { geo_path: 'broken.geo.json' });
  assert.equal(flagged.ok, true);
  const result = flagged.result as { diagnostics: Array<{ check_id: string; severity: string }>; profile: string };
  assert.equal(result.profile, 'gl4');
  assert.deepEqual(
    result.diagnostics.map((d) => d.check_id).sort(),
    ['geckolib_duplicate_bone_names', 'geckolib_format_version'],
  );

  const escape = await harness.bridge.request('validate_geckolib_file', { geo_path: '../outside.geo.json' });
  assert.equal(escape.ok, false);
  assert.equal(escape.error?.code, 'E_PATH_OUTSIDE_SCOPE');

  const missing = await harness.bridge.request('validate_geckolib_file', { geo_path: 'nope.geo.json' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error?.code, 'E_NOT_FOUND');
});

test('validate_geckolib_file validates an animation file alone and dedupes envelope errors with geometry', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);

  injectedGlobals.Formats = { geckolib_model: {} };

  nodeFs.copyFileSync(join(fixturesDir, 'valid.geo.json'), join(harness.scopeDir, 'ghost.geo.json'));
  nodeFs.copyFileSync(join(fixturesDir, 'valid.animation.json'), join(harness.scopeDir, 'ghost.animation.json'));

  // Animation-only: content checks run with no geometry.
  const clean = await harness.bridge.request('validate_geckolib_file', { animation_path: 'ghost.animation.json' });
  assert.equal(clean.ok, true, JSON.stringify(clean.error));
  assert.deepEqual(clean.result, { diagnostics: [], profile: 'gl4' });

  const broken = JSON.parse(nodeFs.readFileSync(join(fixturesDir, 'valid.animation.json'), 'utf8'));
  broken.animations['animation.ghost.idle'].loop = 'forever';
  broken.animations['animation.ghost.idle'].bones.tail = { rotation: { '0.0': [0, 0, 0] } };
  nodeFs.writeFileSync(join(harness.scopeDir, 'broken.animation.json'), JSON.stringify(broken));

  const animationOnly = await harness.bridge.request('validate_geckolib_file', {
    animation_path: 'broken.animation.json',
  });
  assert.equal(animationOnly.ok, true);
  const animationOnlyResult = animationOnly.result as { diagnostics: Array<{ check_id: string }> };
  assert.deepEqual(
    animationOnlyResult.diagnostics.map((d) => d.check_id),
    ['geckolib_animation_loop_value'],
    'content checks run without geometry; bone cross-checks need geo_path',
  );

  const both = await harness.bridge.request('validate_geckolib_file', {
    geo_path: 'ghost.geo.json',
    animation_path: 'broken.animation.json',
  });
  assert.equal(both.ok, true);
  const bothResult = both.result as { diagnostics: Array<{ check_id: string }> };
  assert.deepEqual(
    bothResult.diagnostics.map((d) => d.check_id).sort(),
    ['geckolib_animation_loop_value', 'geckolib_animation_missing_bone'],
    'geometry adds the bone cross-check without duplicating content diagnostics',
  );

  // A file whose envelope both passes report identically must yield one copy.
  nodeFs.writeFileSync(join(harness.scopeDir, 'no-envelope.animation.json'), JSON.stringify({ nope: true }));
  const envelope = await harness.bridge.request('validate_geckolib_file', {
    geo_path: 'ghost.geo.json',
    animation_path: 'no-envelope.animation.json',
  });
  assert.equal(envelope.ok, true);
  const envelopeResult = envelope.result as { diagnostics: Array<{ check_id: string }> };
  assert.deepEqual(
    envelopeResult.diagnostics.map((d) => d.check_id),
    ['geckolib_animation_envelope'],
    'identical envelope errors from both passes are deduplicated',
  );

  // Distinct problems with identical wording inside one pass must survive:
  // two unnamed bones are two diagnostics, not one.
  const unnamedBones = JSON.parse(nodeFs.readFileSync(join(fixturesDir, 'valid.geo.json'), 'utf8'));
  unnamedBones['minecraft:geometry'][0].bones.push({ pivot: [0, 0, 0] }, { pivot: [1, 1, 1] });
  nodeFs.writeFileSync(join(harness.scopeDir, 'unnamed.geo.json'), JSON.stringify(unnamedBones));
  const unnamed = await harness.bridge.request('validate_geckolib_file', { geo_path: 'unnamed.geo.json' });
  assert.equal(unnamed.ok, true);
  const unnamedResult = unnamed.result as { diagnostics: Array<{ message: string }> };
  assert.equal(
    unnamedResult.diagnostics.filter((d) => d.message === 'A bone has no string name.').length,
    2,
    'within-pass identical diagnostics are preserved',
  );

  // Neither path: the plugin-side re-validation maps the schema refinement
  // to the structured parameter error.
  const neither = await harness.bridge.request('validate_geckolib_file', {});
  assert.equal(neither.ok, false);
  assert.equal(neither.error?.code, 'E_INVALID_PARAMS');
});

test('export_geckolib_animations reports E_NOT_FOUND when the project has no animations', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);

  injectedGlobals.Formats = { geckolib_model: {} };
  injectedGlobals.Format = { id: 'geckolib_model' };
  injectedGlobals.Project = { saved: false, name: 'ghost' };
  (globalThis as Record<string, unknown>).Blockbench = { Animation: { all: [] } };
  t.after(() => {
    delete (globalThis as Record<string, unknown>).Blockbench;
  });

  const outcome = await harness.bridge.request('export_geckolib_animations', { path: 'ghost.animation.json' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_NOT_FOUND');
  assert.equal(nodeFs.existsSync(join(harness.scopeDir, 'ghost.animation.json')), false, 'nothing may be written');
});

test('an unsaved open project blocks create/open without force:true, matching the java_block guard', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);

  injectedGlobals.Formats = { geckolib_model: {} };
  injectedGlobals.Project = { saved: false, name: 'unsaved' };

  const create = await harness.bridge.request('create_geckolib_project', {
    modid: 'examplemod',
    model_type: 'Entity',
    identifier: 'ghost',
  });
  assert.equal(create.ok, false);
  assert.equal(create.error?.code, 'E_INVALID_PARAMS');
  assert.match(create.error?.message ?? '', /force:true/);

  nodeFs.copyFileSync(join(fixturesDir, 'valid.geo.json'), join(harness.scopeDir, 'any.bbmodel'));
  const open = await harness.bridge.request('open_geckolib_model', { path: 'any.bbmodel' });
  assert.equal(open.ok, false);
  assert.equal(open.error?.code, 'E_INVALID_PARAMS');
  assert.match(open.error?.message ?? '', /force:true/);
});

test('the plugin re-validates geckolib parameters itself even when the adapter is bypassed', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);

  injectedGlobals.Formats = { geckolib_model: {} };
  injectedGlobals.Project = null;

  const badModid = await harness.bridge.request('create_geckolib_project', {
    modid: 'My/Mod',
    model_type: 'Entity',
    identifier: 'ghost',
  });
  assert.equal(badModid.ok, false);
  assert.equal(badModid.error?.code, 'E_INVALID_PARAMS');

  const badType = await harness.bridge.request('create_geckolib_project', {
    modid: 'examplemod',
    model_type: 'entity',
    identifier: 'ghost',
  });
  assert.equal(badType.ok, false);
  assert.equal(badType.error?.code, 'E_INVALID_PARAMS');
});

test('get_plugin_status reports the shared protocol constant, geckolib capability, and detected plugin version', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);

  // Mirror the real main.ts wiring shape for the status handler using the
  // injected globals (main.ts itself needs the Blockbench runtime to load).
  injectedGlobals.Formats = { geckolib_model: {} };
  injectedGlobals.Plugins = { all: [{ id: 'geckolib', version: '4.2.5', installed: true }] };
  const { geckolibFormatRegistered, detectGeckolibPluginVersion } = await import(
    '../src/plugin/commands/helpers.js'
  );
  harness.session.registerHandler('get_plugin_status', () => ({
    plugin_version: '0.1.0',
    blockbench_version: '5.1.4',
    protocol_version: PROTOCOL_VERSION,
    capabilities: geckolibFormatRegistered() ? ['java_block', 'geckolib_model'] : ['java_block'],
    scope: { state: 'unconfirmed' },
    ...(detectGeckolibPluginVersion() !== undefined
      ? { geckolib_plugin_version: detectGeckolibPluginVersion() }
      : {}),
  }));

  const status = await harness.bridge.request('get_plugin_status', {});
  assert.equal(status.ok, true);
  const result = status.result as {
    protocol_version: number;
    capabilities: string[];
    geckolib_plugin_version?: string;
  };
  assert.equal(result.protocol_version, PROTOCOL_VERSION, 'the status must report the shared constant');
  assert.deepEqual(result.capabilities, ['java_block', 'geckolib_model']);
  assert.equal(result.geckolib_plugin_version, '4.2.5');
});
