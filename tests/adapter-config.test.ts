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

// --- Implicit per-user default config file (used only without --config/env) ---

function fileMap(files: Record<string, string>) {
  return (path: string): string => {
    const content = files[path];
    if (content === undefined) {
      const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return content;
  };
}

const DEFAULT_PATH = '/home/user/.config/minecraft-blockbench-mcp/config.json';

test('the implicit default file is used only when no explicit config source exists', () => {
  const readFile = fileMap({ [DEFAULT_PATH]: JSON.stringify({ version: 1, port: 40011, secret: 'from-default' }) });

  const implicit = loadConfig([], {}, readFile, DEFAULT_PATH);
  assert.equal(implicit.config.port, 40011);
  assert.equal(implicit.config.secret, 'from-default');
  assert.deepEqual(implicit.configSource, { kind: 'default', path: DEFAULT_PATH });
  assert.deepEqual(implicit.issues, []);

  const explicitWins = loadConfig(
    [],
    { BLOCKBENCH_MCP_CONFIG: '/explicit.json' },
    fileMap({ '/explicit.json': JSON.stringify({ port: 40012, secret: 'from-explicit' }) }),
    DEFAULT_PATH,
  );
  assert.equal(explicitWins.config.secret, 'from-explicit');
  assert.deepEqual(explicitWins.configSource, { kind: 'explicit', path: '/explicit.json' });

  const envBeatsDefault = loadConfig([], { BLOCKBENCH_MCP_SECRET: 'from-env' }, readFile, DEFAULT_PATH);
  assert.equal(envBeatsDefault.config.secret, 'from-env');
  assert.equal(envBeatsDefault.config.port, 40011, 'default-file values below env still apply');

  const cliBeatsDefault = loadConfig(['--port', '40013'], {}, readFile, DEFAULT_PATH);
  assert.equal(cliBeatsDefault.config.port, 40013);
});

test('a missing implicit default file is silent; a corrupt one is reported with its path only', () => {
  const missing = loadConfig([], {}, fileMap({}), DEFAULT_PATH);
  assert.deepEqual(missing.issues, []);
  assert.deepEqual(missing.configSource, { kind: 'none' });
  assert.equal(missing.config.secret, null);

  const corrupt = loadConfig([], {}, fileMap({ [DEFAULT_PATH]: '{secret: "sensitive-value"' }), DEFAULT_PATH);
  assert.equal(corrupt.issues.length, 1);
  assert.equal(corrupt.issues[0].code, 'E_INVALID_PARAMS');
  assert.ok(corrupt.issues[0].message.includes(DEFAULT_PATH));
  assert.ok(!corrupt.issues[0].message.includes('sensitive-value'), 'file content must never be echoed');
  assert.deepEqual(corrupt.configSource, { kind: 'none' });
});

test('an omitted or null implicit default path keeps the previous behavior', () => {
  const omitted = loadConfig([], {}, noFile);
  assert.deepEqual(omitted.configSource, { kind: 'none' });
  const nullPath = loadConfig([], {}, noFile, null);
  assert.deepEqual(nullPath.configSource, { kind: 'none' });
});

test('the --config flag beats the implicit default, and a failed explicit file never falls back to it', () => {
  const files = fileMap({
    '/explicit.json': JSON.stringify({ port: 40015, secret: 'from-cli-config' }),
    [DEFAULT_PATH]: JSON.stringify({ version: 1, port: 40011, secret: 'from-default' }),
  });
  const cliConfig = loadConfig(['--config', '/explicit.json'], {}, files, DEFAULT_PATH);
  assert.equal(cliConfig.config.secret, 'from-cli-config');
  assert.deepEqual(cliConfig.configSource, { kind: 'explicit', path: '/explicit.json' });

  const explicitCorrupt = loadConfig(
    [],
    { BLOCKBENCH_MCP_CONFIG: '/bad.json' },
    fileMap({ '/bad.json': '{nope', [DEFAULT_PATH]: JSON.stringify({ secret: 'from-default' }) }),
    DEFAULT_PATH,
  );
  assert.deepEqual(explicitCorrupt.configSource, { kind: 'explicit-failed', path: '/bad.json' });
  assert.equal(explicitCorrupt.config.secret, null, 'a failed explicit file must not fall back to the default file');
  assert.equal(explicitCorrupt.issues.length, 1);
});
