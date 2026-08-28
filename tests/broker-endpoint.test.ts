import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';

import {
  computeConfigIdentity,
  ensureRuntimeDirectory,
  ipcEndpointFor,
  MAX_UNIX_SOCKET_PATH_LENGTH,
  resolveRuntimeDirectory,
  UnixSocketPathTooLongError,
} from '../src/adapter/broker/endpoint.js';
import {
  readBrokerRecord,
  removeBrokerRecordIfInstance,
  writeBrokerRecordAtomic,
  type BrokerRecord,
} from '../src/adapter/broker/rendezvous.js';
import { platformHasCapability } from './platform-capabilities.ts';

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

// `resolveRuntimeDirectory` is a pure function over a *simulated* platform: it
// picks `posix` or `win32` from `options.platform`, never from the host. Both
// halves of the test have to be shaped for the simulated platform, not just the
// expectation. Building the inputs with the host `join` made a Windows host
// hand `C:\...\xdg-runtime` to the linux case, `posix.isAbsolute` answered
// false for it, and the function quietly took the *fallback* branch — so fixing
// only the expected string would have produced a green test that no longer
// covered the XDG branch at all. Fixed POSIX literals below keep the input
// absolute under `posix.isAbsolute` everywhere, and the XDG expectation is a
// different directory from the fallback expectation, so the first assertion can
// only hold if the XDG branch really ran.
test('an absolute XDG runtime directory is honored and other values fall back to the config directory', () => {
  const xdg = '/run/user/1000/xdg-runtime';
  const configDir = '/home/tester/.config/minecraft-blockbench-mcp';
  assert.ok(posix.isAbsolute(xdg), 'the XDG input must be POSIX-absolute or this test exercises the fallback branch');
  assert.equal(
    resolveRuntimeDirectory({ platform: 'linux', env: { XDG_RUNTIME_DIR: xdg }, configDir }),
    posix.join(xdg, 'minecraft-blockbench-mcp'),
  );
  for (const value of ['', 'relative/runtime']) {
    assert.equal(
      resolveRuntimeDirectory({ platform: 'linux', env: { XDG_RUNTIME_DIR: value }, configDir }),
      posix.join(configDir, 'run'),
    );
  }
});

// Also a pure function over a simulated platform, and the same rule applies to
// its inputs: the win32 case is given a win32-shaped runtime directory and the
// linux case a POSIX-shaped one, so each assertion drives the branch it names on
// every host. The expectation is built with `posix.join` because that is what
// the function uses for every non-win32 platform; the host `join` disagreed with
// it on Windows.
test('Windows endpoints use the named-pipe namespace while POSIX endpoints use the runtime directory', () => {
  assert.equal(
    ipcEndpointFor({
      platform: 'win32',
      runtimeDir: 'C:\\ProgramData\\minecraft-blockbench-mcp\\run',
      identity: '0123456789abcdef',
    }),
    '\\\\.\\pipe\\minecraft-blockbench-mcp-0123456789abcdef',
  );
  const runtimeDir = '/run/user/1000/minecraft-blockbench-mcp';
  assert.equal(
    ipcEndpointFor({ platform: 'linux', runtimeDir, identity: '0123456789abcdef' }),
    posix.join(runtimeDir, 'broker-0123456789abcdef.sock'),
  );
});

test('POSIX endpoints reject a composed path one byte over the unix socket limit with actionable remediation', () => {
  const identity = '0123456789abcdef';
  const runtimeDir = `/${'r'.repeat(74)}`;
  const composedPath = posix.join(runtimeDir, `broker-${identity}.sock`);
  assert.equal(Buffer.byteLength(composedPath, 'utf8'), 104);

  assert.throws(
    () => ipcEndpointFor({ platform: 'linux', runtimeDir, identity }),
    (error) => {
      if (!(error instanceof UnixSocketPathTooLongError)) return false;
      assert.ok(error.message.includes(composedPath));
      assert.ok(error.message.includes('104'));
      assert.ok(error.message.includes(String(MAX_UNIX_SOCKET_PATH_LENGTH)));
      assert.ok(error.message.includes('--direct'));
      assert.ok(error.message.includes('BLOCKBENCH_MCP_DIRECT'));
      assert.ok(error.message.includes('XDG_RUNTIME_DIR'));
      return true;
    },
  );
});

test('POSIX endpoints allow a composed path exactly at the unix socket limit', () => {
  const identity = '0123456789abcdef';
  const runtimeDir = `/${'r'.repeat(73)}`;
  const composedPath = posix.join(runtimeDir, `broker-${identity}.sock`);
  assert.equal(Buffer.byteLength(composedPath, 'utf8'), MAX_UNIX_SOCKET_PATH_LENGTH);
  assert.doesNotThrow(() => ipcEndpointFor({ platform: 'darwin', runtimeDir, identity }));
});

test('POSIX endpoint length is measured in UTF-8 bytes rather than JavaScript string length', () => {
  const identity = '😀'.repeat(25);
  const runtimeDir = '/run';
  const composedPath = posix.join(runtimeDir, `broker-${identity}.sock`);
  assert.ok(composedPath.length <= MAX_UNIX_SOCKET_PATH_LENGTH);
  assert.ok(Buffer.byteLength(composedPath, 'utf8') > MAX_UNIX_SOCKET_PATH_LENGTH);
  assert.throws(
    () => ipcEndpointFor({ platform: 'linux', runtimeDir, identity }),
    UnixSocketPathTooLongError,
  );
});

test('Windows named pipes ignore an over-length runtime directory', () => {
  const identity = '0123456789abcdef';
  const runtimeDir = `/${'r'.repeat(74)}`;
  const composedPosixPath = posix.join(runtimeDir, `broker-${identity}.sock`);
  assert.equal(Buffer.byteLength(composedPosixPath, 'utf8'), MAX_UNIX_SOCKET_PATH_LENGTH + 1);
  assert.equal(
    ipcEndpointFor({ platform: 'win32', runtimeDir, identity }),
    '\\\\.\\pipe\\minecraft-blockbench-mcp-0123456789abcdef',
  );
});

// The whole body of this test used to sit inside the mode branch, so on Windows
// it asserted nothing at all while still counting as a pass. The name stays as
// it is: the frozen named-test inventory holds every recorded test name, so
// renaming this one would read as a deletion, and splitting the creation half
// into a test of its own would leave this one vacuous on Windows again — the
// defect being fixed. What changed instead is the body: creating the directory
// and re-ensuring it are asserted everywhere, and only the mode reads, which is
// the half Windows has no bits for, are narrowed through the registry that says
// why and what has to be asserted in their place.
test('runtime directories are created and repaired to owner-only mode', async () => {
  await withTempDirectory(async (dir) => {
    const runtimeDir = join(dir, 'nested', 'run');
    await ensureRuntimeDirectory(runtimeDir);
    assert.equal(
      (await stat(runtimeDir)).isDirectory(),
      true,
      'ensureRuntimeDirectory did not create the runtime directory, nested parents and all',
    );
    if (platformHasCapability('posix-file-mode-bits')) {
      assert.equal((await stat(runtimeDir)).mode & 0o777, 0o700);
      await chmod(runtimeDir, 0o755);
      await ensureRuntimeDirectory(runtimeDir);
      assert.equal((await stat(runtimeDir)).mode & 0o777, 0o700);
    }
    // The repairing second call has to be harmless wherever it runs. On Windows
    // it is the whole of what `ensureRuntimeDirectory` does to a directory that
    // already exists, and a `mkdir` that threw or replaced the directory would
    // be a real defect there.
    await ensureRuntimeDirectory(runtimeDir);
    assert.equal(
      (await stat(runtimeDir)).isDirectory(),
      true,
      're-ensuring an existing runtime directory must leave it in place',
    );
  });
});

test('rendezvous records are written atomically with owner-only permissions and read back', async () => {
  await withTempDirectory(async (dir) => {
    const path = join(dir, 'broker.json');
    const expected = record();
    await writeBrokerRecordAtomic(path, expected);
    assert.deepEqual(await readBrokerRecord(path), expected);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).broker_instance_id, 'broker-a');
    if (platformHasCapability('posix-file-mode-bits')) {
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
