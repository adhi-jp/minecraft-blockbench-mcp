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
  validateGeckolibProject,
  geometryBoneNames,
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
