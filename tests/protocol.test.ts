import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROTOCOL_VERSION,
  DEFAULT_WS_PORT,
  ERROR_CODES,
  COMMAND_SPECS,
  COMMAND_NAMES,
  FORMAT_NEUTRAL_COMMAND_SPECS,
  JAVA_FORMAT_COMMAND_SPECS,
  GECKOLIB_FORMAT_COMMAND_SPECS,
  isCommandName,
  helloMessageSchema,
  pluginToAdapterMessageSchema,
  adapterToPluginMessageSchema,
  responseMessageSchema,
  makeError,
} from '../src/shared/protocol.js';

test('protocol version constant is a positive integer', () => {
  assert.equal(Number.isInteger(PROTOCOL_VERSION), true);
  assert.ok(PROTOCOL_VERSION >= 1);
});

test('protocol version is 3 after the GeckoLib animation authoring extension', () => {
  assert.equal(PROTOCOL_VERSION, 3);
});

test('default WebSocket port matches the specified loopback port 39731', () => {
  assert.equal(DEFAULT_WS_PORT, 39731);
});

test('error code table is stable and free of duplicates', () => {
  const expected = [
    'E_PLUGIN_NOT_CONNECTED',
    'E_SECRET_MISSING',
    'E_AUTH_FAILED',
    'E_SESSION_EXISTS',
    'E_PORT_IN_USE',
    'E_PROTOCOL_MISMATCH',
    'E_TIMEOUT',
    'E_INVALID_PARAMS',
    'E_UNSUPPORTED_COMMAND',
    'E_SCOPE_NOT_CONFIRMED',
    'E_SCOPE_EXPIRED',
    'E_SCOPE_REVOKED',
    'E_PATH_OUTSIDE_SCOPE',
    'E_FILE_EXISTS',
    'E_PREFLIGHT_FAILED',
    'E_NOT_FOUND',
    'E_FORMAT_UNSUPPORTED',
    'E_PLUGIN_DEPENDENCY_MISSING',
    'E_BLOCKBENCH_ERROR',
  ];
  assert.deepEqual([...ERROR_CODES], expected);
  assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length);
});

test('command registry is partitioned into format-neutral, Java-format, and GeckoLib-format groups', () => {
  const neutral = Object.keys(FORMAT_NEUTRAL_COMMAND_SPECS);
  const java = Object.keys(JAVA_FORMAT_COMMAND_SPECS);
  const geckolib = Object.keys(GECKOLIB_FORMAT_COMMAND_SPECS);
  assert.deepEqual(new Set([...neutral, ...java, ...geckolib]), new Set(COMMAND_NAMES));
  for (const name of neutral) {
    assert.ok(!java.includes(name) && !geckolib.includes(name), `${name} must belong to exactly one group`);
  }
  for (const name of java) {
    assert.ok(!geckolib.includes(name), `${name} must belong to exactly one group`);
  }
  assert.ok(neutral.includes('get_project_state'));
  assert.ok(neutral.includes('propose_scoped_directory'));
  assert.ok(java.includes('create_project'));
  assert.ok(java.includes('open_model'));
  assert.ok(java.includes('set_display_transform'));
  assert.ok(java.includes('export_model'));
  assert.ok(geckolib.includes('create_geckolib_project'));
  assert.ok(geckolib.includes('open_geckolib_model'));
  assert.ok(geckolib.includes('export_geckolib_model'));
  assert.ok(geckolib.includes('export_geckolib_animations'));
  assert.ok(geckolib.includes('validate_geckolib_file'));
  assert.ok(geckolib.includes('upsert_geckolib_animation'));
  assert.ok(geckolib.includes('delete_geckolib_animation'));
  assert.ok(geckolib.includes('get_geckolib_animation'));
});

test('create_geckolib_project params enforce GeckoLib naming rules and the model type enum', () => {
  const valid = {
    modid: 'my_mod-1.0',
    model_type: 'Entity',
    identifier: 'ghost_knight',
  };
  assert.equal(COMMAND_SPECS.create_geckolib_project.params.safeParse(valid).success, true);
  for (const badModid of ['My_Mod', 'my mod', 'my/mod', '']) {
    assert.equal(
      COMMAND_SPECS.create_geckolib_project.params.safeParse({ ...valid, modid: badModid }).success,
      false,
      `modid ${JSON.stringify(badModid)} must be rejected`,
    );
  }
  for (const badIdentifier of ['Ghost', 'a/b', 'a b']) {
    assert.equal(
      COMMAND_SPECS.create_geckolib_project.params.safeParse({ ...valid, identifier: badIdentifier }).success,
      false,
      `identifier ${JSON.stringify(badIdentifier)} must be rejected`,
    );
  }
  assert.equal(
    COMMAND_SPECS.create_geckolib_project.params.safeParse({ ...valid, model_type: 'entity' }).success,
    false,
    'model_type values are the GeckoLib plugin property values, capitalized',
  );
  assert.equal(
    COMMAND_SPECS.create_geckolib_project.params.safeParse({ ...valid, extra: true }).success,
    false,
  );
});

test('validate_geckolib_file result requires check ids and the gl4 profile literal', () => {
  const spec = COMMAND_SPECS.validate_geckolib_file;
  assert.equal(
    spec.params.safeParse({ geo_path: 'model.geo.json', animation_path: 'model.animation.json' }).success,
    true,
  );
  assert.equal(spec.params.safeParse({ geo_path: 'model.geo.json' }).success, true, 'geometry-only validation');
  assert.equal(
    spec.params.safeParse({ animation_path: 'model.animation.json' }).success,
    true,
    'animation-only validation needs no geometry',
  );
  assert.equal(spec.params.safeParse({}).success, false, 'at least one path is required');
  const okResult = {
    diagnostics: [
      { severity: 'error', message: 'duplicate bone name', check_id: 'geckolib_duplicate_bone_names' },
    ],
    profile: 'gl4',
  };
  assert.equal(spec.result.safeParse(okResult).success, true);
  assert.equal(
    spec.result.safeParse({
      diagnostics: [{ severity: 'error', message: 'x' }],
      profile: 'gl4',
    }).success,
    false,
    'diagnostics without a check_id must be rejected',
  );
  assert.equal(
    spec.result.safeParse({ diagnostics: [], profile: 'gl5' }).success,
    false,
    'only the gl4 profile literal is accepted',
  );
});

test('GeckoLib open/export params accept valid shapes and reject unknown extra fields', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['open_geckolib_model', { path: 'ghost.bbmodel', force: true }],
    ['export_geckolib_model', { path: 'ghost.geo.json', overwrite: true }],
    ['export_geckolib_animations', { path: 'ghost.animation.json' }],
  ];
  for (const [command, valid] of cases) {
    const spec = COMMAND_SPECS[command as keyof typeof COMMAND_SPECS];
    assert.equal(spec.params.safeParse(valid).success, true, `${command} must accept a valid shape`);
    assert.equal(
      spec.params.safeParse({ ...valid, extra: true }).success,
      false,
      `${command} must reject unknown extra fields`,
    );
  }
});

test('upsert_geckolib_animation accepts the full clip payload and rejects out-of-contract shapes', () => {
  const spec = COMMAND_SPECS.upsert_geckolib_animation;
  const validClip = {
    name: 'animation.ghost.idle',
    loop: 'hold_on_last_frame',
    length: 2,
    override: false,
    anim_time_update: 'query.anim_time + query.delta_time',
    bones: {
      body: {
        rotation: [
          { time: 0, value: [0, 0, 0] },
          { time: 0.5, value: [-10, -15, 20], easing: 'easeInOutSine' },
          { time: 1, value: ['-math.sin(query.anim_time * 90) * 5', 0, 0] },
          { time: 1.5, value: [0, 0, 0], easing: 'easeInBack', easingArgs: [1.7], interpolation: 'catmullrom' },
        ],
        position: [{ time: 0, value: 1 }],
        scale: [{ time: 0, value: 'query.is_baby ? 0.5 : 1' }],
      },
    },
  };
  assert.equal(spec.params.safeParse(validClip).success, true);
  assert.equal(spec.params.safeParse({ ...validClip, replace: true }).success, true);
  assert.equal(spec.params.safeParse({ ...validClip, extra: 1 }).success, false, 'unknown top-level fields');
  assert.equal(spec.params.safeParse({ ...validClip, loop: 'hold' }).success, false, 'loop uses GeckoLib JSON terms');
  const { length: _length, ...withoutLength } = validClip;
  assert.equal(spec.params.safeParse(withoutLength).success, false, 'length in seconds is required');
  assert.equal(
    spec.params.safeParse({
      ...validClip,
      bones: { body: { rotation: [{ time: 0, value: [0, 0] }] } },
    }).success,
    false,
    'vector values need exactly 3 entries',
  );
  assert.equal(
    spec.params.safeParse({
      ...validClip,
      bones: { body: { rotation: [{ time: 0, value: 0, easing: 'easeInOutBanana' }] } },
    }).success,
    false,
    'easing names are the closed plugin whitelist',
  );
  assert.equal(
    spec.params.safeParse({
      ...validClip,
      bones: {
        body: {
          rotation: [
            { time: 0.5, value: 0 },
            { time: 0.5, value: 1 },
          ],
        },
      },
    }).success,
    false,
    'duplicate keyframe times within one channel are rejected',
  );
  assert.equal(
    spec.params.safeParse({
      ...validClip,
      bones: { body: { wiggle: [{ time: 0, value: 0 }] } },
    }).success,
    false,
    'only rotation/position/scale channels exist',
  );
  for (const badNumber of [Infinity, -Infinity, NaN]) {
    assert.equal(
      spec.params.safeParse({ ...validClip, length: badNumber }).success,
      false,
      `non-finite length ${badNumber} must be rejected`,
    );
    assert.equal(
      spec.params.safeParse({ ...validClip, bones: { body: { scale: [{ time: 0, value: badNumber }] } } }).success,
      false,
      `non-finite keyframe value ${badNumber} must be rejected`,
    );
    assert.equal(
      spec.params.safeParse({ ...validClip, bones: { body: { scale: [{ time: badNumber, value: 0 }] } } }).success,
      false,
      `non-finite keyframe time ${badNumber} must be rejected`,
    );
    assert.equal(
      spec.params.safeParse({
        ...validClip,
        bones: { body: { scale: [{ time: 0, value: 0, easing: 'easeInBack', easingArgs: [badNumber] }] } },
      }).success,
      false,
      `non-finite easingArgs entry ${badNumber} must be rejected`,
    );
  }

  const upsertResult = spec.result.safeParse({ name: 'animation.ghost.idle', status: 'created' });
  assert.equal(upsertResult.success, true);
  assert.equal(spec.result.safeParse({ name: 'animation.ghost.idle', status: 'renamed' }).success, false);
});

test('get_geckolib_animation returns the upsert payload shape and delete takes only a name', () => {
  const getSpec = COMMAND_SPECS.get_geckolib_animation;
  assert.equal(getSpec.params.safeParse({ name: 'animation.ghost.idle' }).success, true);
  assert.equal(getSpec.params.safeParse({}).success, false);
  assert.equal(getSpec.params.safeParse({ name: '' }).success, false);
  assert.equal(
    getSpec.result.safeParse({
      name: 'animation.ghost.idle',
      loop: 'once',
      length: 1,
      bones: { body: { rotation: [{ time: 0, value: [0, 0, 0] }] } },
    }).success,
    true,
  );
  assert.equal(
    COMMAND_SPECS.upsert_geckolib_animation.params.safeParse({
      name: 'animation.ghost.idle',
      loop: 'once',
      length: 1,
      bones: { body: { rotation: [{ time: 0, value: [0, 0, 0] }] } },
    }).success,
    true,
    'a get result round-trips as an upsert payload',
  );

  const deleteSpec = COMMAND_SPECS.delete_geckolib_animation;
  assert.equal(deleteSpec.params.safeParse({ name: 'animation.ghost.idle' }).success, true);
  assert.equal(deleteSpec.params.safeParse({ name: '' }).success, false);
  assert.equal(deleteSpec.params.safeParse({ name: 'animation.ghost.idle', force: true }).success, false);
  assert.equal(deleteSpec.result.safeParse({ deleted: true }).success, true);
});

test('get_project_state result accepts the additive animations summary', () => {
  const spec = COMMAND_SPECS.get_project_state;
  assert.equal(spec.result.safeParse({ open: false }).success, true);
  assert.equal(
    spec.result.safeParse({
      open: true,
      format: 'geckolib_model',
      animations: [{ name: 'animation.ghost.idle', loop: 'hold_on_last_frame', length: 2 }],
    }).success,
    true,
  );
  assert.equal(
    spec.result.safeParse({
      open: true,
      animations: [{ name: 'animation.ghost.idle', loop: 'hold', length: 2 }],
    }).success,
    false,
    'the summary uses GeckoLib loop terms, not Blockbench hold',
  );
});

test('validate_project diagnostics accept an optional target naming the affected object', () => {
  const spec = COMMAND_SPECS.validate_project;
  assert.equal(
    spec.result.safeParse({
      diagnostics: [
        { severity: 'warning', message: 'template bone missing', check_id: 'geckolib_armor_template', target: 'bipedHead' },
        { severity: 'error', message: 'legacy shape without target', check_id: 'unknown_texture' },
      ],
    }).success,
    true,
  );
  assert.equal(
    spec.result.safeParse({ diagnostics: [{ severity: 'error', message: 'x', target: 42 }] }).success,
    false,
    'a non-string target must be rejected',
  );
});

test('get_plugin_status result accepts an optional GeckoLib plugin version', () => {
  const base = {
    plugin_version: '0.1.0',
    blockbench_version: '5.1.4',
    protocol_version: PROTOCOL_VERSION,
    capabilities: ['java_block'],
    scope: { state: 'unconfirmed' },
  };
  const spec = COMMAND_SPECS.get_plugin_status;
  assert.equal(spec.result.safeParse(base).success, true);
  assert.equal(spec.result.safeParse({ ...base, geckolib_plugin_version: '4.2.5' }).success, true);
  assert.equal(spec.result.safeParse({ ...base, geckolib_plugin_version: 425 }).success, false);
});

test('every command has a description that names its create/update semantics or read-only nature', () => {
  for (const [name, spec] of Object.entries(COMMAND_SPECS)) {
    assert.ok(spec.description.length > 20, `${name} needs a meaningful description`);
    if (!spec.mutates) {
      assert.match(spec.description, /Read-only/i, `${name} is non-mutating and must say so`);
    }
  }
});

test('unknown command names are rejected by the registry lookup', () => {
  assert.equal(isCommandName('get_project_state'), true);
  assert.equal(isCommandName('drop_table'), false);
  assert.equal(isCommandName(''), false);
});

test('command params schemas reject unknown extra fields', () => {
  const result = COMMAND_SPECS.create_project.params.safeParse({ format: 'java_block', evil: true });
  assert.equal(result.success, false);
});

test('write_files params require the per-file overwrite flag to be boolean and per file', () => {
  const parsed = COMMAND_SPECS.write_files.params.safeParse({
    files: [
      { path: 'a.json', content: '{}' },
      { path: 'b.json', content: '{}', overwrite: true },
    ],
  });
  assert.equal(parsed.success, true);
  const topLevelOverwrite = COMMAND_SPECS.write_files.params.safeParse({
    files: [{ path: 'a.json', content: '{}' }],
    overwrite: true,
  });
  assert.equal(topLevelOverwrite.success, false, 'a batch-level overwrite flag must be rejected');
  const emptyBatch = COMMAND_SPECS.write_files.params.safeParse({ files: [] });
  assert.equal(emptyBatch.success, false);
});

test('hello message round-trips and requires a non-empty secret', () => {
  const hello = {
    type: 'hello',
    protocol_version: PROTOCOL_VERSION,
    secret: 's3cret',
    plugin_version: '0.1.0',
    blockbench_version: '5.1.4',
    capabilities: ['java_block'],
  };
  assert.equal(helloMessageSchema.safeParse(hello).success, true);
  assert.equal(helloMessageSchema.safeParse({ ...hello, secret: '' }).success, false);
  assert.equal(helloMessageSchema.safeParse({ ...hello, extra: 1 }).success, false);
});

test('plugin-to-adapter envelope accepts hello/response/event and rejects request', () => {
  assert.equal(
    pluginToAdapterMessageSchema.safeParse({
      type: 'hello',
      protocol_version: PROTOCOL_VERSION,
      secret: 's3cret',
      plugin_version: '0.1.0',
      blockbench_version: '5.1.4',
      capabilities: [],
    }).success,
    true,
  );
  assert.equal(
    pluginToAdapterMessageSchema.safeParse({ type: 'response', id: 'r1', ok: true, result: {} }).success,
    true,
  );
  assert.equal(
    pluginToAdapterMessageSchema.safeParse({ type: 'event', event: 'scope_changed' }).success,
    true,
  );
  assert.equal(
    pluginToAdapterMessageSchema.safeParse({ type: 'request', id: 'r1', command: 'x', params: {} }).success,
    false,
  );
});

test('adapter-to-plugin envelope accepts hello_ack/request and rejects hello', () => {
  assert.equal(
    adapterToPluginMessageSchema.safeParse({
      type: 'hello_ack',
      protocol_version: PROTOCOL_VERSION,
      heartbeat_interval_ms: 100,
      capabilities: ['java_block'],
    }).success,
    true,
  );
  assert.equal(
    adapterToPluginMessageSchema.safeParse({
      type: 'request',
      id: 'r1',
      command: 'get_project_state',
      params: {},
    }).success,
    true,
  );
  assert.equal(
    adapterToPluginMessageSchema.safeParse({
      type: 'hello',
      protocol_version: PROTOCOL_VERSION,
      secret: 'x',
      plugin_version: '0',
      blockbench_version: '0',
      capabilities: [],
    }).success,
    false,
  );
});

test('error responses carry a stable machine-readable code', () => {
  const payload = makeError('E_PLUGIN_NOT_CONNECTED', 'Blockbench plugin is not connected.');
  const message = { type: 'response', id: 'r9', ok: false, error: payload };
  const parsed = responseMessageSchema.safeParse(message);
  assert.equal(parsed.success, true);
  assert.equal(payload.details, undefined);
});

test('response envelope enforces ok/error correlation', () => {
  assert.equal(
    responseMessageSchema.safeParse({ type: 'response', id: 'r1', ok: true, error: makeError('E_TIMEOUT', 'x') })
      .success,
    false,
    'ok:true with an error payload must be rejected',
  );
  assert.equal(
    responseMessageSchema.safeParse({ type: 'response', id: 'r1', ok: false }).success,
    false,
    'ok:false without an error payload must be rejected',
  );
});
