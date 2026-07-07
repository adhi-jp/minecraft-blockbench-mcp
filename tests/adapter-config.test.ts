import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig, CONFIG_DEFAULTS } from '../src/adapter/config.js';
import { DEFAULT_WS_PORT } from '../src/shared/protocol.js';

const noFile = (): string => {
  throw new Error('no config file in this test');
};

test('defaults apply when nothing is configured', () => {
  const { config, issues } = loadConfig([], {}, noFile);
  assert.equal(config.port, DEFAULT_WS_PORT);
  assert.equal(config.secret, null);
  assert.equal(config.requestTimeoutMs, CONFIG_DEFAULTS.requestTimeoutMs);
  assert.deepEqual(issues, []);
});

test('precedence is CLI over environment over config file over defaults', () => {
  const readFile = () => JSON.stringify({ port: 40001, secret: 'from-file', requestTimeoutMs: 1111 });
  const env = {
    BLOCKBENCH_MCP_CONFIG: '/tmp/adapter-config.json',
    BLOCKBENCH_MCP_PORT: '40002',
    BLOCKBENCH_MCP_SECRET: 'from-env',
  };

  const fromFileOnly = loadConfig([], { BLOCKBENCH_MCP_CONFIG: '/tmp/adapter-config.json' }, readFile);
  assert.equal(fromFileOnly.config.port, 40001);
  assert.equal(fromFileOnly.config.secret, 'from-file');
  assert.equal(fromFileOnly.config.requestTimeoutMs, 1111);

  const envOverridesFile = loadConfig([], env, readFile);
  assert.equal(envOverridesFile.config.port, 40002);
  assert.equal(envOverridesFile.config.secret, 'from-env');
  assert.equal(envOverridesFile.config.requestTimeoutMs, 1111, 'file value survives when env does not set it');

  const cliOverridesAll = loadConfig(['--port', '40003', '--secret', 'from-cli'], env, readFile);
  assert.equal(cliOverridesAll.config.port, 40003);
  assert.equal(cliOverridesAll.config.secret, 'from-cli');
});

test('invalid numeric values are reported and fall back instead of crashing', () => {
  const { config, issues } = loadConfig(['--port', 'not-a-number'], {}, noFile);
  assert.equal(config.port, DEFAULT_WS_PORT);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'E_INVALID_PARAMS');

  const outOfRange = loadConfig([], { BLOCKBENCH_MCP_PORT: '70000' }, noFile);
  assert.equal(outOfRange.config.port, DEFAULT_WS_PORT);
  assert.equal(outOfRange.issues.length, 1);
});

test('an unreadable or malformed config file is a reported setup issue', () => {
  const unreadable = loadConfig(['--config', '/nope/missing.json'], {}, noFile);
  assert.equal(unreadable.issues.length, 1);
  assert.match(unreadable.issues[0].message, /could not be read/);

  const malformed = loadConfig(['--config', '/tmp/bad.json'], {}, () => '{not json');
  assert.equal(malformed.issues.length, 1);

  const notObject = loadConfig(['--config', '/tmp/arr.json'], {}, () => '[1,2]');
  assert.equal(notObject.issues.length, 1);
  assert.match(notObject.issues[0].message, /JSON object/);
});

test('empty secrets are treated as unconfigured', () => {
  const { config } = loadConfig(['--secret', ''], { BLOCKBENCH_MCP_SECRET: '' }, noFile);
  assert.equal(config.secret, null);
});
