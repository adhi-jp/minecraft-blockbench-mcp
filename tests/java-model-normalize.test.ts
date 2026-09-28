// Java model normalization and parent-chain inlining, exercised as pure
// functions with an in-memory model file reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assetsRootOf,
  normalizeJavaModel,
  parentModelPath,
  resolveJavaModelParents,
  type JavaModel,
} from '../src/plugin/java-model-normalize.js';

/** Reader over an in-memory file map; records every path it was asked for. */
function memoryReader(files: Record<string, unknown>): { read: (path: string) => string | null; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    read: (path) => {
      asked.push(path);
      const content = files[path];
      if (content === undefined) return null;
      return typeof content === 'string' ? content : JSON.stringify(content);
    },
  };
}

const ROOT = '/scope/assets';
const MODEL_PATH = `${ROOT}/mymod/models/block/lamp.json`;

test('a sprite-object texture becomes its sprite string and is reported', () => {
  const { model, warnings } = normalizeJavaModel({
    elements: [{ from: [0, 0, 0], to: [16, 16, 16] }],
    textures: { all: { sprite: 'mymod:block/lamp', force_translucent: true }, side: '#all' },
  });
  assert.deepEqual(model.textures, { all: 'mymod:block/lamp', side: 'mymod:block/lamp' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"all".*sprite object/);
});

test('texture aliases resolve through every hop, including particle', () => {
  const input: JavaModel = {
    elements: [],
    textures: { particle: '#side', side: '#base', base: '#all', all: 'block/stone' },
  };
  const { model, warnings } = normalizeJavaModel(input);
  assert.deepEqual(model.textures, {
    particle: 'block/stone',
    side: 'block/stone',
    base: 'block/stone',
    all: 'block/stone',
  });
  assert.deepEqual(warnings, []);
  assert.equal((input.textures as Record<string, string>).side, '#base', 'the input model is not modified');
});

test('an alias cycle and a missing alias target stay as written and are reported by variable', () => {
  const { model, warnings } = normalizeJavaModel({
    elements: [],
    textures: { a: '#b', b: '#a', c: '#nowhere', d: 'block/dirt' },
  });
  assert.deepEqual(model.textures, { a: '#b', b: '#a', c: '#nowhere', d: 'block/dirt' });
  assert.equal(warnings.length, 3);
  assert.ok(warnings.some((warning) => /"a".*cycle/.test(warning)));
  assert.ok(warnings.some((warning) => /"b".*cycle/.test(warning)));
  assert.ok(warnings.some((warning) => /"c".*"#nowhere".*not defined/.test(warning)));
});

test('an element-less model with a parent gets empty elements, keeps the parent, and names resolve_parents', () => {
  for (const input of [
    { parent: 'block/x' },
    { parent: 'block/x', textures: { all: 'block/stone' } },
    { parent: 'minecraft:builtin/entity' },
    { parent: 'item/generated' },
    { parent: 'item/generated', textures: { layer1: 'item/overlay' } },
  ] as JavaModel[]) {
    const { model, warnings } = normalizeJavaModel(input);
    assert.deepEqual(model.elements, [], JSON.stringify(input));
    assert.equal(model.parent, input.parent);
    assert.equal(warnings.length, 1, JSON.stringify(input));
  }
  const hint = normalizeJavaModel({ parent: 'block/x' }).warnings[0];
  assert.match(hint, /"block\/x"/);
  assert.match(hint, /resolve_parents/);
  assert.deepEqual(
    normalizeJavaModel({ parent: 'block/x' }, { parentsResolved: true }).warnings,
    [],
    'after a parent walk the walk itself reports the unresolved parent',
  );
});

test('a flat item sprite model and a model with its own elements pass through unchanged', () => {
  const sprite = { parent: 'minecraft:item/handheld', textures: { layer0: 'item/stick' } };
  assert.deepEqual(normalizeJavaModel(sprite), { model: sprite, warnings: [] });
  const aliasedSprite = normalizeJavaModel({ parent: 'item/generated', textures: { layer0: '#base', base: 'item/a' } });
  assert.equal(aliasedSprite.model.elements, undefined, 'an aliased layer0 resolves and still takes the sprite path');
  const block = { parent: 'block/block', elements: [{ from: [0, 0, 0], to: [1, 1, 1] }] };
  assert.deepEqual(normalizeJavaModel(block), { model: block, warnings: [] });
});

test('assets roots and parent ids map onto namespace model paths', () => {
  assert.equal(assetsRootOf(MODEL_PATH), ROOT);
  assert.equal(assetsRootOf('C:\\pack\\assets\\ns\\models\\item\\a.json'), 'C:/pack/assets');
  assert.equal(assetsRootOf('/scope/loose/model.json'), null);
  assert.equal(parentModelPath(ROOT, 'block/cube_all'), `${ROOT}/minecraft/models/block/cube_all.json`);
  assert.equal(parentModelPath(`${ROOT}/`, 'mymod:block/template'), `${ROOT}/mymod/models/block/template.json`);
});

test('a child -> template -> cube_all chain inlines elements, merges textures child-first, and drops the parent', () => {
  const files = {
    [`${ROOT}/mymod/models/block/template.json`]: {
      parent: 'block/cube_all',
      textures: { all: 'mymod:block/template', particle: '#all' },
      display: { gui: { rotation: [30, 45, 0] }, head: { scale: [1, 1, 1] } },
    },
    [`${ROOT}/minecraft/models/block/cube_all.json`]: {
      parent: 'block/cube',
      textures: { up: '#all', down: '#all' },
    },
    [`${ROOT}/minecraft/models/block/cube.json`]: {
      gui_light: 'side',
      elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { up: { texture: '#up' } } }],
      display: { gui: { rotation: [0, 0, 0] }, ground: { scale: [0.25, 0.25, 0.25] } },
    },
  };
  const { read } = memoryReader(files);
  const child: JavaModel = {
    parent: 'mymod:block/template',
    textures: { all: 'mymod:block/lamp' },
    display: { head: { scale: [2, 2, 2] } },
    ambientocclusion: false,
  };
  const resolved = resolveJavaModelParents(child, { modelPath: MODEL_PATH, assetRoots: [ROOT], read });
  assert.deepEqual(resolved.warnings, []);
  assert.equal('parent' in resolved.model, false, 'a chain ending at a model without parent leaves no parent');
  assert.deepEqual(resolved.model.elements, files[`${ROOT}/minecraft/models/block/cube.json`].elements);
  assert.deepEqual(resolved.model.display, {
    gui: { rotation: [30, 45, 0] },
    head: { scale: [2, 2, 2] },
    ground: { scale: [0.25, 0.25, 0.25] },
  });
  assert.equal(resolved.model.ambientocclusion, false);
  assert.equal(resolved.model.gui_light, undefined, 'gui_light stays the child own');

  const { model } = normalizeJavaModel(resolved.model, { parentsResolved: true });
  assert.deepEqual(model.textures, {
    all: 'mymod:block/lamp',
    particle: 'mymod:block/lamp',
    up: 'mymod:block/lamp',
    down: 'mymod:block/lamp',
  });
});

test('the nearest ancestor with elements supplies them and the child own non-empty elements win', () => {
  const files = {
    [`${ROOT}/minecraft/models/block/a.json`]: { parent: 'block/b', elements: [{ name: 'a' }] },
    [`${ROOT}/minecraft/models/block/b.json`]: { elements: [{ name: 'b' }] },
  };
  const { read } = memoryReader(files);
  const inherited = resolveJavaModelParents({ parent: 'block/a', elements: [] }, {
    modelPath: MODEL_PATH,
    assetRoots: [ROOT],
    read,
  });
  assert.deepEqual(inherited.model.elements, [{ name: 'a' }]);
  const own = resolveJavaModelParents({ parent: 'block/a', elements: [{ name: 'own' }] }, {
    modelPath: MODEL_PATH,
    assetRoots: [ROOT],
    read,
  });
  assert.deepEqual(own.model.elements, [{ name: 'own' }]);
});

test('the walk stops at builtin and flat item parents and keeps them as the parent', () => {
  const files = {
    [`${ROOT}/minecraft/models/item/chest.json`]: { parent: 'builtin/entity', textures: { particle: 'block/oak' } },
    [`${ROOT}/mymod/models/item/tool.json`]: { parent: 'minecraft:item/handheld', textures: { layer0: 'item/x' } },
  };
  const { read, asked } = memoryReader(files);
  const chest = resolveJavaModelParents({ parent: 'item/chest' }, { modelPath: MODEL_PATH, assetRoots: [ROOT], read });
  assert.equal(chest.model.parent, 'builtin/entity');
  assert.deepEqual(chest.warnings, []);
  const tool = resolveJavaModelParents(
    { parent: 'mymod:item/tool', textures: { layer0: 'mymod:item/wrench' } },
    { modelPath: MODEL_PATH, assetRoots: [ROOT], read },
  );
  assert.equal(tool.model.parent, 'minecraft:item/handheld');
  assert.deepEqual(tool.model.textures, { layer0: 'mymod:item/wrench' });
  assert.equal(normalizeJavaModel(tool.model).model.elements, undefined, 'the merged sprite model still takes the flat path');
  assert.ok(asked.every((path) => !path.includes('builtin') && !path.includes('handheld')), 'stop ids are never read');
});

test('asset roots are searched in order and the first root holding the parent wins', () => {
  const files = {
    ['/scope/vanilla/assets/minecraft/models/block/x.json']: { elements: [{ name: 'vanilla' }] },
    ['/scope/other/assets/minecraft/models/block/x.json']: { elements: [{ name: 'other' }] },
  };
  const { read, asked } = memoryReader(files);
  const { model } = resolveJavaModelParents({ parent: 'block/x' }, {
    modelPath: MODEL_PATH,
    assetRoots: [ROOT, '/scope/vanilla/assets', '/scope/other/assets'],
    read,
  });
  assert.deepEqual(model.elements, [{ name: 'vanilla' }]);
  assert.deepEqual(asked, [
    `${ROOT}/minecraft/models/block/x.json`,
    '/scope/vanilla/assets/minecraft/models/block/x.json',
  ]);
});

test('a missing parent and a parent cycle produce warnings and keep what was resolved', () => {
  const { read } = memoryReader({
    [`${ROOT}/mymod/models/block/mid.json`]: { parent: 'mymod:block/gone', textures: { side: 'mymod:block/mid' } },
    [`${ROOT}/mymod/models/block/loop_a.json`]: { parent: 'mymod:block/loop_b', textures: { a: 'x' } },
    [`${ROOT}/mymod/models/block/loop_b.json`]: { parent: 'mymod:block/loop_a' },
  });
  const missing = resolveJavaModelParents({ parent: 'mymod:block/mid' }, {
    modelPath: MODEL_PATH,
    assetRoots: [ROOT],
    read,
  });
  assert.equal(missing.model.parent, 'mymod:block/gone');
  assert.deepEqual(missing.model.textures, { side: 'mymod:block/mid' });
  assert.equal(missing.warnings.length, 1);
  assert.match(missing.warnings[0], /"mymod:block\/gone".*resolve_parents/);

  const cycle = resolveJavaModelParents({ parent: 'mymod:block/loop_a' }, {
    modelPath: MODEL_PATH,
    assetRoots: [ROOT],
    read,
  });
  assert.equal(cycle.model.parent, 'mymod:block/loop_a');
  assert.deepEqual(cycle.model.textures, { a: 'x' });
  assert.equal(cycle.warnings.length, 1);
  assert.match(cycle.warnings[0], /"mymod:block\/loop_a".*cycle/);

  const selfCycle = resolveJavaModelParents({ parent: 'mymod:block/lamp' }, {
    modelPath: MODEL_PATH,
    assetRoots: [ROOT],
    read: memoryReader({ [MODEL_PATH]: { parent: 'mymod:block/lamp' } }).read,
  });
  assert.match(selfCycle.warnings[0], /cycle/, 'a parent that points back at the opened file is a cycle');
});

test('a parent file that is not a JSON model stops the walk with a warning', () => {
  const { read } = memoryReader({ [`${ROOT}/minecraft/models/block/broken.json`]: '{ not json' });
  const { model, warnings } = resolveJavaModelParents({ parent: 'block/broken' }, {
    modelPath: MODEL_PATH,
    assetRoots: [ROOT],
    read,
  });
  assert.equal(model.parent, 'block/broken');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"block\/broken".*not a JSON model/);
});
