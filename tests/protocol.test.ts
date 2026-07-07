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

test('protocol version is 2 after the GeckoLib command group extension', () => {
  assert.equal(PROTOCOL_VERSION, 2);
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
  assert.equal(spec.params.safeParse({}).success, false, 'geo_path is required');
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
