// Fixture-driven tests for the shared GeckoLib validation rules. The base
// fixtures are valid exports; each case clones and corrupts them the way a
// real GeckoLib runtime would reject (or silently mishandle) the file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  validateGeoJson,
  validateAnimationBoneRefs,
  validateAnimationJson,
  validateGeckolibProject,
  geometryBoneNames,
  GECKOLIB_EASING_NAMES,
  GECKOLIB_VALIDATION_PROFILE,
  TESTED_GECKOLIB_PLUGIN_VERSION,
} from '../src/shared/geckolib-validate.js';
import { GECKOLIB_VALIDATION_PROFILE as WIRE_PROFILE } from '../src/shared/protocol.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'geckolib');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf8'));
}

function geoFixture(): Record<string, unknown> {
  return loadFixture('valid.geo.json') as Record<string, unknown>;
}

function animationFixture(): Record<string, unknown> {
  return loadFixture('valid.animation.json') as Record<string, unknown>;
}

function bones(geo: Record<string, unknown>): Array<Record<string, unknown>> {
  const geometry = (geo['minecraft:geometry'] as Array<Record<string, unknown>>)[0];
  return geometry.bones as Array<Record<string, unknown>>;
}

function checkIds(diagnostics: Array<{ check_id: string }>): string[] {
  return diagnostics.map((diagnostic) => diagnostic.check_id);
}

test('a valid GL4 geometry export produces no diagnostics', () => {
  assert.deepEqual(validateGeoJson(geoFixture()), []);
});

test('the validator and the wire schema agree on the gl4 profile literal', () => {
  assert.equal(GECKOLIB_VALIDATION_PROFILE, 'gl4');
  assert.equal(GECKOLIB_VALIDATION_PROFILE, WIRE_PROFILE);
});

test('GL5-only format versions are errors with a portability note', () => {
  for (const version of ['1.14.0', '1.21.0']) {
    const geo = geoFixture();
    geo.format_version = version;
    const diagnostics = validateGeoJson(geo);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].severity, 'error');
    assert.equal(diagnostics[0].check_id, 'geckolib_format_version');
    assert.match(diagnostics[0].message, /GeckoLib 5 accepts/, 'the GL5 portability note must be present');
  }
});

test('unknown, missing, or non-string format versions are errors', () => {
  const unknownVersion = geoFixture();
  unknownVersion.format_version = '1.8.0';
  assert.deepEqual(checkIds(validateGeoJson(unknownVersion)), ['geckolib_format_version']);

  const missingVersion = geoFixture();
  delete missingVersion.format_version;
  assert.deepEqual(checkIds(validateGeoJson(missingVersion)), ['geckolib_geometry_envelope']);

  const numericVersion = geoFixture();
  numericVersion.format_version = 1.12;
  assert.deepEqual(checkIds(validateGeoJson(numericVersion)), ['geckolib_geometry_envelope']);
});

test('duplicate bone names are errors, including case-insensitive duplicates', () => {
  const geo = geoFixture();
  bones(geo).push({ name: 'Body', pivot: [0, 0, 0] });
  const diagnostics = validateGeoJson(geo);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].severity, 'error');
  assert.equal(diagnostics[0].check_id, 'geckolib_duplicate_bone_names');
  assert.equal(diagnostics[0].target, 'Body');
});

test('a bone parent that does not exist is an error', () => {
  const geo = geoFixture();
  bones(geo)[1].parent = 'torso';
  const diagnostics = validateGeoJson(geo);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].check_id, 'geckolib_missing_bone_parent');
  assert.equal(diagnostics[0].target, 'head');
});

test('a bone that is its own parent is an error', () => {
  const geo = geoFixture();
  bones(geo)[0].parent = 'body';
  const diagnostics = validateGeoJson(geo);
  assert.deepEqual(checkIds(diagnostics), ['geckolib_missing_bone_parent']);
});

test('broken geometry envelopes are errors', () => {
  assert.deepEqual(checkIds(validateGeoJson('not an object')), ['geckolib_geometry_envelope']);
  assert.deepEqual(checkIds(validateGeoJson(['array'])), ['geckolib_geometry_envelope']);

  const noGeometry = geoFixture();
  delete noGeometry['minecraft:geometry'];
  assert.deepEqual(checkIds(validateGeoJson(noGeometry)), ['geckolib_geometry_envelope']);

  const emptyGeometry = geoFixture();
  emptyGeometry['minecraft:geometry'] = [];
  assert.deepEqual(checkIds(validateGeoJson(emptyGeometry)), ['geckolib_geometry_envelope']);

  const nonObjectGeometry = geoFixture();
  nonObjectGeometry['minecraft:geometry'] = ['not an object'];
  const nonObjectDiagnostics = validateGeoJson(nonObjectGeometry);
  assert.ok(nonObjectDiagnostics.some((d) => d.check_id === 'geckolib_geometry_envelope' && d.severity === 'error'));

  const missingBones = geoFixture();
  delete (missingBones['minecraft:geometry'] as Array<Record<string, unknown>>)[0].bones;
  const missingDiagnostics = validateGeoJson(missingBones);
  assert.equal(missingDiagnostics.length, 1);
  assert.equal(missingDiagnostics[0].severity, 'error');
  assert.equal(missingDiagnostics[0].check_id, 'geckolib_geometry_envelope');

  const nonArrayBones = geoFixture();
  (nonArrayBones['minecraft:geometry'] as Array<Record<string, unknown>>)[0].bones = { body: {} };
  const nonArrayDiagnostics = validateGeoJson(nonArrayBones);
  assert.equal(nonArrayDiagnostics.length, 1);
  assert.equal(nonArrayDiagnostics[0].severity, 'error');
});

test('bone entries that are not objects or have no usable name are errors', () => {
  const geo = geoFixture();
  bones(geo).push('not a bone' as unknown as Record<string, unknown>);
  const nonObject = validateGeoJson(geo);
  assert.ok(nonObject.some((d) => d.severity === 'error' && d.check_id === 'geckolib_geometry_envelope'));

  const unnamed = geoFixture();
  bones(unnamed).push({ pivot: [0, 0, 0] });
  assert.ok(validateGeoJson(unnamed).some((d) => d.severity === 'error' && d.message.includes('no string name')));

  const emptyName = geoFixture();
  bones(emptyName).push({ name: '' });
  assert.ok(validateGeoJson(emptyName).some((d) => d.severity === 'error' && d.message.includes('empty name')));

  const badParent = geoFixture();
  bones(badParent)[1].parent = 7;
  assert.ok(validateGeoJson(badParent).some((d) => d.severity === 'error' && d.message.includes('non-string parent')));
});

test('extra geometry entries and empty bone lists are warnings', () => {
  const twoGeometries = geoFixture();
  const list = twoGeometries['minecraft:geometry'] as unknown[];
  list.push(JSON.parse(JSON.stringify(list[0])));
  const extraEntry = validateGeoJson(twoGeometries);
  assert.equal(extraEntry.length, 1);
  assert.equal(extraEntry[0].severity, 'warning');
  assert.equal(extraEntry[0].check_id, 'geckolib_geometry_envelope');

  const noBones = geoFixture();
  (noBones['minecraft:geometry'] as Array<Record<string, unknown>>)[0].bones = [];
  const empty = validateGeoJson(noBones);
  assert.equal(empty.length, 1);
  assert.equal(empty[0].severity, 'warning');
});

test('non-positive declared texture dimensions are errors', () => {
  const geo = geoFixture();
  const description = (geo['minecraft:geometry'] as Array<Record<string, unknown>>)[0].description as Record<
    string,
    unknown
  >;
  description.texture_width = 0;
  description.texture_height = 16.5;
  const diagnostics = validateGeoJson(geo);
  assert.deepEqual(checkIds(diagnostics), ['geckolib_texture_size', 'geckolib_texture_size']);
});

test('a valid animation cross-check against its geometry is clean', () => {
  assert.deepEqual(validateAnimationBoneRefs(animationFixture(), geoFixture()), []);
});

test('animation references to bones missing from the geometry are warnings naming the crash flag', () => {
  const animation = animationFixture();
  const idle = (animation.animations as Record<string, Record<string, unknown>>)['animation.ghost.idle'];
  (idle.bones as Record<string, unknown>).tail = { rotation: { '0.0': [0, 0, 0] } };
  const diagnostics = validateAnimationBoneRefs(animation, geoFixture());
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].severity, 'warning');
  assert.equal(diagnostics[0].check_id, 'geckolib_animation_missing_bone');
  assert.equal(diagnostics[0].target, 'animation.ghost.idle/tail');
  assert.match(diagnostics[0].message, /crashWhenCantFindBone/);
});

test('animation files without an animations map are errors', () => {
  assert.deepEqual(checkIds(validateAnimationBoneRefs({}, geoFixture())), ['geckolib_animation_envelope']);
  assert.deepEqual(checkIds(validateAnimationBoneRefs('nope', geoFixture())), ['geckolib_animation_envelope']);
});

test('malformed animation entries and uninspectable geometries degrade explicitly', () => {
  const brokenGeometry = validateAnimationBoneRefs(animationFixture(), 'not a geometry');
  assert.equal(brokenGeometry.length, 1);
  assert.equal(brokenGeometry[0].severity, 'warning');
  assert.equal(brokenGeometry[0].check_id, 'geckolib_animation_envelope');

  const nonObjectAnimation = animationFixture();
  (nonObjectAnimation.animations as Record<string, unknown>)['animation.ghost.broken'] = 'nope';
  assert.ok(
    validateAnimationBoneRefs(nonObjectAnimation, geoFixture()).some(
      (d) => d.severity === 'error' && d.target === 'animation.ghost.broken',
    ),
  );

  const nonObjectBones = animationFixture();
  ((nonObjectBones.animations as Record<string, Record<string, unknown>>)['animation.ghost.idle'] as Record<
    string,
    unknown
  >).bones = 'nope';
  assert.ok(
    validateAnimationBoneRefs(nonObjectBones, geoFixture()).some(
      (d) => d.severity === 'error' && d.check_id === 'geckolib_animation_envelope',
    ),
  );
});

test('geometry bone names are extractable for cross-checks', () => {
  assert.deepEqual(geometryBoneNames(geoFixture()), ['body', 'head']);
  assert.equal(geometryBoneNames({}), null);
});

// --- validateAnimationJson (animation content checks, no geometry needed) ---

function fullFeaturesFixture(): Record<string, unknown> {
  return loadFixture('full-features.animation.json') as Record<string, unknown>;
}

/** Wrap one animation body into a minimal animation file. */
function animationFile(animation: Record<string, unknown>, name = 'animation.ghost.test'): Record<string, unknown> {
  return { animations: { [name]: animation } };
}

/** Wrap one bone-channel keyframe map into a minimal animation file. */
function channelFile(channel: string, value: unknown): Record<string, unknown> {
  return animationFile({ bones: { body: { [channel]: value } } });
}

test('an animation file exercising every supported content feature produces no diagnostics', () => {
  assert.deepEqual(validateAnimationJson(fullFeaturesFixture()), []);
});

test('the full-features animation cross-checks cleanly against the geometry fixture', () => {
  assert.deepEqual(validateAnimationBoneRefs(fullFeaturesFixture(), geoFixture()), []);
});

test('the GeckoLib plugin easing whitelist has exactly the 32 surveyed names', () => {
  const families = ['Quad', 'Cubic', 'Quart', 'Quint', 'Sine', 'Expo', 'Circ', 'Back', 'Elastic', 'Bounce'];
  const expected = [
    'linear',
    'step',
    ...families.flatMap((family) => [`easeIn${family}`, `easeOut${family}`, `easeInOut${family}`]),
  ];
  assert.deepEqual([...GECKOLIB_EASING_NAMES], expected);
});

test('loop values GL4 cannot resolve are warnings naming the silent play-once fallback', () => {
  for (const accepted of [true, false, 'loop', 'true', 'false', 'play_once', 'hold_on_last_frame']) {
    assert.deepEqual(validateAnimationJson(animationFile({ loop: accepted })), [], `loop ${JSON.stringify(accepted)}`);
  }
  for (const rejected of ['forever', 5, null, 'Loop']) {
    const diagnostics = validateAnimationJson(animationFile({ loop: rejected }));
    assert.equal(diagnostics.length, 1, `loop ${JSON.stringify(rejected)} must be flagged`);
    assert.equal(diagnostics[0].severity, 'warning');
    assert.equal(diagnostics[0].check_id, 'geckolib_animation_loop_value');
    assert.equal(diagnostics[0].target, 'animation.ghost.test');
  }
});

test('unknown easing names are warnings; the whitelist is case-insensitive and includes GL4 aliases', () => {
  const withEasing = (easing: unknown): Record<string, unknown> =>
    channelFile('rotation', { '0.0': { post: [0, 0, 0], easing } });
  for (const accepted of ['easeInOutSine', 'EASEINOUTSINE', 'easeinoutsine', 'none', 'catmullrom', 'single_step']) {
    assert.deepEqual(validateAnimationJson(withEasing(accepted)), [], `easing ${JSON.stringify(accepted)}`);
  }
  for (const rejected of ['easeInOutBanana', 'ease-in-sine', 42]) {
    const diagnostics = validateAnimationJson(withEasing(rejected));
    assert.equal(diagnostics.length, 1, `easing ${JSON.stringify(rejected)} must be flagged`);
    assert.equal(diagnostics[0].severity, 'warning');
    assert.equal(diagnostics[0].check_id, 'geckolib_animation_easing_name');
    assert.equal(diagnostics[0].target, 'animation.ghost.test/body/rotation/0.0');
  }
});

test('easingArgs that are not numeric arrays are errors', () => {
  for (const rejected of ['fast', ['a'], 5, [1, 'two']]) {
    const diagnostics = validateAnimationJson(
      channelFile('rotation', { '0.0': { post: [0, 0, 0], easing: 'easeInBack', easingArgs: rejected } }),
    );
    assert.equal(diagnostics.length, 1, `easingArgs ${JSON.stringify(rejected)} must be flagged`);
    assert.equal(diagnostics[0].severity, 'error');
    assert.equal(diagnostics[0].check_id, 'geckolib_animation_easing_args');
    assert.equal(diagnostics[0].target, 'animation.ghost.test/body/rotation/0.0');
  }
  assert.deepEqual(
    validateAnimationJson(channelFile('rotation', { '0.0': { post: [0, 0, 0], easing: 'easeInBack', easingArgs: [1.7] } })),
    [],
  );
});

test('non-numeric, negative, duplicated, and out-of-order keyframe timestamps are errors', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['non-numeric', { start: [0, 0, 0], '1.0': [0, 1, 0] }],
    ['hex-literal', { '0x10': [0, 0, 0], '20.0': [0, 1, 0] }],
    ['negative', { '-0.5': [0, 0, 0] }],
    ['duplicate 0 and 0.0', { '0': [0, 0, 0], '0.0': [0, 1, 0] }],
    ['out of order', { '1.5': [0, 0, 0], '0.5': [0, 1, 0] }],
  ];
  for (const [label, map] of cases) {
    const diagnostics = validateAnimationJson(channelFile('position', map));
    assert.equal(diagnostics.length, 1, `${label} timestamps must be flagged`);
    assert.equal(diagnostics[0].severity, 'error');
    assert.equal(diagnostics[0].check_id, 'geckolib_animation_timestamp');
    assert.equal(diagnostics[0].target, 'animation.ghost.test/body/position');
  }
});

test('ascending timestamps mixing integer and decimal keys are accepted despite JSON key reordering', () => {
  // JSON.parse iterates "0" and "1" ahead of "0.5"; the validator must not
  // mistake that iteration order for a file-order violation.
  const diagnostics = validateAnimationJson(
    channelFile('position', { '0': [0, 0, 0], '0.5': [0, 1, 0], '1': [0, 0, 0] }),
  );
  assert.deepEqual(diagnostics, []);
});

test('keyframe values outside the number/molang/3-entry-vector shapes are errors', () => {
  const badValues: unknown[] = [
    [0, 1],
    [0, 1, 2, 3],
    [true, 0, 0],
    { easing: 'linear' },
    { post: [0, 1] },
    true,
    null,
  ];
  for (const value of badValues) {
    const diagnostics = validateAnimationJson(channelFile('scale', { '0.0': value }));
    assert.equal(diagnostics.length, 1, `value ${JSON.stringify(value)} must be flagged`);
    assert.equal(diagnostics[0].severity, 'error');
    assert.equal(diagnostics[0].check_id, 'geckolib_animation_value_shape');
    assert.equal(diagnostics[0].target, 'animation.ghost.test/body/scale/0.0');
  }
  const bareBad = validateAnimationJson(channelFile('scale', true));
  assert.equal(bareBad.length, 1);
  assert.equal(bareBad[0].check_id, 'geckolib_animation_value_shape');
  assert.equal(bareBad[0].target, 'animation.ghost.test/body/scale');
});

test('an animation_length shorter than the last bone keyframe is a warning', () => {
  for (const declaredLength of [1, '1']) {
    const diagnostics = validateAnimationJson(
      animationFile({
        animation_length: declaredLength,
        bones: { body: { rotation: { '0.0': [0, 0, 0], '2.0': [0, 1, 0] } } },
      }),
    );
    assert.equal(diagnostics.length, 1, `animation_length ${JSON.stringify(declaredLength)} must be compared`);
    assert.equal(diagnostics[0].severity, 'warning');
    assert.equal(diagnostics[0].check_id, 'geckolib_animation_length_mismatch');
    assert.equal(diagnostics[0].target, 'animation.ghost.test');
  }
});

test('empty bones maps and empty keyframe maps produce no diagnostics', () => {
  assert.deepEqual(validateAnimationJson(animationFile({ bones: {} })), []);
  assert.deepEqual(validateAnimationJson(channelFile('rotation', {})), []);
});

test('an empty channel array is an invalid keyframe value', () => {
  const diagnostics = validateAnimationJson(channelFile('rotation', []));
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].severity, 'error');
  assert.equal(diagnostics[0].check_id, 'geckolib_animation_value_shape');
});

test('a real GeckoLib plugin 4.2.5 animation export validates clean', () => {
  // Captured from Animator.buildFile on Blockbench 5.1.4 with the GeckoLib
  // plugin installed; single-keyframe channels export as a channel-level
  // {vector, easing?, easingArgs?} object without timestamp keys.
  const exported = loadFixture('plugin-export.animation.json');
  assert.deepEqual(validateAnimationJson(exported), []);
  assert.deepEqual(validateAnimationBoneRefs(exported, geoFixture()), []);
});

test('single-keyframe channel objects validate their vector and easing metadata', () => {
  assert.deepEqual(
    validateAnimationJson(channelFile('scale', { vector: [1, 1, 1], easing: 'easeInBack', easingArgs: [1.7] })),
    [],
  );
  const badEasing = validateAnimationJson(channelFile('scale', { vector: [1, 1, 1], easing: 'bouncy' }));
  assert.equal(badEasing.length, 1);
  assert.equal(badEasing[0].severity, 'warning');
  assert.equal(badEasing[0].check_id, 'geckolib_animation_easing_name');
  assert.equal(badEasing[0].target, 'animation.ghost.test/body/scale');
  const badVector = validateAnimationJson(channelFile('scale', { vector: [1, 1] }));
  assert.equal(badVector.length, 1);
  assert.equal(badVector[0].severity, 'error');
  assert.equal(badVector[0].check_id, 'geckolib_animation_value_shape');
  assert.equal(badVector[0].target, 'animation.ghost.test/body/scale');
  const mixed = validateAnimationJson(channelFile('scale', { vector: [1, 1, 1], '1.0': [2, 2, 2] }));
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].severity, 'error');
  assert.equal(mixed[0].check_id, 'geckolib_animation_timestamp');
  assert.equal(mixed[0].target, 'animation.ghost.test/body/scale');
});

test('malformed effect keyframes are errors, including two-data-points-per-timestamp arrays', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    [
      'array-valued sound entry',
      { sound_effects: { '0.5': [{ effect: 'a' }, { effect: 'b' }] } },
      'animation.ghost.test/sound_effects/0.5',
    ],
    ['sound entry missing effect', { sound_effects: { '0.5': { locator: 'body' } } }, 'animation.ghost.test/sound_effects/0.5'],
    ['sound entry as bare string', { sound_effects: { '0.5': 'attack_swing' } }, 'animation.ghost.test/sound_effects/0.5'],
    [
      'array-valued particle entry',
      { particle_effects: { '0.5': [{ effect: 'a' }] } },
      'animation.ghost.test/particle_effects/0.5',
    ],
    ['non-string timeline entry', { timeline: { '0.5': 42 } }, 'animation.ghost.test/timeline/0.5'],
    ['non-object effect container', { sound_effects: [] }, 'animation.ghost.test/sound_effects'],
  ];
  for (const [label, animation, target] of cases) {
    const diagnostics = validateAnimationJson(animationFile(animation));
    assert.equal(diagnostics.length, 1, `${label} must be flagged`);
    assert.equal(diagnostics[0].severity, 'error');
    assert.equal(diagnostics[0].check_id, 'geckolib_animation_effect_keyframe');
    assert.equal(diagnostics[0].target, target);
  }
});

test('molang strings are not evaluated; only unbalanced parentheses are warnings', () => {
  for (const balanced of ['math.sin(query.anim_time * 90) * 5', 'query.is_moving ? 1 : 0', '']) {
    assert.deepEqual(
      validateAnimationJson(channelFile('position', { '0.0': balanced })),
      [],
      `molang ${JSON.stringify(balanced)} must pass`,
    );
  }
  for (const unbalanced of ['math.sin(query.anim_time', 'math.cos)query.x(']) {
    const diagnostics = validateAnimationJson(channelFile('position', { '0.0': unbalanced }));
    assert.equal(diagnostics.length, 1, `molang ${JSON.stringify(unbalanced)} must warn`);
    assert.equal(diagnostics[0].severity, 'warning');
    assert.equal(diagnostics[0].check_id, 'geckolib_animation_molang_parentheses');
  }
  const timeUpdate = validateAnimationJson(animationFile({ anim_time_update: 'query.anim_time + (' }));
  assert.equal(timeUpdate.length, 1);
  assert.equal(timeUpdate[0].check_id, 'geckolib_animation_molang_parentheses');
  assert.equal(timeUpdate[0].target, 'animation.ghost.test/anim_time_update');
});

test('broken animation content envelopes are errors', () => {
  const cases: unknown[] = [
    'nope',
    {},
    animationFile('nope' as unknown as Record<string, unknown>),
    animationFile({ bones: 'nope' }),
    animationFile({ bones: { body: 'nope' } }),
  ];
  for (const parsed of cases) {
    const diagnostics = validateAnimationJson(parsed);
    assert.deepEqual(checkIds(diagnostics), ['geckolib_animation_envelope']);
    assert.equal(diagnostics[0].severity, 'error');
  }
});

test('project rules pass for a well-formed entity project', () => {
  assert.deepEqual(
    validateGeckolibProject({
      boneNames: ['body', 'head'],
      modid: 'examplemod',
      identifier: 'ghost',
      modelType: 'Entity',
      textureSize: { width: 32, height: 32 },
      declaredTextureSize: { width: 32, height: 32 },
      detectedPluginVersion: TESTED_GECKOLIB_PLUGIN_VERSION,
    }),
    [],
  );
});

test('project rules flag bone charset violations and duplicates', () => {
  const diagnostics = validateGeckolibProject({
    boneNames: ['body', 'Body', 'left-arm'],
    modid: 'examplemod',
    identifier: 'ghost',
  });
  const ids = checkIds(diagnostics);
  assert.ok(ids.includes('geckolib_bone_name_charset'));
  assert.ok(ids.includes('geckolib_duplicate_bone_names'));
});

test('project rules require a valid modid and identifier', () => {
  const missing = validateGeckolibProject({ boneNames: ['body'] });
  assert.deepEqual(checkIds(missing), ['geckolib_modid', 'geckolib_identifier']);
  for (const diagnostic of missing) assert.equal(diagnostic.severity, 'error');

  const invalid = validateGeckolibProject({ boneNames: ['body'], modid: 'MyMod', identifier: 'Ghost Knight' });
  assert.deepEqual(checkIds(invalid), ['geckolib_modid', 'geckolib_identifier']);
});

test('armor projects warn for every missing template bone and pass with the full rig', () => {
  const fullRig = [
    'bipedHead',
    'bipedBody',
    'bipedRightArm',
    'bipedLeftArm',
    'bipedRightLeg',
    'bipedLeftLeg',
    'armorHead',
    'armorBody',
    'armorRightArm',
    'armorLeftArm',
    'armorRightLeg',
    'armorLeftLeg',
    'armorRightBoot',
    'armorLeftBoot',
  ];
  assert.deepEqual(
    validateGeckolibProject({ boneNames: fullRig, modid: 'examplemod', identifier: 'knight_armor', modelType: 'Armor' }),
    [],
  );

  const missingBoots = validateGeckolibProject({
    boneNames: fullRig.filter((name) => !name.endsWith('Boot')),
    modid: 'examplemod',
    identifier: 'knight_armor',
    modelType: 'Armor',
  });
  assert.equal(missingBoots.length, 2);
  for (const diagnostic of missingBoots) {
    assert.equal(diagnostic.severity, 'warning');
    assert.equal(diagnostic.check_id, 'geckolib_armor_template');
  }
  assert.deepEqual(
    missingBoots.map((diagnostic) => diagnostic.target),
    ['armorRightBoot', 'armorLeftBoot'],
  );
});

test('texture size mismatches against the declared UV base are warnings', () => {
  const diagnostics = validateGeckolibProject({
    boneNames: ['body'],
    modid: 'examplemod',
    identifier: 'ghost',
    textureSize: { width: 64, height: 64 },
    declaredTextureSize: { width: 32, height: 32 },
  });
  assert.deepEqual(checkIds(diagnostics), ['geckolib_texture_size_mismatch']);
  assert.equal(diagnostics[0].severity, 'warning');
});

test('an untested GeckoLib plugin version produces a soft-pin warning', () => {
  const diagnostics = validateGeckolibProject({
    boneNames: ['body'],
    modid: 'examplemod',
    identifier: 'ghost',
    detectedPluginVersion: '4.3.0',
  });
  assert.deepEqual(checkIds(diagnostics), ['geckolib_plugin_version_untested']);
  assert.equal(diagnostics[0].severity, 'warning');
  assert.match(diagnostics[0].message, /4\.2\.5/);
});
