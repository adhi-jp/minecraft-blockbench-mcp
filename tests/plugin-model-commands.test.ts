// Model command handler tests through the real dispatcher (bridge → session),
// with Blockbench globals injected on globalThis. node --test runs each file
// in its own process, so the global assignments stay file-local. Handlers that
// need the full Blockbench runtime (newProject, codecs, canvas) are covered by
// manual smoke testing against a live Blockbench; these tests prove the
// read-back mapping, the uuid filtering, and the guard behavior.
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
import { COMMAND_SPECS } from '../src/shared/protocol.js';

const SECRET = 'model-cmd-secret-17';
let nextPort = 40900;

/** Arms a one-shot write failure to exercise rollback after a clean preflight. */
let failNextWrite = false;

const nodeFsAdapter: ScopedFsLike = {
  readFileSync: (path, options) => nodeFs.readFileSync(path as string, options as never),
  writeFileSync: (path, content, options) => {
    if (failNextWrite) {
      failNextWrite = false;
      throw new Error('injected write failure');
    }
    nodeFs.writeFileSync(path as string, content as never, options as never);
  },
  existsSync: (path) => nodeFs.existsSync(path),
  mkdirSync: (path, options) => nodeFs.mkdirSync(path as string, options as never),
  readdirSync: (path, options) => nodeFs.readdirSync(path as string, options as never),
  statSync: (path) => nodeFs.statSync(path as string),
};

const injectedGlobals = globalThis as Record<string, unknown>;

function clearBlockbenchGlobals(): void {
  delete injectedGlobals.Project;
  delete injectedGlobals.Format;
  delete injectedGlobals.Cube;
  delete injectedGlobals.Group;
  delete injectedGlobals.Texture;
  delete injectedGlobals.Codecs;
  delete injectedGlobals.Blockbench;
  delete injectedGlobals.Undo;
  delete injectedGlobals.Canvas;
  delete injectedGlobals.UVSizeUtil;
  delete injectedGlobals.UVEditor;
  delete injectedGlobals.Preview;
  delete injectedGlobals.Screencam;
  delete injectedGlobals.DefaultCameraPresets;
  delete injectedGlobals.document;
  delete (Math as unknown as Record<string, unknown>).areMultiples;
}

// ---------------------------------------------------------------------------
// Fake Blockbench outliner runtime, mirroring the runtime shapes the read-back
// handler relies on: Cube.all/Group.all registries, parent as a Group instance
// or 'root', ordered Group.children, and CubeFace.texture storing a texture
// UUID string, false (no texture), or null (face disabled).
// ---------------------------------------------------------------------------

class FakeTexture {
  static all: FakeTexture[] = [];
  uuid: string;
  name: string;
  constructor(uuid: string, name: string) {
    this.uuid = uuid;
    this.name = name;
    FakeTexture.all.push(this);
  }
}

class FakeCubeFace {
  uv: [number, number, number, number];
  rotation: number;
  texture: string | false | null;
  constructor(uv: [number, number, number, number], texture: string | false | null, rotation = 0) {
    this.uv = uv;
    this.texture = texture;
    this.rotation = rotation;
  }
}

type FakeParent = FakeGroup | 'root';

class FakeCube {
  static all: FakeCube[] = [];
  static selected: FakeCube[] = [];
  uuid: string;
  name: string;
  from: [number, number, number];
  to: [number, number, number];
  origin: [number, number, number];
  rotation: [number, number, number];
  visibility = true;
  box_uv = false;
  uv_offset: [number, number] = [0, 0];
  mirror_uv = false;
  faces: Record<string, FakeCubeFace>;
  parent: FakeParent = 'root';
  constructor(options: {
    uuid: string;
    name: string;
    from: [number, number, number];
    to: [number, number, number];
    origin?: [number, number, number];
    rotation?: [number, number, number];
    faces: Record<string, FakeCubeFace>;
  }) {
    this.uuid = options.uuid;
    this.name = options.name;
    this.from = options.from;
    this.to = options.to;
    this.origin = options.origin ?? [0, 0, 0];
    this.rotation = options.rotation ?? [0, 0, 0];
    this.faces = options.faces;
    FakeCube.all.push(this);
  }
}

class FakeGroup {
  static all: FakeGroup[] = [];
  uuid: string;
  name: string;
  origin: [number, number, number];
  parent: FakeParent = 'root';
  children: Array<FakeCube | FakeGroup | FakeLocator> = [];
  constructor(uuid: string, name: string, origin: [number, number, number] = [0, 0, 0]) {
    this.uuid = uuid;
    this.name = name;
    this.origin = origin;
    FakeGroup.all.push(this);
  }
  addChild(child: FakeCube | FakeGroup | FakeLocator): void {
    child.parent = this;
    this.children.push(child);
  }
}

/** Stand-in for outliner element types outside the read-back surface
 * (locators, meshes): present in a group's children, absent from Cube.all
 * and Group.all. */
class FakeLocator {
  uuid: string;
  name: string;
  parent: FakeParent = 'root';
  constructor(uuid: string, name: string) {
    this.uuid = uuid;
    this.name = name;
  }
}

function sixFaces(texture: string | false | null): Record<string, FakeCubeFace> {
  const faces: Record<string, FakeCubeFace> = {};
  for (const direction of ['north', 'south', 'east', 'west', 'up', 'down']) {
    faces[direction] = new FakeCubeFace([0, 0, 4, 4], texture);
  }
  return faces;
}

/** Inject an open project shaped as:
 *  root
 *  ├─ bone (group)
 *  │  ├─ body (cube, box UV, textured)
 *  │  ├─ head (group)
 *  │  │  └─ eye (cube, per-face UV, rotated north face)
 *  │  └─ anchor (locator-like element outside the read-back surface)
 *  └─ loose (cube, untextured, at the outliner root)
 */
function injectModelProject(): {
  texture: FakeTexture;
  body: FakeCube;
  eye: FakeCube;
  loose: FakeCube;
  bone: FakeGroup;
  head: FakeGroup;
} {
  FakeTexture.all = [];
  FakeCube.all = [];
  FakeGroup.all = [];
  const texture = new FakeTexture('t-1', 'skin');

  const bone = new FakeGroup('g-bone', 'bone', [8, 0, 8]);
  const head = new FakeGroup('g-head', 'head', [8, 12, 8]);
  const body = new FakeCube({
    uuid: 'c-body',
    name: 'body',
    from: [4, 0, 4],
    to: [12, 12, 12],
    origin: [8, 0, 8],
    rotation: [0, 45, 0],
    faces: sixFaces(texture.uuid),
  });
  body.box_uv = true;
  body.uv_offset = [8, 0];
  body.mirror_uv = true;
  const eye = new FakeCube({
    uuid: 'c-eye',
    name: 'eye',
    from: [6, 12, 6],
    to: [10, 14, 10],
    faces: sixFaces(texture.uuid),
  });
  eye.faces.north = new FakeCubeFace([1, 2, 3, 4], texture.uuid, 90);
  const loose = new FakeCube({
    uuid: 'c-loose',
    name: 'loose',
    from: [0, 0, 0],
    to: [1, 1, 1],
    faces: sixFaces(false),
  });
  bone.addChild(body);
  bone.addChild(head);
  bone.addChild(new FakeLocator('l-anchor', 'anchor'));
  head.addChild(eye);

  injectedGlobals.Project = { saved: true, name: 'ghost' };
  injectedGlobals.Format = { id: 'java_block' };
  injectedGlobals.Cube = FakeCube;
  injectedGlobals.Group = FakeGroup;
  injectedGlobals.Texture = FakeTexture;
  return { texture, body, eye, loose, bone, head };
}

interface Harness {
  bridge: WsBridge;
  session: PluginSession;
  scopeDir: string;
  cleanup: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const port = nextPort++;
  const scopeDir = nodeFs.mkdtempSync(join(tmpdir(), 'bbmcp-model-'));

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
  session.start();

  try {
    const start = Date.now();
    while (!(session.status === 'connected' && bridge.connected)) {
      if (Date.now() - start > 3_000) throw new Error('harness did not connect');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const confirmed = await bridge.request('propose_scoped_directory', { path: scopeDir });
    assert.equal(confirmed.ok, true, `scope proposal failed: ${JSON.stringify(confirmed.error)}`);
  } catch (error) {
    // Tear down on connect failure: the leaked server, reconnect timers, and
    // temp scope dir would otherwise outlive the failed test.
    session.stop();
    await bridge.stop();
    nodeFs.rmSync(scopeDir, { recursive: true, force: true });
    throw error;
  }

  return {
    bridge,
    session,
    scopeDir,
    cleanup: async () => {
      session.stop();
      await bridge.stop();
      nodeFs.rmSync(scopeDir, { recursive: true, force: true });
      clearBlockbenchGlobals();
      failNextWrite = false;
    },
  };
}

test('get_elements with no open project fails with E_NOT_FOUND', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  injectedGlobals.Project = null;

  const outcome = await harness.bridge.request('get_elements', {});
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_NOT_FOUND');
  assert.match(outcome.error?.message ?? '', /create_project|open_model/, 'the error names how to open a project');
});

test('get_elements returns geometry, UV state, resolved textures, and hierarchy for every element', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const project = injectModelProject();

  const outcome = await harness.bridge.request('get_elements', {});
  assert.equal(outcome.ok, true, JSON.stringify(outcome.error));
  const parsed = COMMAND_SPECS.get_elements.result.safeParse(outcome.result);
  assert.equal(parsed.success, true, 'the read-back payload must match the shared result schema');

  const result = outcome.result as {
    cubes: Array<Record<string, unknown>>;
    groups: Array<Record<string, unknown>>;
  };
  assert.equal(result.cubes.length, 3);
  assert.equal(result.groups.length, 2);

  const body = result.cubes.find((cube) => cube.uuid === project.body.uuid);
  assert.deepEqual(body, {
    uuid: 'c-body',
    name: 'body',
    from: [4, 0, 4],
    to: [12, 12, 12],
    origin: [8, 0, 8],
    rotation: [0, 45, 0],
    visibility: true,
    box_uv: true,
    uv_offset: [8, 0],
    mirror_uv: true,
    faces: Object.fromEntries(
      ['north', 'south', 'east', 'west', 'up', 'down'].map((direction) => [
        direction,
        { uv: [0, 0, 4, 4], rotation: 0, texture_uuid: 't-1' },
      ]),
    ),
    parent_uuid: 'g-bone',
  });

  const eye = result.cubes.find((cube) => cube.uuid === project.eye.uuid) as { faces: Record<string, unknown> };
  assert.deepEqual(eye.faces.north, { uv: [1, 2, 3, 4], rotation: 90, texture_uuid: 't-1' });

  const loose = result.cubes.find((cube) => cube.uuid === project.loose.uuid) as {
    faces: Record<string, { texture_uuid: string | null }>;
    parent_uuid: string | null;
  };
  assert.equal(loose.parent_uuid, null, 'an element at the outliner root reads back a null parent');
  assert.equal(loose.faces.north.texture_uuid, null, 'a textureless face resolves to null');

  const bone = result.groups.find((group) => group.uuid === project.bone.uuid) as {
    parent_uuid: string | null;
    children: string[];
    origin: number[];
  };
  assert.equal(bone.parent_uuid, null);
  assert.deepEqual(bone.origin, [8, 0, 8]);
  assert.deepEqual(
    bone.children,
    ['c-body', 'g-head'],
    'children keep outliner order, mix cubes with groups, and omit locator-like elements',
  );
  const head = result.groups.find((group) => group.uuid === project.head.uuid) as {
    parent_uuid: string | null;
    children: string[];
  };
  assert.equal(head.parent_uuid, 'g-bone');
  assert.deepEqual(head.children, ['c-eye']);
});

test('get_elements uuids filter bounds the response to the requested cubes and groups', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const project = injectModelProject();

  const outcome = await harness.bridge.request('get_elements', {
    uuids: [project.eye.uuid, project.head.uuid],
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome.error));
  const result = outcome.result as { cubes: Array<{ uuid: string }>; groups: Array<{ uuid: string }> };
  assert.deepEqual(
    result.cubes.map((cube) => cube.uuid),
    ['c-eye'],
  );
  assert.deepEqual(
    result.groups.map((group) => group.uuid),
    ['g-head'],
  );
});

test('get_elements with any unknown UUID fails with E_NOT_FOUND and returns no partial result', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const project = injectModelProject();

  const outcome = await harness.bridge.request('get_elements', {
    uuids: [project.body.uuid, 'missing-1', 'missing-2'],
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_NOT_FOUND');
  assert.equal(outcome.result, undefined, 'a failed lookup must not leak a partial payload');
  const details = outcome.error?.details as { uuids: string[] };
  assert.deepEqual(details.uuids, ['missing-1', 'missing-2'], 'the error names exactly the unknown UUIDs');
});

// ---------------------------------------------------------------------------
// save_project: compile via the project codec and write through the scoped
// path, with the three save-path semantics (fresh / same path / divergent).
// ---------------------------------------------------------------------------

/** Inject an open project plus a project codec whose compile output records
 * the Project.save_path in effect at compile time. */
function injectSaveProject(
  options: { savePath?: string; saved?: boolean; failCompile?: boolean; compileResult?: unknown } = {},
): {
  compileCount: () => number;
  removedFlags: string[];
} {
  let compiles = 0;
  const removedFlags: string[] = [];
  injectedGlobals.Project = { saved: options.saved ?? false, name: 'ghost', save_path: options.savePath ?? '' };
  injectedGlobals.Format = { id: 'java_block' };
  injectedGlobals.Blockbench = { removeFlag: (flag: string) => removedFlags.push(flag) };
  injectedGlobals.Codecs = {
    project: {
      compile: () => {
        compiles += 1;
        if (options.failCompile === true) throw new Error('compile exploded');
        if (options.compileResult !== undefined) return options.compileResult;
        const project = injectedGlobals.Project as { save_path: string };
        return JSON.stringify({
          meta: { model_format: 'java_block' },
          compiled_with_save_path: project.save_path,
        });
      },
    },
  };
  return { compileCount: () => compiles, removedFlags };
}

test('save_project on a fresh project adopts the destination, compiles against it, and marks the project saved', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  injectSaveProject();

  const outcome = await harness.bridge.request('save_project', { path: 'ghost.bbmodel' });
  assert.equal(outcome.ok, true, JSON.stringify(outcome.error));
  const result = outcome.result as { path: string; status: string; bytes: number };
  assert.equal(result.status, 'created');
  assert.ok(result.path.endsWith('ghost.bbmodel'));
  assert.ok(result.bytes > 0);

  const written = JSON.parse(nodeFs.readFileSync(result.path, 'utf8'));
  assert.equal(
    written.compiled_with_save_path,
    result.path,
    'save_path must already point at the destination during compile so texture paths relativize against it',
  );
  const project = injectedGlobals.Project as { save_path: string; saved: boolean };
  assert.equal(project.save_path, result.path, 'a fresh project adopts the destination as its save path');
  assert.equal(project.saved, true, 'a successful fresh save clears the unsaved indicator');
});

test('save_project to the current save path re-saves in place and clears the dirty flag', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  injectSaveProject();

  const first = await harness.bridge.request('save_project', { path: 'ghost.bbmodel' });
  assert.equal(first.ok, true, JSON.stringify(first.error));
  const destination = (first.result as { path: string }).path;

  const project = injectedGlobals.Project as { save_path: string; saved: boolean };
  project.saved = false;

  const second = await harness.bridge.request('save_project', { path: 'ghost.bbmodel', overwrite: true });
  assert.equal(second.ok, true, JSON.stringify(second.error));
  assert.equal((second.result as { status: string }).status, 'overwritten');
  assert.equal(project.save_path, destination, 'the save path stays put on a re-save');
  assert.equal(project.saved, true);
});

test('save_project to a divergent path keeps the save target and the dirty flag', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  injectSaveProject();

  const first = await harness.bridge.request('save_project', { path: 'original.bbmodel' });
  assert.equal(first.ok, true, JSON.stringify(first.error));
  const original = (first.result as { path: string }).path;

  const project = injectedGlobals.Project as { save_path: string; saved: boolean };
  project.saved = false; // simulate edits after the first save

  const copy = await harness.bridge.request('save_project', { path: 'copy.bbmodel' });
  assert.equal(copy.ok, true, JSON.stringify(copy.error));
  const copyPath = (copy.result as { path: string }).path;
  assert.ok(copyPath.endsWith('copy.bbmodel'));

  const written = JSON.parse(nodeFs.readFileSync(copyPath, 'utf8'));
  assert.equal(written.compiled_with_save_path, copyPath, 'the divergent copy compiles against its own destination');
  assert.equal(project.save_path, original, 'the user-visible save target must not move to the divergent path');
  assert.equal(project.saved, false, 'the dirty flag survives a divergent save');
});

test('save_project without overwrite on an existing file fails before compiling or touching project state', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const codec = injectSaveProject();

  nodeFs.writeFileSync(join(harness.scopeDir, 'ghost.bbmodel'), 'sentinel');
  const outcome = await harness.bridge.request('save_project', { path: 'ghost.bbmodel' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_FILE_EXISTS');
  assert.equal(nodeFs.readFileSync(join(harness.scopeDir, 'ghost.bbmodel'), 'utf8'), 'sentinel', 'nothing was written');
  assert.equal(codec.compileCount(), 0, 'the preflight must run before the codec compiles anything');
  const project = injectedGlobals.Project as { save_path: string; saved: boolean };
  assert.equal(project.save_path, '', 'a blocked save leaves the save path unset');
  assert.equal(project.saved, false);
});

test('save_project outside the scoped directory fails with the scope error and mutates nothing', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const codec = injectSaveProject();

  const outcome = await harness.bridge.request('save_project', { path: '../outside.bbmodel' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_PATH_OUTSIDE_SCOPE');
  assert.equal(codec.compileCount(), 0);
  const project = injectedGlobals.Project as { save_path: string; saved: boolean };
  assert.equal(project.save_path, '');
  assert.equal(project.saved, false);
});

test('save_project restores the save path and clears the codec flag when compile fails', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const codec = injectSaveProject({ savePath: '/elsewhere/original.bbmodel', failCompile: true });

  const outcome = await harness.bridge.request('save_project', { path: 'ghost.bbmodel' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_BLOCKBENCH_ERROR');
  assert.equal(nodeFs.existsSync(join(harness.scopeDir, 'ghost.bbmodel')), false, 'no file may appear');
  const project = injectedGlobals.Project as { save_path: string; saved: boolean };
  assert.equal(project.save_path, '/elsewhere/original.bbmodel', 'the original save path is restored');
  assert.equal(project.saved, false);
  assert.deepEqual(
    codec.removedFlags,
    ['compiling_bbmodel'],
    'a throwing compile hook must not leave the codec compiling flag stuck',
  );
});

test('save_project rejects a non-string compile result instead of writing coerced garbage', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  injectSaveProject({ compileResult: { meta: {} } });

  const outcome = await harness.bridge.request('save_project', { path: 'ghost.bbmodel' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_BLOCKBENCH_ERROR');
  assert.equal(nodeFs.existsSync(join(harness.scopeDir, 'ghost.bbmodel')), false);
  const project = injectedGlobals.Project as { save_path: string };
  assert.equal(project.save_path, '', 'the save path is restored after the rejected compile');
});

test('save_project rejects a destination that does not end in .bbmodel before any state change', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const codec = injectSaveProject();

  const outcome = await harness.bridge.request('save_project', { path: 'textures/model.json' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_INVALID_PARAMS');
  assert.equal(codec.compileCount(), 0);
  const project = injectedGlobals.Project as { save_path: string };
  assert.equal(project.save_path, '', 'a rejected destination never becomes the save target');
});

test('save_project recognizes a same-path re-save stored with OS-native separators', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  injectSaveProject();

  const first = await harness.bridge.request('save_project', { path: 'ghost.bbmodel' });
  assert.equal(first.ok, true, JSON.stringify(first.error));
  const destination = (first.result as { path: string }).path;

  const project = injectedGlobals.Project as { save_path: string; saved: boolean };
  // Blockbench's own save dialog stores native separators (backslashes on
  // Windows); the re-save must still classify as same-path.
  project.save_path = destination.replaceAll('/', '\\');
  project.saved = false;

  const second = await harness.bridge.request('save_project', { path: 'ghost.bbmodel', overwrite: true });
  assert.equal(second.ok, true, JSON.stringify(second.error));
  assert.equal(project.saved, true, 'a separator-only difference is still the same save target');
  assert.equal(project.save_path, destination, 'the adopted save path is the normalized destination');
});

test('save_project reports success even when the saved setter throws in a listener', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  injectSaveProject();
  const project = injectedGlobals.Project as Record<string, unknown>;
  let savedValue = false;
  Object.defineProperty(project, 'saved', {
    configurable: true,
    get: () => savedValue,
    set: (value: boolean) => {
      savedValue = value;
      throw new Error('saved_state_changed listener exploded');
    },
  });

  const outcome = await harness.bridge.request('save_project', { path: 'ghost.bbmodel' });
  assert.equal(outcome.ok, true, JSON.stringify(outcome.error));
  assert.equal(savedValue, true, 'the saved flag flipped before the listener threw');
});

test('save_project restores the save path when the write fails after a clean preflight', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const codec = injectSaveProject();

  failNextWrite = true;
  const outcome = await harness.bridge.request('save_project', { path: 'ghost.bbmodel' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_BLOCKBENCH_ERROR');
  assert.match(outcome.error?.message ?? '', /nothing was written/, 'a single-file failure must not claim batch writes');
  assert.equal(codec.compileCount(), 1, 'the failure happens at write time, after compile');
  const project = injectedGlobals.Project as { save_path: string; saved: boolean };
  assert.equal(project.save_path, '', 'the fresh project does not keep the failed destination');
  assert.equal(project.saved, false);
});

test('save_project with no open project fails with E_NOT_FOUND', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  injectedGlobals.Project = null;

  const outcome = await harness.bridge.request('save_project', { path: 'ghost.bbmodel' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_NOT_FOUND');
});

// ---------------------------------------------------------------------------
// set_cube_uv / set_texture_resolution / create_cubes UV fields.
// ---------------------------------------------------------------------------

interface FakeUndo {
  initCalls: unknown[];
  finishCalls: Array<{ action: string; aspects: unknown }>;
  initEdit(aspects: unknown): void;
  finishEdit(action: string, aspects?: unknown): void;
}

function makeFakeUndo(): FakeUndo {
  return {
    initCalls: [],
    finishCalls: [],
    initEdit(aspects) {
      this.initCalls.push(aspects);
    },
    finishEdit(action, aspects) {
      this.finishCalls.push({ action, aspects });
    },
  };
}

/** Inject a project with one cube for UV command tests. */
function injectUvProject(
  options: { boxUv?: boolean; formatBoxUv?: boolean; optionalBoxUv?: boolean; uvRotation?: boolean } = {},
): {
  cube: FakeCube & { setUVModeCalls: boolean[]; autouv: number };
  undo: FakeUndo;
  uvRefreshes: () => number;
} {
  FakeCube.all = [];
  FakeCube.selected = [];
  FakeGroup.all = [];
  FakeTexture.all = [];
  const cube = new FakeCube({
    uuid: 'c-uv',
    name: 'uv_cube',
    from: [0, 0, 0],
    to: [4, 4, 4],
    faces: sixFaces(false),
  }) as FakeCube & { setUVModeCalls: boolean[]; autouv: number };
  cube.box_uv = options.boxUv ?? false;
  cube.autouv = 1;
  cube.setUVModeCalls = [];
  (cube as unknown as { setUVMode: (mode: boolean) => void }).setUVMode = (mode: boolean) => {
    cube.setUVModeCalls.push(mode);
    cube.box_uv = mode;
  };
  const undo = makeFakeUndo();
  let uvRefreshes = 0;
  injectedGlobals.Project = { saved: true, name: 'ghost', texture_width: 16, texture_height: 16, box_uv: false };
  injectedGlobals.Format = {
    id: 'java_block',
    box_uv: options.formatBoxUv ?? false,
    optional_box_uv: options.optionalBoxUv ?? true,
    uv_rotation: options.uvRotation ?? true,
  };
  injectedGlobals.Cube = FakeCube;
  injectedGlobals.Group = FakeGroup;
  injectedGlobals.Undo = undo;
  injectedGlobals.Canvas = { updateAllUVs: () => (uvRefreshes += 1), updateAll: () => {} };
  return { cube, undo, uvRefreshes: () => uvRefreshes };
}

test('set_cube_uv writes box-UV state in one undo step, disables auto-UV, and refreshes UVs', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const { cube, undo, uvRefreshes } = injectUvProject({ boxUv: true });

  const outcome = await harness.bridge.request('set_cube_uv', {
    uuid: 'c-uv',
    uv_offset: [8, 4],
    mirror_uv: true,
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome.error));
  assert.deepEqual(outcome.result, { uuid: 'c-uv', updated: true });
  assert.deepEqual(cube.uv_offset, [8, 4]);
  assert.equal(cube.mirror_uv, true);
  assert.equal(cube.autouv, 0, 'explicit UV state must disable auto-UV');
  assert.equal(undo.initCalls.length, 1, 'exactly one undo step');
  assert.equal(undo.finishCalls.length, 1);
  assert.equal(uvRefreshes() >= 1, true, 'the UV view refreshes');
});

test('set_cube_uv writes per-face uv and rotation values', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const { cube } = injectUvProject({ boxUv: false });

  const outcome = await harness.bridge.request('set_cube_uv', {
    uuid: 'c-uv',
    faces: { north: { uv: [1, 2, 3, 4], rotation: 90 }, up: { uv: [4, 0, 8, 4] } },
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome.error));
  assert.deepEqual(cube.faces.north.uv, [1, 2, 3, 4]);
  assert.equal(cube.faces.north.rotation, 90);
  assert.deepEqual(cube.faces.up.uv, [4, 0, 8, 4]);
  assert.equal(cube.faces.up.rotation, 0, 'faces without a rotation keep their current one');
  assert.equal(cube.autouv, 0);
});

test('set_cube_uv switches the UV mode through setUVMode before writing mode-specific fields', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const { cube } = injectUvProject({ boxUv: false, formatBoxUv: false, optionalBoxUv: true });

  const outcome = await harness.bridge.request('set_cube_uv', {
    uuid: 'c-uv',
    box_uv: true,
    uv_offset: [0, 8],
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome.error));
  assert.deepEqual(cube.setUVModeCalls, [true], 'the mode switch goes through the setUVMode API');
  assert.equal(cube.box_uv, true);
  assert.deepEqual(cube.uv_offset, [0, 8]);
});

test('set_cube_uv rejects faces on a box-UV cube without an explicit mode switch', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const { cube, undo } = injectUvProject({ boxUv: true });

  const outcome = await harness.bridge.request('set_cube_uv', {
    uuid: 'c-uv',
    faces: { north: { uv: [0, 0, 4, 4] } },
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_INVALID_PARAMS');
  assert.equal(undo.initCalls.length, 0, 'a rejected call must not start an undo entry');
  assert.equal(cube.autouv, 1, 'a rejected call must not change the cube');
});

test('set_cube_uv rejects box-UV fields on a per-face cube', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const { undo } = injectUvProject({ boxUv: false });

  const outcome = await harness.bridge.request('set_cube_uv', { uuid: 'c-uv', uv_offset: [8, 0] });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_INVALID_PARAMS');
  assert.equal(undo.initCalls.length, 0);
});

test('set_cube_uv fails with E_FORMAT_UNSUPPORTED when the format forbids the mode switch', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const { cube, undo } = injectUvProject({ boxUv: false, formatBoxUv: false, optionalBoxUv: false });

  const outcome = await harness.bridge.request('set_cube_uv', { uuid: 'c-uv', box_uv: true, uv_offset: [0, 0] });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_FORMAT_UNSUPPORTED');
  assert.equal(cube.setUVModeCalls.length, 0);
  assert.equal(undo.initCalls.length, 0);
});

test('set_cube_uv allows switching back to the format default even without optional box UV', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const { cube } = injectUvProject({ boxUv: true, formatBoxUv: false, optionalBoxUv: false });

  const outcome = await harness.bridge.request('set_cube_uv', {
    uuid: 'c-uv',
    box_uv: false,
    faces: { north: { uv: [0, 0, 4, 4] } },
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome.error));
  assert.deepEqual(cube.setUVModeCalls, [false]);
});

test('set_cube_uv fails with E_NOT_FOUND for an unknown cube UUID', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  injectUvProject();

  const outcome = await harness.bridge.request('set_cube_uv', { uuid: 'missing', box_uv: true });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_NOT_FOUND');
});

/** Inject the resolution-change surface: project size, native util spy, and
 * Blockbench's Math.areMultiples extension. */
function injectResolutionProject(current: [number, number]): {
  calls: Array<[number, number, boolean]>;
} {
  const calls: Array<[number, number, boolean]> = [];
  injectedGlobals.Project = {
    saved: true,
    name: 'ghost',
    texture_width: current[0],
    texture_height: current[1],
  };
  injectedGlobals.Format = { id: 'java_block' };
  injectedGlobals.UVSizeUtil = {
    adjustProjectResolution: (width: number, height: number, modifyUv: boolean) => {
      calls.push([width, height, modifyUv]);
      const project = injectedGlobals.Project as { texture_width: number; texture_height: number };
      project.texture_width = width;
      project.texture_height = height;
    },
  };
  (Math as unknown as Record<string, unknown>).areMultiples = (a: number, b: number) => a % b === 0 || b % a === 0;
  return { calls };
}

test('set_texture_resolution delegates to the native resolution utility', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const util = injectResolutionProject([16, 16]);

  const outcome = await harness.bridge.request('set_texture_resolution', { width: 32, height: 64 });
  assert.equal(outcome.ok, true, JSON.stringify(outcome.error));
  assert.deepEqual(outcome.result, { width: 32, height: 64, updated: true });
  assert.deepEqual(util.calls, [[32, 64, false]]);
});

test('set_texture_resolution rescales UVs when the native guard conditions hold', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const util = injectResolutionProject([16, 16]);

  const outcome = await harness.bridge.request('set_texture_resolution', {
    width: 64,
    height: 64,
    rescale_existing_uv: true,
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome.error));
  assert.deepEqual(util.calls, [[64, 64, true]]);
});

test('set_texture_resolution rejects rescale requests the native utility would silently skip', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const util = injectResolutionProject([16, 16]);

  // Non-square target, unchanged width, and non-multiple width are all
  // conditions adjustProjectResolution skips silently; each must fail
  // before any mutation instead.
  for (const [width, height] of [
    [32, 64],
    [16, 16],
    [24, 24],
  ] as Array<[number, number]>) {
    const outcome = await harness.bridge.request('set_texture_resolution', {
      width,
      height,
      rescale_existing_uv: true,
    });
    assert.equal(outcome.ok, false, `${width}x${height} must be rejected`);
    assert.equal(outcome.error?.code, 'E_INVALID_PARAMS');
  }
  assert.deepEqual(util.calls, [], 'no rejected request may reach the native utility');
});

test('set_texture_resolution with no open project fails with E_NOT_FOUND', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  injectedGlobals.Project = null;

  const outcome = await harness.bridge.request('set_texture_resolution', { width: 32, height: 32 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_NOT_FOUND');
});

/** Constructor-recording cube fake for create_cubes dispatch tests. */
class FakeConstructedCube {
  static all: FakeConstructedCube[] = [];
  static constructed: Array<Record<string, unknown>> = [];
  uuid: string;
  name: string;
  parent: unknown = 'root';
  constructor(options: Record<string, unknown>) {
    this.name = String(options.name ?? 'cube');
    this.uuid = `cc-${FakeConstructedCube.constructed.length + 1}`;
    FakeConstructedCube.constructed.push(options);
  }
  init(): this {
    FakeConstructedCube.all.push(this);
    return this;
  }
  extend(changes: Record<string, unknown>): this {
    Object.assign(FakeConstructedCube.constructed[FakeConstructedCube.constructed.length - 1], changes);
    return this;
  }
  addTo(): this {
    return this;
  }
}

function injectCreateCubesProject(format: Record<string, unknown>): void {
  FakeConstructedCube.all = [];
  FakeConstructedCube.constructed = [];
  injectedGlobals.Project = { saved: true, name: 'ghost', box_uv: false };
  injectedGlobals.Format = format;
  injectedGlobals.Cube = FakeConstructedCube;
  injectedGlobals.Group = FakeGroup;
  injectedGlobals.Undo = makeFakeUndo();
  injectedGlobals.Canvas = { updateAll: () => {}, updateAllUVs: () => {} };
}

test('create_cubes passes box_uv and uv_offset through and disables auto-UV only for UV data', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  injectCreateCubesProject({ id: 'java_block', box_uv: false, optional_box_uv: true });

  const outcome = await harness.bridge.request('create_cubes', {
    cubes: [
      { name: 'plain', from: [0, 0, 0], to: [1, 1, 1] },
      { name: 'boxed', from: [0, 0, 0], to: [2, 2, 2], box_uv: true, uv_offset: [8, 0] },
      { name: 'restated_default', from: [0, 0, 0], to: [3, 3, 3], box_uv: false },
    ],
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome.error));
  const [plain, boxed, restated] = FakeConstructedCube.constructed;
  assert.equal(plain.autouv, 1, 'cubes without UV fields keep auto-UV enabled');
  assert.equal('box_uv' in plain, false);
  assert.equal(boxed.box_uv, true);
  assert.deepEqual(boxed.uv_offset, [8, 0]);
  assert.equal(boxed.autouv, 0, 'a UV offset disables auto-UV at creation');
  assert.equal(restated.autouv, 1, 'a bare UV mode choice keeps auto-UV enabled');
});

test('create_cubes rejects a box_uv the format cannot represent before creating anything', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  injectCreateCubesProject({ id: 'skin', box_uv: true, optional_box_uv: false });
  (injectedGlobals.Project as Record<string, unknown>).box_uv = true;

  const outcome = await harness.bridge.request('create_cubes', {
    cubes: [{ name: 'per_face_wanted', from: [0, 0, 0], to: [1, 1, 1], box_uv: false }],
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_FORMAT_UNSUPPORTED');
  assert.equal(FakeConstructedCube.constructed.length, 0, 'no cube may be created');
});

test('create_cubes rejects uv_offset on a cube that would be created in per-face UV mode', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  injectCreateCubesProject({ id: 'java_block', box_uv: false, optional_box_uv: true });

  const outcome = await harness.bridge.request('create_cubes', {
    cubes: [{ name: 'inert_offset', from: [0, 0, 0], to: [1, 1, 1], uv_offset: [8, 0] }],
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_INVALID_PARAMS');
  assert.equal(FakeConstructedCube.constructed.length, 0);
});

test('set_cube_uv rejects a non-zero face rotation when the format has no per-face rotation', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const { undo } = injectUvProject({ boxUv: false, uvRotation: false });

  const rotated = await harness.bridge.request('set_cube_uv', {
    uuid: 'c-uv',
    faces: { north: { uv: [0, 0, 4, 4], rotation: 90 } },
  });
  assert.equal(rotated.ok, false);
  assert.equal(rotated.error?.code, 'E_FORMAT_UNSUPPORTED');
  assert.equal(undo.initCalls.length, 0);

  const unrotated = await harness.bridge.request('set_cube_uv', {
    uuid: 'c-uv',
    faces: { north: { uv: [0, 0, 4, 4], rotation: 0 } },
  });
  assert.equal(unrotated.ok, true, 'an explicit zero rotation is the default and stays allowed');
});

test('set_cube_uv refreshes the UV panel only when it shows the edited cube', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const { cube } = injectUvProject({ boxUv: false });
  let panelLoads = 0;
  injectedGlobals.UVEditor = { loadData: () => (panelLoads += 1) };

  await harness.bridge.request('set_cube_uv', { uuid: 'c-uv', faces: { north: { uv: [0, 0, 4, 4] } } });
  assert.equal(panelLoads, 0, 'an unselected cube must not reload the panel');

  FakeCube.selected = [cube];
  await harness.bridge.request('set_cube_uv', { uuid: 'c-uv', faces: { north: { uv: [0, 0, 8, 8] } } });
  assert.equal(panelLoads, 1, 'a selected cube reloads the panel');
});

test('set_texture_resolution rejects a rescale from a non-positive current resolution', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const util = injectResolutionProject([0, 0]);

  const outcome = await harness.bridge.request('set_texture_resolution', {
    width: 64,
    height: 64,
    rescale_existing_uv: true,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_INVALID_PARAMS');
  assert.deepEqual(util.calls, [], 'a zero-size project must never reach the native rescale');
});

// ---------------------------------------------------------------------------
// capture_screenshot angle presets: offscreen rendering and serialization.
// ---------------------------------------------------------------------------

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

/** Inject the screenshot surface: a visible selected preview, the offscreen
 * NoAAPreview singleton, native preset ids, and a screenshotPreview stub whose
 * callback timing is controllable for the serialization test. */
function injectScreenshotProject(options: { captureDelayMs?: number; failFirstCapture?: boolean } = {}): {
  visible: FakePreview;
  offscreen: FakePreview;
  captures: Array<{ preview: string; options: Record<string, unknown> }>;
  events: string[];
} {
  const visible = makeFakePreview('visible');
  const offscreen = makeFakePreview('offscreen');
  const captures: Array<{ preview: string; options: Record<string, unknown> }> = [];
  const events: string[] = [];
  let sequence = 0;
  let failNext = options.failFirstCapture === true;
  injectedGlobals.Project = { saved: true, name: 'ghost' };
  injectedGlobals.Format = { id: 'java_block' };
  injectedGlobals.Preview = { selected: visible };
  injectedGlobals.DefaultCameraPresets = [
    { id: 'initial', projection: 'perspective', position: [-40, 32, -40] },
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
        cb(`data:image/png;base64,capture-${id}`);
      };
      if (options.captureDelayMs !== undefined) {
        setTimeout(finish, options.captureDelayMs);
      } else {
        finish();
      }
    },
  };
  return { visible, offscreen, captures, events };
}

test('capture_screenshot with a preset renders through the offscreen preview and echoes the preset', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const { visible, offscreen, captures } = injectScreenshotProject();

  const outcome = await harness.bridge.request('capture_screenshot', { angle_preset: 'top', width: 320, height: 240 });
  assert.equal(outcome.ok, true, JSON.stringify(outcome.error));
  const result = outcome.result as { data_url: string; width: number; height: number; angle_preset?: string };
  assert.equal(result.angle_preset, 'top', 'the applied preset is echoed');
  assert.equal(result.width, 320);
  assert.equal(result.height, 240);
  assert.equal(captures.length, 1);
  assert.equal(captures[0].preview, 'offscreen', 'the preset render must target the offscreen preview');
  assert.deepEqual(
    captures[0].options,
    { width: 320, height: 240, crop: false },
    'the capture options pass through unchanged',
  );
  assert.equal(offscreen.presetsLoaded.length, 1);
  assert.equal((offscreen.presetsLoaded[0] as { id?: string }).id, 'top');
  assert.deepEqual(offscreen.resizes, [[320, 240]]);
  assert.equal(visible.presetsLoaded.length, 0, 'the visible viewport camera is never touched');
  assert.equal(visible.resizes.length, 0);
});

test('capture_screenshot resets the residual orthographic zoom that locked-angle presets skip', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const { offscreen } = injectScreenshotProject();
  offscreen.isOrtho = true;
  offscreen.camera.zoom = 4; // residual zoom from an earlier render

  const outcome = await harness.bridge.request('capture_screenshot', { angle_preset: 'top' });
  assert.equal(outcome.ok, true, JSON.stringify(outcome.error));
  assert.equal(offscreen.camera.zoom, 0.5, 'the preset zoom replaces the residual zoom');
  assert.ok(offscreen.camera.projectionUpdates >= 1, 'the projection matrix refreshes after the zoom reset');
});

test('capture_screenshot fails cleanly for a preset missing from the runtime preset list', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  injectScreenshotProject(); // the fake preset list carries no west entry

  const outcome = await harness.bridge.request('capture_screenshot', { angle_preset: 'west' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_BLOCKBENCH_ERROR');
});

test('capture_screenshot with a preset is rejected while a Blockbench recording is running', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const { captures } = injectScreenshotProject();
  injectedGlobals.document = {
    getElementById: (id: string) => (id === 'gif_recording_frame' ? {} : null),
  };

  const outcome = await harness.bridge.request('capture_screenshot', { angle_preset: 'top' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_BLOCKBENCH_ERROR');
  assert.match(outcome.error?.message ?? '', /recording/);
  assert.equal(captures.length, 0, 'no render may start during a recording');

  const plain = await harness.bridge.request('capture_screenshot', {});
  assert.equal(plain.ok, true, 'the no-preset path does not depend on the recorder state');
});

test('a failed capture does not wedge the screenshot queue', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  injectScreenshotProject({ failFirstCapture: true });

  const failed = await harness.bridge.request('capture_screenshot', { angle_preset: 'top' });
  assert.equal(failed.ok, false);
  assert.equal(failed.error?.code, 'E_BLOCKBENCH_ERROR');

  const next = await harness.bridge.request('capture_screenshot', { angle_preset: 'south' });
  assert.equal(next.ok, true, 'the queue must keep serving after a failed capture');
});

test('capture_screenshot without a preset shoots the selected preview exactly as before', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const { visible, offscreen, captures } = injectScreenshotProject();

  const outcome = await harness.bridge.request('capture_screenshot', { width: 64 });
  assert.equal(outcome.ok, true, JSON.stringify(outcome.error));
  const result = outcome.result as Record<string, unknown>;
  assert.equal(captures[0].preview, 'visible');
  assert.deepEqual(
    captures[0].options,
    { width: 64, height: 512, crop: false },
    'width/height defaults and the crop flag pass through as before',
  );
  assert.equal('angle_preset' in result, false, 'the no-preset result shape is unchanged');
  assert.equal(visible.presetsLoaded.length, 0);
  assert.equal(offscreen.presetsLoaded.length, 0);
  assert.equal(visible.resizes.length, 0, 'the no-preset path never resizes any preview');
  assert.equal(offscreen.resizes.length, 0);
});

test('concurrent capture_screenshot calls are serialized on the shared offscreen preview', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  const { events } = injectScreenshotProject({ captureDelayMs: 40 });

  const [first, second] = await Promise.all([
    harness.bridge.request('capture_screenshot', { angle_preset: 'top' }),
    harness.bridge.request('capture_screenshot', { angle_preset: 'south' }),
  ]);
  assert.equal(first.ok, true, JSON.stringify(first.error));
  assert.equal(second.ok, true, JSON.stringify(second.error));
  assert.deepEqual(
    events,
    ['start:1', 'end:1', 'start:2', 'end:2'],
    'the second capture must not start until the first finished',
  );
});

test('capture_screenshot with a preset and no open project fails with E_NOT_FOUND', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  injectScreenshotProject();
  injectedGlobals.Project = null;

  const outcome = await harness.bridge.request('capture_screenshot', { angle_preset: 'top' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_NOT_FOUND');
});

test('PROBE: capture_screenshot succeeds after a previous failed capture', async (t) => {
  const harness = await makeHarness();
  t.after(harness.cleanup);
  injectScreenshotProject();
  injectedGlobals.Project = null;
  const failed = await harness.bridge.request('capture_screenshot', { angle_preset: 'top' });
  assert.equal(failed.ok, false);
  injectedGlobals.Project = { saved: true, name: 'ghost' };
  const outcome = await harness.bridge.request('capture_screenshot', { angle_preset: 'top' });
  assert.equal(outcome.ok, true, JSON.stringify(outcome.error));
});
