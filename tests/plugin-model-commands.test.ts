// Model command handler tests through the real dispatcher (bridge → session),
// with Blockbench globals injected on globalThis. node --test runs each file
// in its own process, so the global assignments stay file-local. Handlers that
// need the full Blockbench runtime (newProject, codecs, canvas) are covered by
// manual smoke testing against a live Blockbench; these tests prove the
// read-back mapping, the uuid filtering, and the guard behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';

import WsClient from 'ws';

import { WsBridge } from '../src/adapter/ws-bridge.js';
import { PluginSession, type WebSocketLike } from '../src/plugin/session.js';
import { ScopeManager, type ScopedFsLike } from '../src/plugin/scope-manager.js';
import { registerModelCommands } from '../src/plugin/commands/model-commands.js';
import { COMMAND_SPECS } from '../src/shared/protocol.js';

const SECRET = 'model-cmd-secret-17';
let nextPort = 40900;

const nodeFsAdapter: ScopedFsLike = {
  readFileSync: (path, options) => nodeFs.readFileSync(path as string, options as never),
  writeFileSync: (path, content, options) => nodeFs.writeFileSync(path as string, content as never, options as never),
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
  cleanup: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const port = nextPort++;

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
  registerModelCommands(session, scope);
  session.start();

  try {
    const start = Date.now();
    while (!(session.status === 'connected' && bridge.connected)) {
      if (Date.now() - start > 3_000) throw new Error('harness did not connect');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } catch (error) {
    // Tear down on connect failure: the leaked server and reconnect timers
    // would otherwise keep the test process alive after the failure.
    session.stop();
    await bridge.stop();
    throw error;
  }

  return {
    bridge,
    session,
    cleanup: async () => {
      session.stop();
      await bridge.stop();
      clearBlockbenchGlobals();
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
