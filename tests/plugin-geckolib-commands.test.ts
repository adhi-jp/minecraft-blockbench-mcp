// GeckoLib handler tests through the real dispatcher (bridge → session), with
// Blockbench globals injected on globalThis. node --test runs each file in its
// own process, so the global assignments stay file-local. Opening runs against
// fakes of newProject, the project codec, and texture image events; rendering
// itself is covered by manual smoke testing against a live Blockbench. The
// other tests prove the dependency/format guards, the .bbmodel format
// precheck, and the scoped file-validation path.
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
import { registerScopeCommands } from '../src/plugin/commands/scope-commands.js';
import { COMMAND_SPECS, PROTOCOL_VERSION } from '../src/shared/protocol.js';

const SECRET = 'geckolib-cmd-secret-42';
// Reserved band: 42800-42899. This file used to start at 47000, which put its
// second harness on 47001 — the port the WinRM HTTP compatibility listener
// already holds on Windows, so binding it failed with EACCES on both Windows
// legs. 42800-42899 is the free slot inside the 40100-42799 range the rest of
// the suite reserves, and CI keeps the ephemeral range above it on every
// platform, so nothing else can be sitting there.
let nextPort = 42_800;

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
  'upsert_geckolib_animation',
  'delete_geckolib_animation',
  'get_geckolib_animation',
  'capture_geckolib_animation_frame',
] as const;

const MINIMAL_GECKOLIB_ARGS: Record<(typeof GECKOLIB_COMMANDS)[number], Record<string, unknown>> = {
  create_geckolib_project: { modid: 'examplemod', model_type: 'Entity', identifier: 'ghost' },
  open_geckolib_model: { path: 'ghost.bbmodel' },
  export_geckolib_model: { path: 'ghost.geo.json' },
  export_geckolib_animations: { path: 'ghost.animation.json' },
  validate_geckolib_file: { geo_path: 'ghost.geo.json' },
  upsert_geckolib_animation: { name: 'animation.ghost.idle', length: 1, bones: {} },
  delete_geckolib_animation: { name: 'animation.ghost.idle' },
  get_geckolib_animation: { name: 'animation.ghost.idle' },
  capture_geckolib_animation_frame: { animation: 'animation.ghost.idle', time: 0 },
};

const injectedGlobals = globalThis as Record<string, unknown>;

function clearBlockbenchGlobals(): void {
  delete injectedGlobals.Formats;
  delete injectedGlobals.Format;
  delete injectedGlobals.Project;
  delete injectedGlobals.Plugins;
  delete injectedGlobals.Group;
  delete injectedGlobals.Undo;
  delete injectedGlobals.Blockbench;
  delete injectedGlobals.Animator;
  delete injectedGlobals.Validator;
  delete injectedGlobals.Cube;
  delete injectedGlobals.Texture;
  delete injectedGlobals.invertMolang;
  delete injectedGlobals.Timeline;
  delete injectedGlobals.Preview;
  delete injectedGlobals.Screencam;
  delete injectedGlobals.DefaultCameraPresets;
  delete injectedGlobals.document;
  delete injectedGlobals.Codecs;
  delete injectedGlobals.Canvas;
  delete injectedGlobals.newProject;
}

// ---------------------------------------------------------------------------
// Fake Blockbench animation runtime for the animation command dispatch tests,
// mirroring the Blockbench 5.1.4 behavior the handlers rely on: add() always
// runs unique-name suffixing, remove() drops the clip from the list, and the
// undo system restores captured animations on cancelEdit(true).
// ---------------------------------------------------------------------------

let nextGroupId = 1;

class FakeGroup {
  static all: FakeGroup[] = [];
  name: string;
  uuid: string;
  constructor(name: string) {
    this.name = name;
    this.uuid = `group-${nextGroupId++}`;
  }
}

interface FakeKeyframe {
  channel: string;
  time: number;
  interpolation: string;
  easing?: string;
  easingArgs?: number[];
  data_points: Array<{ x: unknown; y: unknown; z: unknown }>;
}

class FakeBoneAnimator {
  uuid: string;
  animation: FakeAnimation;
  group: FakeGroup;
  rotation: FakeKeyframe[] = [];
  position: FakeKeyframe[] = [];
  scale: FakeKeyframe[] = [];
  constructor(uuid: string, animation: FakeAnimation, group: FakeGroup) {
    this.uuid = uuid;
    this.animation = animation;
    this.group = group;
  }
  get name(): string {
    return this.group.name;
  }
  get keyframes(): FakeKeyframe[] {
    return [...this.rotation, ...this.position, ...this.scale];
  }
  addKeyframe(data: {
    channel: 'rotation' | 'position' | 'scale';
    time: number;
    interpolation?: string;
    easing?: string;
    easingArgs?: number[];
    data_points: Array<{ x: unknown; y: unknown; z: unknown }>;
  }): FakeKeyframe | undefined {
    const channel = this[data.channel];
    if (!Array.isArray(channel)) return undefined;
    const keyframe: FakeKeyframe = {
      channel: data.channel,
      time: data.time,
      interpolation: data.interpolation ?? 'linear',
      ...(data.easing !== undefined ? { easing: data.easing } : {}),
      ...(data.easingArgs !== undefined ? { easingArgs: data.easingArgs } : {}),
      data_points: data.data_points,
    };
    channel.push(keyframe);
    return keyframe;
  }
}

class FakeAnimation {
  static all: FakeAnimation[] = [];
  static selected: FakeAnimation | null = null;
  name = '';
  loop = 'once';
  length = 0;
  override = false;
  anim_time_update = '';
  selected = false;
  playing = false;
  animators: Record<string, unknown> = {};
  constructor(data?: Record<string, unknown>) {
    Object.assign(this, data);
    if (!['once', 'loop', 'hold'].includes(this.loop)) this.loop = 'once';
  }
  add(_undo: boolean): FakeAnimation {
    if (!FakeAnimation.all.includes(this)) FakeAnimation.all.push(this);
    let name = this.name;
    let suffix = 2;
    while (FakeAnimation.all.some((other) => other !== this && other.name === name)) {
      name = `${this.name}${suffix}`;
      suffix += 1;
    }
    this.name = name;
    return this;
  }
  remove(_undo: boolean): FakeAnimation {
    const index = FakeAnimation.all.indexOf(this);
    if (index >= 0) FakeAnimation.all.splice(index, 1);
    if (FakeAnimation.selected === this) FakeAnimation.selected = null;
    this.selected = false;
    return this;
  }
  getBoneAnimator(group: FakeGroup): FakeBoneAnimator {
    if (!this.animators[group.uuid]) {
      this.animators[group.uuid] = new FakeBoneAnimator(group.uuid, this, group);
    }
    return this.animators[group.uuid];
  }
  select(): FakeAnimation {
    for (const animation of FakeAnimation.all) animation.selected = false;
    this.selected = true;
    FakeAnimation.selected = this;
    return this;
  }
}

interface FakeUndo {
  initCalls: unknown[];
  finishCalls: Array<{ action: string; aspects: unknown }>;
  cancelCalls: boolean[];
  captured: FakeAnimation[];
  initEdit(aspects: { animations?: FakeAnimation[] }): void;
  finishEdit(action: string, aspects?: unknown): void;
  cancelEdit(revertChanges: boolean): void;
}

function makeFakeUndo(): FakeUndo {
  return {
    initCalls: [],
    finishCalls: [],
    cancelCalls: [],
    captured: [],
    initEdit(aspects) {
      this.initCalls.push(aspects);
      this.captured = [...(aspects.animations ?? [])];
    },
    finishEdit(action, aspects) {
      this.finishCalls.push({ action, aspects });
    },
    cancelEdit(revertChanges) {
      this.cancelCalls.push(revertChanges);
      if (revertChanges) {
        for (const animation of this.captured) {
          if (!FakeAnimation.all.includes(animation)) FakeAnimation.all.push(animation);
        }
      }
    },
  };
}

/** Reversible stand-in for Blockbench's window-global invertMolang. */
function fakeInvertMolang(value: number | string): number | string {
  if (typeof value === 'number') return -value;
  const wrapped = /^-\((.*)\)$/.exec(value);
  return wrapped !== null ? wrapped[1] : `-(${value})`;
}

/** Inject a fake animated geckolib_model project (bones body/head). */
function injectAnimationGlobals(): FakeUndo {
  FakeAnimation.all = [];
  FakeAnimation.selected = null;
  FakeGroup.all = [new FakeGroup('body'), new FakeGroup('head')];
  const undo = makeFakeUndo();
  injectedGlobals.Formats = { geckolib_model: {} };
  injectedGlobals.Format = { id: 'geckolib_model' };
  injectedGlobals.Project = { saved: true, name: 'ghost' };
  injectedGlobals.Group = FakeGroup;
  injectedGlobals.Undo = undo;
  injectedGlobals.Blockbench = { Animation: FakeAnimation };
  injectedGlobals.invertMolang = fakeInvertMolang;
  return undo;
}

interface Harness {
  bridge: WsBridge;
  session: PluginSession;
  scopeDir: string;
  cleanup: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const port = nextPort++;
  assert.ok(port <= 42_899, 'the GeckoLib command tests must stay inside the reserved 42800-42899 port range');
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
  registerGeckolibCommands(session, scope, { textureSettleTimeoutMs: 150 });
  // The shipped plugin registers this too (src/plugin/main.ts); the adapter
  // revokes any inherited scoped directory before it relays a first command.
  registerScopeCommands(session, scope);
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

  const wrongFormatCalls: Array<[string, Record<string, unknown>]> = [
    ['export_geckolib_model', { path: 'out.json' }],
    ['export_geckolib_animations', { path: 'out.json' }],
    ['upsert_geckolib_animation', { name: 'animation.ghost.idle', length: 1, bones: {} }],
    ['delete_geckolib_animation', { name: 'animation.ghost.idle' }],
    ['get_geckolib_animation', { name: 'animation.ghost.idle' }],
  ];
  for (const [command, args] of wrongFormatCalls) {
    const outcome = await harness.bridge.request(command, args);
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

test('create/open open a new tab while an unsaved user project is open, and close_project closes those tabs with force', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);

  const closeCalls = new Map<string, unknown[][]>();
  const makeProject = (name: string, saved: boolean) => {
    const calls: unknown[][] = [];
    closeCalls.set(name, calls);
    const project = {
      name,
      saved,
      close: (...args: unknown[]) => {
        calls.push(args);
        if (injectedGlobals.Project === project) injectedGlobals.Project = null;
        return Promise.resolve(true);
      },
    };
    return project;
  };
  const user = makeProject('user draft', false);
  const tabs: Array<ReturnType<typeof makeProject>> = [];
  let newProjects = 0;
  injectedGlobals.Formats = { geckolib_model: {} };
  injectedGlobals.Project = user;
  injectedGlobals.Cube = { all: [] };
  injectedGlobals.Group = { all: [] };
  injectedGlobals.Texture = { all: [] };
  injectedGlobals.Canvas = { updateAll: () => {} };
  injectedGlobals.newProject = () => {
    newProjects += 1;
    const tab = makeProject(`tab-${newProjects}`, true);
    tabs.push(tab);
    injectedGlobals.Project = tab;
    return true;
  };
  injectedGlobals.Codecs = { project: { parse: () => {} } };

  const create = await harness.bridge.request('create_geckolib_project', {
    modid: 'examplemod',
    model_type: 'Entity',
    identifier: 'ghost',
    name: 'ghost',
  });
  assert.equal(create.ok, true, JSON.stringify(create.error));
  assert.equal(newProjects, 1);

  const createForced = await harness.bridge.request('create_geckolib_project', {
    modid: 'examplemod',
    model_type: 'Entity',
    identifier: 'ghost',
    force: true,
  });
  assert.equal(createForced.ok, true, JSON.stringify(createForced.error));
  assert.equal(newProjects, 2, 'force is accepted and still opens a new tab');

  nodeFs.writeFileSync(
    join(harness.scopeDir, 'ghost.bbmodel'),
    JSON.stringify({ meta: { format_version: '5.0', model_format: 'geckolib_model' }, name: 'ghost' }),
  );
  // The unsaved user project is active again for the open without force.
  injectedGlobals.Project = user;
  const open = await harness.bridge.request('open_geckolib_model', { path: 'ghost.bbmodel' });
  assert.equal(open.ok, true, JSON.stringify(open.error));
  assert.equal(newProjects, 3, 'the open without force still opens a new tab');
  const openForced = await harness.bridge.request('open_geckolib_model', { path: 'ghost.bbmodel', force: true });
  assert.equal(openForced.ok, true, JSON.stringify(openForced.error));
  assert.equal(newProjects, 4);
  assert.deepEqual(closeCalls.get('user draft'), [], 'the user project is never closed');

  // The active tab came from open_geckolib_model; unsaved edits do not stop
  // close_project, which skips the save prompt with force.
  (injectedGlobals.Project as { saved: boolean }).saved = false;
  const closed = await harness.bridge.request('close_project', {});
  assert.equal(closed.ok, true, JSON.stringify(closed.error));
  assert.deepEqual(closed.result, { closed: true, name: 'tab-4' });
  assert.deepEqual(closeCalls.get('tab-4'), [[true]]);

  // A tab create_geckolib_project made closes with force once it has edits.
  injectedGlobals.Project = tabs[0];
  tabs[0].saved = false;
  const closedCreated = await harness.bridge.request('close_project', {});
  assert.equal(closedCreated.ok, true, JSON.stringify(closedCreated.error));
  assert.deepEqual(closedCreated.result, { closed: true, name: 'ghost' });
  assert.deepEqual(closeCalls.get('tab-1'), [[true]]);

  // The user's unsaved project, active again, is refused untouched.
  injectedGlobals.Project = user;
  const refused = await harness.bridge.request('close_project', {});
  assert.equal(refused.ok, false);
  assert.equal(refused.error?.code, 'E_INVALID_PARAMS');
  assert.deepEqual(closeCalls.get('user draft'), [], 'close is never called on the unsaved user project');
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


interface FakePreview {
  id: string;
  isOrtho: boolean;
  camera: { zoom: number; projectionUpdates: number; updateProjectionMatrix(): void };
  presetsLoaded: Array<Record<string, unknown>>;
  resizes: Array<[number, number]>;
  loadAnglePreset(preset: Record<string, unknown>): void;
  resize(width: number, height: number): void;
}

function makeFakePreview(id: string): FakePreview {
  const camera = {
    zoom: 1,
    projectionUpdates: 0,
    updateProjectionMatrix() {
      this.projectionUpdates += 1;
    },
  };
  return {
    id,
    isOrtho: false,
    camera,
    presetsLoaded: [],
    resizes: [],
    loadAnglePreset(preset) {
      this.presetsLoaded.push(preset);
    },
    resize(width, height) {
      this.resizes.push([width, height]);
    },
  };
}

function injectAnimationScreenshotSurface(options: { captureDelayMs?: number; failFirstCapture?: boolean; dataUrl?: string } = {}): {
  visible: FakePreview;
  offscreen: FakePreview;
  captures: Array<{ preview: string; options: Record<string, unknown> }>;
  events: string[];
  previewStates: Array<{ time: number; playing: string[]; muted: boolean[] }>;
  defaultPoseCalls: number;
} {
  injectedGlobals.Project = { uuid: 'project-animation', saved: true, name: 'ghost' };
  injectedGlobals.Cube = { all: [{}, {}, {}] };
  injectedGlobals.Texture = { all: [{}] };
  const visible = makeFakePreview('visible');
  const offscreen = makeFakePreview('offscreen');
  const captures: Array<{ preview: string; options: Record<string, unknown> }> = [];
  const events: string[] = [];
  const previewStates: Array<{ time: number; playing: string[]; muted: boolean[] }> = [];
  let sequence = 0;
  let failNext = options.failFirstCapture === true;
  let defaultPoseCalls = 0;
  injectedGlobals.Timeline = {
    time: 0,
    playing: false,
    setTime(seconds: number) {
      this.time = Math.min(Math.max(seconds, 0), 1000);
      events.push(`time:${this.time}`);
    },
  };
  injectedGlobals.Animator = {
    preview(inLoop?: boolean) {
      events.push(`preview:${inLoop === true ? 'loop' : 'still'}:${(injectedGlobals.Timeline as { time: number }).time}`);
      previewStates.push({
        time: (injectedGlobals.Timeline as { time: number }).time,
        playing: FakeAnimation.all.filter((animation) => animation.playing).map((animation) => animation.name),
        muted: FakeAnimation.all.flatMap((animation) =>
          Object.values(animation.animators)
            .map((animator) => (animator as { muted?: { particle?: boolean; timeline?: boolean } }).muted)
            .filter((muted): muted is { particle?: boolean; timeline?: boolean } => muted !== undefined)
            .map((muted) => muted.particle === true && muted.timeline === true),
        ),
      });
    },
    showDefaultPose() {
      defaultPoseCalls += 1;
      events.push('default-pose');
    },
  };
  injectedGlobals.Preview = { selected: visible };
  injectedGlobals.DefaultCameraPresets = [
    { id: 'top', projection: 'orthographic', position: [0, 64, 0], zoom: 0.5, locked_angle: 'top' },
    { id: 'south', projection: 'orthographic', position: [0, 0, 64], zoom: 0.5, locked_angle: 'south' },
  ];
  injectedGlobals.Screencam = {
    NoAAPreview: offscreen,
    screenshotPreview: (
      preview: FakePreview,
      captureOptions: Record<string, unknown>,
      cb: (dataUrl: string) => void,
    ) => {
      if (failNext) {
        failNext = false;
        throw new Error('render exploded');
      }
      sequence += 1;
      const id = sequence;
      events.push(`start:${id}`);
      captures.push({ preview: preview.id, options: captureOptions });
      const finish = () => {
        events.push(`end:${id}`);
        cb(options.dataUrl ?? `data:image/png;base64,pose-${id}`);
      };
      if (options.captureDelayMs !== undefined) {
        setTimeout(finish, options.captureDelayMs);
      } else {
        finish();
      }
    },
  };
  return { visible, offscreen, captures, events, previewStates, get defaultPoseCalls() { return defaultPoseCalls; } };
}

function addFakeAnimation(name: string, loop: string, length: number): FakeAnimation {
  return new FakeAnimation({ name, loop, length }).add(false);
}

// ---------------------------------------------------------------------------
// Animation authoring commands against the fake animation runtime
// ---------------------------------------------------------------------------

const IDLE_CLIP_PAYLOAD = {
  name: 'animation.ghost.idle',
  loop: 'hold_on_last_frame',
  length: 2,
  bones: {
    body: {
      rotation: [
        { time: 0, value: 0 },
        { time: 0.5, value: [-10, -15, 20], easing: 'easeInOutSine' },
        { time: 1, value: ['-(math.sin(query.anim_time * 90) * 5)', 0, 0] },
      ],
      position: [{ time: 1.5, value: [-2, 1, 3] }],
      scale: [{ time: 2, value: 1, easing: 'easeInBack', easingArgs: [1.7] }],
    },
  },
};

test('upsert_geckolib_animation creates a clip in one undo step and get_geckolib_animation round-trips it', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const undo = injectAnimationGlobals();

  const upsert = await harness.bridge.request('upsert_geckolib_animation', IDLE_CLIP_PAYLOAD);
  assert.equal(upsert.ok, true, JSON.stringify(upsert.error));
  assert.deepEqual(upsert.result, { name: 'animation.ghost.idle', status: 'created' });

  assert.equal(FakeAnimation.all.length, 1);
  const clip = FakeAnimation.all[0];
  assert.equal(clip.name, 'animation.ghost.idle');
  assert.equal(clip.loop, 'hold', 'hold_on_last_frame maps to the Blockbench hold mode');
  assert.equal(clip.length, 2);
  const bodyAnimator = Object.values(clip.animators)[0];
  assert.deepEqual(
    bodyAnimator.rotation.map((kf) => kf.data_points[0]),
    [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 15, z: 20 },
      { x: 'math.sin(query.anim_time * 90) * 5', y: 0, z: 0 },
    ],
    'rotation X/Y are inverted into Blockbench space, including the molang string',
  );
  assert.deepEqual(bodyAnimator.position[0].data_points[0], { x: 2, y: 1, z: 3 }, 'position X is inverted');
  assert.deepEqual(bodyAnimator.scale[0].data_points[0], { x: 1, y: 1, z: 1 }, 'scale is uninverted');

  assert.equal(undo.initCalls.length, 1, 'one initEdit/finishEdit pair per command');
  assert.equal(undo.finishCalls.length, 1);
  assert.deepEqual(undo.initCalls[0], { animations: [] });

  const roundTrip = await harness.bridge.request('get_geckolib_animation', { name: 'animation.ghost.idle' });
  assert.equal(roundTrip.ok, true, JSON.stringify(roundTrip.error));
  assert.deepEqual(roundTrip.result, IDLE_CLIP_PAYLOAD, 'the clip reads back in the upsert payload shape');
});

test('get_geckolib_animation normalizes out-of-payload interpolation and easing so the result re-upserts', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  injectAnimationGlobals();

  // A UI-authored clip with a bezier keyframe and an easing outside the
  // authoring whitelist — neither is representable in the payload.
  const clip = new FakeAnimation({ name: 'animation.ghost.ui', loop: 'once', length: 1 });
  clip.add(false);
  const body = FakeGroup.all.find((group) => group.name === 'body') as FakeGroup;
  const animator = clip.getBoneAnimator(body);
  animator.addKeyframe({
    time: 0,
    channel: 'rotation',
    interpolation: 'bezier',
    easing: 'wobble',
    data_points: [{ x: 0, y: 0, z: 0 }],
  });

  const result = await harness.bridge.request('get_geckolib_animation', { name: 'animation.ghost.ui' });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  const payload = result.result as { bones: { body: { rotation: Array<Record<string, unknown>> } } };
  assert.deepEqual(
    payload.bones.body.rotation[0],
    { time: 0, value: 0 },
    'bezier interpolation reads back as linear (omitted) and the unknown easing is dropped',
  );
  // The normalized payload must be a valid upsert input.
  const { COMMAND_SPECS } = await import('../src/shared/protocol.js');
  assert.equal(COMMAND_SPECS.upsert_geckolib_animation.params.safeParse(result.result).success, true);
});

test('get_project_state omits the animations summary for a non-geckolib project', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  injectAnimationGlobals();
  injectedGlobals.Cube = { all: [] };
  injectedGlobals.Texture = { all: [] };
  // A java_block project with animations present must not report them under
  // the GeckoLib loop terms.
  injectedGlobals.Format = { id: 'java_block' };
  new FakeAnimation({ name: 'animation.block.spin', loop: 'loop', length: 1 }).add(false);

  const state = await harness.bridge.request('get_project_state', { include_objects: false });
  assert.equal(state.ok, true);
  assert.equal((state.result as { animations?: unknown }).animations, undefined);
});

test('upsert_geckolib_animation requires replace:true to overwrite and keeps the exact name on replace', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const undo = injectAnimationGlobals();

  const first = await harness.bridge.request('upsert_geckolib_animation', IDLE_CLIP_PAYLOAD);
  assert.equal(first.ok, true);
  const original = FakeAnimation.all[0];

  const collision = await harness.bridge.request('upsert_geckolib_animation', { ...IDLE_CLIP_PAYLOAD, length: 3 });
  assert.equal(collision.ok, false);
  assert.equal(collision.error?.code, 'E_FILE_EXISTS');
  assert.match(collision.error?.message ?? '', /replace:true/);
  assert.deepEqual(collision.error?.details, { animation: 'animation.ghost.idle' });
  assert.equal(FakeAnimation.all[0], original, 'the existing clip is untouched');
  assert.equal(original.length, 2);

  const replaced = await harness.bridge.request('upsert_geckolib_animation', {
    ...IDLE_CLIP_PAYLOAD,
    length: 3,
    replace: true,
  });
  assert.equal(replaced.ok, true, JSON.stringify(replaced.error));
  assert.deepEqual(replaced.result, { name: 'animation.ghost.idle', status: 'replaced' });
  assert.equal(FakeAnimation.all.length, 1, 'replace leaves exactly one clip');
  assert.equal(
    FakeAnimation.all[0].name,
    'animation.ghost.idle',
    'remove-before-add avoids the unique-name suffix rename',
  );
  assert.equal(FakeAnimation.all[0].length, 3);
  assert.equal(undo.cancelCalls.length, 0, 'no rollback ran');
});

test('upsert_geckolib_animation rejects unknown and ambiguous bone names before any mutation', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const undo = injectAnimationGlobals();

  const unknown = await harness.bridge.request('upsert_geckolib_animation', {
    name: 'animation.ghost.idle',
    length: 1,
    bones: { tail: { rotation: [{ time: 0, value: 0 }] }, body: { rotation: [{ time: 0, value: 0 }] } },
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error?.code, 'E_INVALID_PARAMS');
  const unknownDetails = unknown.error?.details as { unknown_bones: string[]; ambiguous_bones: string[] };
  assert.deepEqual(unknownDetails.unknown_bones, ['tail']);
  assert.equal(FakeAnimation.all.length, 0, 'no clip is created');
  assert.equal(undo.initCalls.length, 0, 'no undo entry is opened');

  FakeGroup.all.push(new FakeGroup('Body'));
  const ambiguous = await harness.bridge.request('upsert_geckolib_animation', {
    name: 'animation.ghost.idle',
    length: 1,
    bones: { body: { rotation: [{ time: 0, value: 0 }] } },
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error?.code, 'E_INVALID_PARAMS');
  const ambiguousDetails = ambiguous.error?.details as { unknown_bones: string[]; ambiguous_bones: string[] };
  assert.deepEqual(ambiguousDetails.ambiguous_bones, ['body']);
  assert.equal(FakeAnimation.all.length, 0);
  assert.equal(undo.initCalls.length, 0, 'no undo entry is opened for the ambiguous payload');
});

test('upsert rejects a payload whose bone keys collide on one group', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  FakeAnimation.all = [];
  FakeGroup.all = [new FakeGroup('body')];
  const undo = makeFakeUndo();
  injectedGlobals.Formats = { geckolib_model: {} };
  injectedGlobals.Format = { id: 'geckolib_model' };
  injectedGlobals.Project = { saved: true, name: 'ghost' };
  injectedGlobals.Group = FakeGroup;
  injectedGlobals.Undo = undo;
  injectedGlobals.Blockbench = { Animation: FakeAnimation };
  injectedGlobals.invertMolang = fakeInvertMolang;

  const collide = await harness.bridge.request('upsert_geckolib_animation', {
    name: 'animation.ghost.idle',
    length: 1,
    bones: {
      body: { rotation: [{ time: 0, value: 0 }] },
      Body: { rotation: [{ time: 0, value: 1 }] },
    },
  });
  assert.equal(collide.ok, false);
  assert.equal(collide.error?.code, 'E_INVALID_PARAMS');
  const details = collide.error?.details as { colliding_bones: string[] };
  assert.deepEqual(details.colliding_bones.sort(), ['Body', 'body']);
  assert.equal(FakeAnimation.all.length, 0, 'no clip is created');
  assert.equal(undo.initCalls.length, 0, 'no undo entry is opened');
});

test('a keyframe-level invalid payload fails plugin-side validation without leaving a partial clip', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const undo = injectAnimationGlobals();

  const duplicateTimes = await harness.bridge.request('upsert_geckolib_animation', {
    name: 'animation.ghost.idle',
    length: 1,
    bones: {
      body: {
        rotation: [
          { time: 0.5, value: 0 },
          { time: 0.5, value: 1 },
        ],
      },
    },
  });
  assert.equal(duplicateTimes.ok, false);
  assert.equal(duplicateTimes.error?.code, 'E_INVALID_PARAMS');
  assert.equal(FakeAnimation.all.length, 0);
  assert.equal(undo.initCalls.length, 0);
});

test('a mid-apply Blockbench failure rolls back to the previous animation state', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const undo = injectAnimationGlobals();

  const first = await harness.bridge.request('upsert_geckolib_animation', IDLE_CLIP_PAYLOAD);
  assert.equal(first.ok, true);
  const original = FakeAnimation.all[0];

  const workingAddKeyframe = FakeBoneAnimator.prototype.addKeyframe;
  let keyframeCalls = 0;
  FakeBoneAnimator.prototype.addKeyframe = function (data) {
    keyframeCalls += 1;
    if (keyframeCalls === 3) throw new Error('injected keyframe failure');
    return workingAddKeyframe.call(this, data);
  };
  t.after(() => {
    FakeBoneAnimator.prototype.addKeyframe = workingAddKeyframe;
  });

  const failed = await harness.bridge.request('upsert_geckolib_animation', {
    ...IDLE_CLIP_PAYLOAD,
    length: 9,
    replace: true,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.error?.code, 'E_BLOCKBENCH_ERROR');
  const details = failed.error?.details as { reason?: string };
  assert.match(details.reason ?? '', /injected keyframe failure/);

  assert.deepEqual(undo.cancelCalls, [true], 'the rollback reverts through cancelEdit(true)');
  assert.equal(FakeAnimation.all.length, 1, 'no partial clip remains');
  assert.equal(FakeAnimation.all[0], original, 'the replaced clip is restored');
  assert.equal(FakeAnimation.all[0].length, 2, 'the restored clip keeps its pre-replace properties');
});

test('delete_geckolib_animation removes the clip in one undo step and reports missing names', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const undo = injectAnimationGlobals();

  await harness.bridge.request('upsert_geckolib_animation', IDLE_CLIP_PAYLOAD);
  const deleted = await harness.bridge.request('delete_geckolib_animation', { name: 'animation.ghost.idle' });
  assert.equal(deleted.ok, true);
  assert.deepEqual(deleted.result, { deleted: true });
  assert.equal(FakeAnimation.all.length, 0);
  assert.equal(undo.initCalls.length, 2, 'upsert and delete each open exactly one undo entry');
  assert.equal(undo.finishCalls.length, 2);

  const missing = await harness.bridge.request('delete_geckolib_animation', { name: 'animation.ghost.idle' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error?.code, 'E_NOT_FOUND');

  const missingGet = await harness.bridge.request('get_geckolib_animation', { name: 'animation.ghost.idle' });
  assert.equal(missingGet.ok, false);
  assert.equal(missingGet.error?.code, 'E_NOT_FOUND');
});

test('get_project_state lists an animations summary in GeckoLib loop terms', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  injectAnimationGlobals();
  injectedGlobals.Cube = { all: [] };
  injectedGlobals.Texture = { all: [] };

  const empty = await harness.bridge.request('get_project_state', { include_objects: false });
  assert.equal(empty.ok, true);
  assert.equal(
    (empty.result as { animations?: unknown }).animations,
    undefined,
    'no animations key while the project has no animations',
  );

  new FakeAnimation({ name: 'animation.ghost.idle', loop: 'hold', length: 2 }).add(false);
  new FakeAnimation({ name: 'animation.ghost.walk', loop: 'loop', length: 1 }).add(false);
  const state = await harness.bridge.request('get_project_state', { include_objects: false });
  assert.equal(state.ok, true);
  assert.deepEqual((state.result as { animations?: unknown }).animations, [
    { name: 'animation.ghost.idle', loop: 'hold_on_last_frame', length: 2 },
    { name: 'animation.ghost.walk', loop: 'loop', length: 1 },
  ]);
});

test('validate_project runs the shared animation checks on the in-memory build and skips the build with zero animations', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  injectAnimationGlobals();
  injectedGlobals.Cube = { all: [] };
  injectedGlobals.Texture = { all: [] };
  injectedGlobals.Validator = { checks: [] };
  injectedGlobals.Project = {
    saved: true,
    name: 'ghost',
    geckolib_modid: 'examplemod',
    model_identifier: 'ghost',
    geckolib_model_type: 'Entity',
  };
  let buildFileCalls = 0;
  injectedGlobals.Animator = {
    buildFile: (_path: unknown, names: string[]) => {
      buildFileCalls += 1;
      return {
        animations: {
          [names[0]]: {
            loop: 'forever',
            animation_length: 2,
            bones: { tail: { rotation: { '0.0': [0, 0, 0] } } },
          },
        },
        geckolib_format_version: 2,
      };
    },
  };

  const noAnimations = await harness.bridge.request('validate_project', {});
  assert.equal(noAnimations.ok, true);
  assert.deepEqual((noAnimations.result as { diagnostics: unknown[] }).diagnostics, []);
  assert.equal(buildFileCalls, 0, 'the animation build is skipped with zero animations');

  new FakeAnimation({ name: 'animation.ghost.idle', loop: 'loop', length: 2 }).add(false);
  const withAnimations = await harness.bridge.request('validate_project', {});
  assert.equal(withAnimations.ok, true);
  assert.equal(buildFileCalls, 1);
  const diagnostics = (withAnimations.result as { diagnostics: Array<{ check_id?: string; severity: string }> })
    .diagnostics;
  assert.deepEqual(
    diagnostics.map((d) => d.check_id).sort(),
    ['geckolib_animation_loop_value', 'geckolib_animation_missing_bone'],
    'content checks and the orphaned-bone cross-check both run on the build output',
  );

  injectedGlobals.Animator = {
    buildFile: () => {
      throw new Error('injected build failure');
    },
  };
  const buildFailure = await harness.bridge.request('validate_project', {});
  assert.equal(buildFailure.ok, true);
  const failureDiagnostics = (buildFailure.result as {
    diagnostics: Array<{ check_id?: string; severity: string; message: string }>;
  }).diagnostics;
  assert.equal(failureDiagnostics.length, 1);
  assert.equal(failureDiagnostics[0].severity, 'warning');
  assert.equal(failureDiagnostics[0].check_id, 'geckolib_animation_build');
  assert.match(failureDiagnostics[0].message, /injected build failure/);
});

test('capture_geckolib_animation_frame poses one animation, renders, and restores animation state', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  injectAnimationGlobals();
  const surface = injectAnimationScreenshotSurface();
  const idle = addFakeAnimation('animation.ghost.idle', 'once', 2);
  const walk = addFakeAnimation('animation.ghost.walk', 'loop', 1);
  const body = FakeGroup.all.find((group) => group.name === 'body') as FakeGroup;
  const effectAnimator = { muted: { sound: false, particle: false, timeline: false } };
  idle.animators.effects = effectAnimator;
  walk.playing = true;
  walk.select();
  const timeline = injectedGlobals.Timeline as { time: number; playing: boolean; setTime(seconds: number): void };
  timeline.setTime(0.75);

  const outcome = await harness.bridge.request('capture_geckolib_animation_frame', {
    animation: 'animation.ghost.idle',
    time: 1.25,
    width: 320,
    height: 240,
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome.error));
  assert.deepEqual(outcome.result, {
    data_url: 'data:image/png;base64,pose-1',
    project: { uuid: 'project-animation', name: 'ghost' },
    counts: { cubes: 3, groups: 2, textures: 1 },
    width: 320,
    height: 240,
    animation: 'animation.ghost.idle',
    time: 1.25,
    rendered_time: 1.25,
  });
  assert.deepEqual(surface.captures, [{ preview: 'visible', options: { width: 320, height: 240, crop: false } }]);
  assert.deepEqual(
    surface.previewStates[0],
    { time: 1.25, playing: ['animation.ghost.idle'], muted: [true] },
    'the still preview uses only the target animation with effect channels muted',
  );
  assert.equal(FakeAnimation.selected, walk, 'the previous selected animation is restored');
  assert.equal(walk.selected, true);
  assert.equal(idle.selected, false);
  assert.equal(walk.playing, true, 'previous playing flags are restored');
  assert.equal(idle.playing, false);
  assert.equal(timeline.time, 0.75, 'the previous timeline time is restored');
  assert.equal(effectAnimator.muted.particle, false, 'effect mute flags are restored');
  assert.equal(effectAnimator.muted.timeline, false);
  assert.equal(effectAnimator.muted.sound, false);
  assert.equal(body.name, 'body', 'existing fake runtime remains usable after the capture');
});

test('capture_geckolib_animation_frame uses preset screenshots without touching the visible preview', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  injectAnimationGlobals();
  const { visible, offscreen, captures } = injectAnimationScreenshotSurface();
  addFakeAnimation('animation.ghost.idle', 'once', 1);

  const outcome = await harness.bridge.request('capture_geckolib_animation_frame', {
    animation: 'animation.ghost.idle',
    time: 0.5,
    angle_preset: 'top',
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome.error));
  const result = outcome.result as { angle_preset?: string; rendered_time?: number };
  assert.equal(result.angle_preset, 'top');
  assert.equal(result.rendered_time, 0.5);
  assert.equal(captures[0].preview, 'offscreen');
  assert.equal(offscreen.presetsLoaded.length, 1);
  assert.equal((offscreen.presetsLoaded[0] as { id?: string }).id, 'top');
  assert.equal(visible.presetsLoaded.length, 0, 'the visible camera is not moved for preset renders');
});

test('capture_geckolib_animation_frame applies loop timing rules before Timeline.setTime', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  injectAnimationGlobals();
  injectAnimationScreenshotSurface();
  addFakeAnimation('animation.ghost.loop', 'loop', 2);
  addFakeAnimation('animation.ghost.hold', 'hold', 2);
  addFakeAnimation('animation.ghost.once', 'once', 2);
  const timeline = injectedGlobals.Timeline as { time: number };

  const looped = await harness.bridge.request('capture_geckolib_animation_frame', {
    animation: 'animation.ghost.loop',
    time: 5.25,
  });
  assert.equal(looped.ok, true, JSON.stringify(looped.error));
  assert.equal((looped.result as { rendered_time: number }).rendered_time, 1.25);

  const held = await harness.bridge.request('capture_geckolib_animation_frame', {
    animation: 'animation.ghost.hold',
    time: 5.25,
  });
  assert.equal(held.ok, true, JSON.stringify(held.error));
  assert.equal((held.result as { rendered_time: number }).rendered_time, 2);

  timeline.time = 0.4;
  const once = await harness.bridge.request('capture_geckolib_animation_frame', {
    animation: 'animation.ghost.once',
    time: 2.1,
  });
  assert.equal(once.ok, false);
  assert.equal(once.error?.code, 'E_INVALID_PARAMS');
  assert.equal(timeline.time, 0.4, 'out-of-range once mode rejects before Timeline.setTime mutates time');
});

test('capture_geckolib_animation_frame rejects active playback and missing animations before posing', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  injectAnimationGlobals();
  const surface = injectAnimationScreenshotSurface();
  addFakeAnimation('animation.ghost.idle', 'once', 1);
  const timeline = injectedGlobals.Timeline as { playing: boolean };
  timeline.playing = true;

  const active = await harness.bridge.request('capture_geckolib_animation_frame', {
    animation: 'animation.ghost.idle',
    time: 0,
  });
  assert.equal(active.ok, false);
  assert.equal(active.error?.code, 'E_BLOCKBENCH_ERROR');
  assert.match(active.error?.message ?? '', /playback/i);
  assert.equal(surface.captures.length, 0, 'no screenshot starts while playback is active');

  timeline.playing = false;
  const missing = await harness.bridge.request('capture_geckolib_animation_frame', {
    animation: 'animation.ghost.missing',
    time: 0,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error?.code, 'E_NOT_FOUND');
  assert.equal(surface.captures.length, 0, 'missing animation does not pose or render');
});

test('capture_geckolib_animation_frame restores state after screenshot failure and the queue keeps serving', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  injectAnimationGlobals();
  injectAnimationScreenshotSurface({ failFirstCapture: true });
  const idle = addFakeAnimation('animation.ghost.idle', 'once', 1);
  const walk = addFakeAnimation('animation.ghost.walk', 'loop', 1);
  walk.playing = true;
  walk.select();
  const timeline = injectedGlobals.Timeline as { time: number; setTime(seconds: number): void };
  timeline.setTime(0.2);

  const failed = await harness.bridge.request('capture_geckolib_animation_frame', {
    animation: 'animation.ghost.idle',
    time: 0.5,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.error?.code, 'E_BLOCKBENCH_ERROR');
  assert.equal(FakeAnimation.selected, walk);
  assert.equal(walk.playing, true);
  assert.equal(idle.playing, false);
  assert.equal(timeline.time, 0.2);

  const next = await harness.bridge.request('capture_geckolib_animation_frame', {
    animation: 'animation.ghost.idle',
    time: 0.25,
  });
  assert.equal(next.ok, true, JSON.stringify(next.error));
  assert.equal((next.result as { rendered_time: number }).rendered_time, 0.25);
});

test('concurrent GeckoLib animation frame captures serialize the full pose-render-restore section', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  injectAnimationGlobals();
  const surface = injectAnimationScreenshotSurface({ captureDelayMs: 40 });
  const idle = addFakeAnimation('animation.ghost.idle', 'loop', 2);
  const walk = addFakeAnimation('animation.ghost.walk', 'loop', 2);
  walk.playing = true;
  walk.select();

  const [first, second] = await Promise.all([
    harness.bridge.request('capture_geckolib_animation_frame', { animation: 'animation.ghost.idle', time: 0.25 }),
    harness.bridge.request('capture_geckolib_animation_frame', { animation: 'animation.ghost.walk', time: 1.25 }),
  ]);
  assert.equal(first.ok, true, JSON.stringify(first.error));
  assert.equal(second.ok, true, JSON.stringify(second.error));
  assert.deepEqual(
    surface.events.filter((event) => event.startsWith('preview:') || event.startsWith('start:') || event.startsWith('end:')),
    ['preview:still:0.25', 'start:1', 'end:1', 'preview:still:0', 'preview:still:1.25', 'start:2', 'end:2', 'preview:still:0'],
    'each request restores the previous pose before the next request poses and renders',
  );
  assert.equal(FakeAnimation.selected, walk);
  assert.equal(idle.playing, false);
  assert.equal(walk.playing, true);
});

test('open_geckolib_model reloads file-linked textures before returning the resolved path and textures', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);

  type Listener = () => void;
  const listeners: Array<{ type: string; listener: Listener }> = [];
  const img = {
    addEventListener: (type: string, listener: Listener) => listeners.push({ type, listener }),
    removeEventListener: (type: string, listener: Listener) => {
      const index = listeners.findIndex((entry) => entry.type === type && entry.listener === listener);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
  let loaded = false;
  const linked = {
    id: '0',
    name: 'ghost.png',
    path: join(harness.scopeDir, 'ghost.png'),
    internal: false,
    error: 0,
    img,
    reloads: 0,
    reloadTexture() {
      this.reloads += 1;
      setTimeout(() => {
        loaded = true;
        for (const entry of listeners.filter((candidate) => candidate.type === 'load')) entry.listener();
      }, 20);
    },
  };
  // An embedded texture from another machine keeps a stale, non-empty path.
  const embedded = {
    id: '1',
    name: 'skin.png',
    path: 'C:\\Users\\someone\\skin.png',
    internal: true,
    error: 0,
    img,
    reloads: 0,
    reloadTexture() {},
  };
  const textures = { all: [] as unknown[] };
  let parsedPath: string | undefined;
  injectedGlobals.Formats = { geckolib_model: {} };
  injectedGlobals.Project = null;
  injectedGlobals.Cube = { all: [] };
  injectedGlobals.Group = { all: [] };
  injectedGlobals.Texture = textures;
  injectedGlobals.Canvas = { updateAll: () => {} };
  injectedGlobals.newProject = () => {
    injectedGlobals.Project = { saved: true, name: 'ghost' };
    return true;
  };
  injectedGlobals.Codecs = {
    project: {
      parse: (_model: unknown, path: string) => {
        parsedPath = path;
        textures.all.push(linked, embedded);
      },
    },
  };
  nodeFs.writeFileSync(
    join(harness.scopeDir, 'ghost.bbmodel'),
    JSON.stringify({ meta: { format_version: '5.0', model_format: 'geckolib_model' }, name: 'ghost' }),
  );

  const outcome = await harness.bridge.request('open_geckolib_model', { path: 'ghost.bbmodel' });
  assert.equal(outcome.ok, true, JSON.stringify(outcome.error));
  assert.equal(COMMAND_SPECS.open_geckolib_model.result.safeParse(outcome.result).success, true);
  const result = outcome.result as { path: string; name: string; textures: unknown[] };
  assert.equal(result.path, join(harness.scopeDir, 'ghost.bbmodel'));
  assert.equal(parsedPath, result.path);
  assert.equal(result.name, 'ghost');
  assert.deepEqual(result.textures, [
    { id: '0', name: 'ghost.png', path: join(harness.scopeDir, 'ghost.png') },
    { id: '1', name: 'skin.png', path: null },
  ]);
  assert.equal(loaded, true, 'the result waits for the reloaded image');
  assert.deepEqual([linked.reloads, embedded.reloads], [1, 0], 'embedded textures are not reloaded');
  assert.equal(listeners.length, 0, 'settle listeners are detached');
});

test('capture_geckolib_animation_frame preflights file conflicts before rendering and requires an output path for overwrite', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const dataUrl = 'data:image/png;base64,aGVsbG8=';
  injectAnimationGlobals();
  const surface = injectAnimationScreenshotSurface({ dataUrl });
  addFakeAnimation('animation.ghost.idle', 'once', 1);
  const args = { animation: 'animation.ghost.idle', time: 0.5 };
  const destination = join(harness.scopeDir, 'existing.png');
  nodeFs.writeFileSync(destination, 'original');
  const conflict = await harness.bridge.request('capture_geckolib_animation_frame', { ...args, output_path: 'existing.png' });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error?.code, 'E_FILE_EXISTS');
  assert.equal(surface.captures.length, 0);
  assert.equal(nodeFs.readFileSync(destination, 'utf8'), 'original');
  for (const overwrite of [false, true]) {
    const invalid = await harness.bridge.request('capture_geckolib_animation_frame', { ...args, overwrite });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error?.code, 'E_INVALID_PARAMS');
    assert.equal(surface.captures.length, 0);
  }
  const [first, second] = await Promise.all([
    harness.bridge.request('capture_geckolib_animation_frame', { ...args, output_path: 'queued.png' }),
    harness.bridge.request('capture_geckolib_animation_frame', { ...args, output_path: 'queued.png' }),
  ]);
  assert.equal(first.ok, true, JSON.stringify(first.error));
  assert.equal(second.ok, false);
  assert.equal(second.error?.code, 'E_FILE_EXISTS', 'the file the earlier queued capture wrote is a conflict');
  assert.equal(surface.captures.length, 1, 'the conflicting capture never poses or renders');
});

test('capture_geckolib_animation_frame writes scoped PNG bytes and returns file metadata without a data URL', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6sAAAAABJRU5ErkJggg==';
  const dataUrl = `data:image/png;base64,${base64}`;
  injectAnimationGlobals();
  const surface = injectAnimationScreenshotSurface({ dataUrl });
  addFakeAnimation('animation.ghost.idle', 'once', 1);
  const args = { animation: 'animation.ghost.idle', time: 0.5, width: 64, height: 64, angle_preset: 'top' };
  const writes: Array<{ path: unknown; content: unknown; options: unknown }> = [];
  const originalWrite = nodeFsAdapter.writeFileSync;
  nodeFsAdapter.writeFileSync = (path, content, options) => {
    writes.push({ path, content, options });
    return originalWrite(path, content, options);
  };
  t.after(() => { nodeFsAdapter.writeFileSync = originalWrite; });
  const destination = join(harness.scopeDir, 'renders', 'capture.png');
  for (const output_path of ['renders/capture.png', destination]) {
    const overwrite = output_path === destination;
    const outcome = await harness.bridge.request('capture_geckolib_animation_frame', { ...args, output_path, overwrite });
    assert.equal(outcome.ok, true, JSON.stringify(outcome.error));
    const result = outcome.result as Record<string, unknown>;
    assert.equal('data_url' in result, false);
    assert.equal(result.path, destination);
    assert.equal(result.bytes, Buffer.from(base64, 'base64').length);
    assert.equal(result.width, 64);
    assert.equal(result.height, 64);
    assert.equal(result.angle_preset, 'top');
    assert.equal(result.animation, args.animation);
    assert.equal(result.time, args.time);
    assert.equal(result.rendered_time, args.time);
    assert.deepEqual(result.project, { uuid: 'project-animation', name: 'ghost' });
    assert.deepEqual(result.counts, { cubes: 3, groups: 2, textures: 1 });
    assert.deepEqual(nodeFs.readFileSync(destination), Buffer.from(base64, 'base64'));
  }
  assert.equal(surface.captures.length, 2);
  assert.equal(writes.length, 2);
});
