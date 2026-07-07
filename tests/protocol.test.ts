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
    'E_BLOCKBENCH_ERROR',
  ];
  assert.deepEqual([...ERROR_CODES], expected);
  assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length);
});

test('command registry is partitioned into format-neutral and Java-format groups', () => {
  const neutral = Object.keys(FORMAT_NEUTRAL_COMMAND_SPECS);
  const java = Object.keys(JAVA_FORMAT_COMMAND_SPECS);
  assert.deepEqual(new Set([...neutral, ...java]), new Set(COMMAND_NAMES));
  for (const name of neutral) assert.ok(!java.includes(name), `${name} must belong to exactly one group`);
  assert.ok(neutral.includes('get_project_state'));
  assert.ok(neutral.includes('propose_scoped_directory'));
  assert.ok(java.includes('create_project'));
  assert.ok(java.includes('open_model'));
  assert.ok(java.includes('set_display_transform'));
  assert.ok(java.includes('export_model'));
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
