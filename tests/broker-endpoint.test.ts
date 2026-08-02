import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  computeConfigIdentity,
  ensureRuntimeDirectory,
  ipcEndpointFor,
  resolveRuntimeDirectory,
} from '../src/adapter/broker/endpoint.js';
import {
  readBrokerRecord,
  removeBrokerRecordIfInstance,
  writeBrokerRecordAtomic,
  type BrokerRecord,
} from '../src/adapter/broker/rendezvous.js';

async function withTempDirectory(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'bbmcp-broker-endpoint-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function record(overrides: Partial<BrokerRecord> = {}): BrokerRecord {
  return {
    endpoint: '/runtime/broker.sock',
    broker_instance_id: 'broker-a',
    broker_pid: 1234,
    ipc_protocol_version: 1,
    package_version: '0.1.0',
    ws_port: 41210,
    ...overrides,
  };
}

test('config identity is stable per resolved path and contains 16 lowercase hex characters', async () => {
  await withTempDirectory(async (dir) => {
    const configPath = join(dir, 'config.json');
    const identity = computeConfigIdentity(configPath);
    assert.equal(computeConfigIdentity(configPath), identity);
    assert.match(identity, /^[0-9a-f]{16}$/);
    assert.notEqual(computeConfigIdentity(join(dir, 'other.json')), identity);
  });
});

test('an absolute XDG runtime directory is honored and other values fall back to the config directory', async () => {
  await withTempDirectory(async (dir) => {
    const xdg = join(dir, 'xdg-runtime');
    const configDir = join(dir, 'config');
    assert.equal(
      resolveRuntimeDirectory({ platform: 'linux', env: { XDG_RUNTIME_DIR: xdg }, configDir }),
      join(xdg, 'minecraft-blockbench-mcp'),
    );
    for (const value of ['', 'relative/runtime']) {
      assert.equal(
        resolveRuntimeDirectory({ platform: 'linux', env: { XDG_RUNTIME_DIR: value }, configDir }),
        join(configDir, 'run'),
      );
    }
  });
});

test('Windows endpoints use the named-pipe namespace while POSIX endpoints use the runtime directory', async () => {
  await withTempDirectory(async (dir) => {
    assert.equal(
      ipcEndpointFor({ platform: 'win32', runtimeDir: dir, identity: '0123456789abcdef' }),
      '\\\\.\\pipe\\minecraft-blockbench-mcp-0123456789abcdef',
    );
    assert.equal(
      ipcEndpointFor({ platform: 'linux', runtimeDir: dir, identity: '0123456789abcdef' }),
      join(dir, 'broker-0123456789abcdef.sock'),
    );
  });
});

test('runtime directories are created and repaired to owner-only mode', async () => {
  await withTempDirectory(async (dir) => {
    const runtimeDir = join(dir, 'nested', 'run');
    await ensureRuntimeDirectory(runtimeDir);
    if (process.platform !== 'win32') {
      assert.equal((await stat(runtimeDir)).mode & 0o777, 0o700);
      await chmod(runtimeDir, 0o755);
      await ensureRuntimeDirectory(runtimeDir);
      assert.equal((await stat(runtimeDir)).mode & 0o777, 0o700);
    }
  });
});

test('rendezvous records are written atomically with owner-only permissions and read back', async () => {
  await withTempDirectory(async (dir) => {
    const path = join(dir, 'broker.json');
    const expected = record();
    await writeBrokerRecordAtomic(path, expected);
    assert.deepEqual(await readBrokerRecord(path), expected);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).broker_instance_id, 'broker-a');
    if (process.platform !== 'win32') {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }

    const replacement = record({ broker_instance_id: 'broker-b', broker_pid: 4321 });
    await writeBrokerRecordAtomic(path, replacement);
    assert.deepEqual(await readBrokerRecord(path), replacement);
  });
});

test('missing, unparsable, invalid, and secret-bearing rendezvous records read as absent', async () => {
  await withTempDirectory(async (dir) => {
    const path = join(dir, 'broker.json');
    assert.equal(await readBrokerRecord(path), null);

    for (const contents of [
      '{not json',
      JSON.stringify({ endpoint: '/missing-fields' }),
      JSON.stringify({ ...record(), secret: 'must-not-be-accepted' }),
    ]) {
      await writeFile(path, contents, { mode: 0o600 });
      assert.equal(await readBrokerRecord(path), null);
    }
  });
});

test('rendezvous removal is conditional on the broker instance id', async () => {
  await withTempDirectory(async (dir) => {
    const path = join(dir, 'broker.json');
    await writeBrokerRecordAtomic(path, record());
    assert.equal(await removeBrokerRecordIfInstance(path, 'broker-b'), false);
    assert.deepEqual(await readBrokerRecord(path), record());
    assert.equal(await removeBrokerRecordIfInstance(path, 'broker-a'), true);
    assert.equal(await readBrokerRecord(path), null);
  });
});

test('rendezvous writes reject secret-bearing values instead of persisting them', async () => {
  await withTempDirectory(async (dir) => {
    const path = join(dir, 'broker.json');
    const secretBearing = { ...record(), secret: 'must-not-be-persisted' };
    await assert.rejects(writeBrokerRecordAtomic(path, secretBearing as BrokerRecord));
    assert.equal(await readBrokerRecord(path), null);
  });
});
