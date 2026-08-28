import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renameSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  acquireStartupLock,
  electOrAttach,
  type ElectOrAttachOptions,
} from '../src/adapter/broker/election.js';
import { readBrokerRecord, writeBrokerRecordAtomic, type BrokerRecord } from '../src/adapter/broker/rendezvous.js';

interface Attachment {
  brokerInstanceId: string;
}

async function withTempDirectory(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'bbmcp-broker-election-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function brokerRecord(instanceId: string, pid = 2345): BrokerRecord {
  return {
    endpoint: `/runtime/${instanceId}.sock`,
    broker_instance_id: instanceId,
    broker_pid: pid,
    ipc_protocol_version: 1,
    package_version: '0.1.0',
    ws_port: 41220,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test('a lone elector holds the startup lock while starting, publishes, and always unlocks', async () => {
  await withTempDirectory(async (dir) => {
    const lockPath = join(dir, 'broker.lock');
    const recordPath = join(dir, 'broker.json');
    const startedRecord = brokerRecord('broker-new');
    let startCalls = 0;
    let publishCalls = 0;

    const result = await electOrAttach({
      lockPath,
      readRecord: () => readBrokerRecord(recordPath),
      probe: async () => null,
      startBroker: async () => {
        startCalls += 1;
        const lockContents = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number; created_at: number };
        assert.deepEqual(lockContents, { pid: 101, created_at: 1_000 });
        return startedRecord;
      },
      publish: async (record) => {
        publishCalls += 1;
        await writeBrokerRecordAtomic(recordPath, record);
      },
      now: () => 1_000,
      pid: 101,
    });

    assert.deepEqual(result, { kind: 'started', record: startedRecord });
    assert.equal(startCalls, 1);
    assert.equal(publishCalls, 1);
    assert.deepEqual(await readBrokerRecord(recordPath), startedRecord);
    assert.equal(await pathExists(lockPath), false);
  });
});

test('a second elector attaches to a healthy published record without starting', async () => {
  await withTempDirectory(async (dir) => {
    const recordPath = join(dir, 'broker.json');
    const record = brokerRecord('broker-live');
    await writeBrokerRecordAtomic(recordPath, record);
    let startCalls = 0;

    const result = await electOrAttach({
      lockPath: join(dir, 'broker.lock'),
      readRecord: () => readBrokerRecord(recordPath),
      probe: async (candidate) => ({ brokerInstanceId: candidate.broker_instance_id }),
      startBroker: async () => {
        startCalls += 1;
        return brokerRecord('unexpected');
      },
      publish: async () => undefined,
      now: () => 1_000,
      pid: 102,
    });

    assert.deepEqual(result, {
      kind: 'attached',
      record,
      attachment: { brokerInstanceId: 'broker-live' },
    });
    assert.equal(startCalls, 0);
  });
});

test('an elector re-probes after finding a lock and attaches when the holder becomes healthy', async () => {
  await withTempDirectory(async (dir) => {
    const lockPath = join(dir, 'broker.lock');
    const record = brokerRecord('broker-starting');
    await writeFile(lockPath, JSON.stringify({ pid: 202, created_at: 1_000 }), { mode: 0o600 });
    let probeCalls = 0;
    let startCalls = 0;

    const result = await electOrAttach({
      lockPath,
      readRecord: async () => record,
      probe: async () => {
        probeCalls += 1;
        return probeCalls >= 2 ? { brokerInstanceId: record.broker_instance_id } : null;
      },
      startBroker: async () => {
        startCalls += 1;
        return brokerRecord('unexpected');
      },
      publish: async () => undefined,
      now: () => 1_010,
      pid: 105,
    });

    assert.equal(result.kind, 'attached');
    assert.equal(probeCalls, 2);
    assert.equal(startCalls, 0);
    assert.equal(await pathExists(lockPath), true);
  });
});

test('a healthy endpoint attaches even when its recorded pid is absent and the record remains untouched', async () => {
  await withTempDirectory(async (dir) => {
    const recordPath = join(dir, 'broker.json');
    const record = brokerRecord('broker-remote', 999_999_999);
    await writeBrokerRecordAtomic(recordPath, record);

    const result = await electOrAttach({
      lockPath: join(dir, 'broker.lock'),
      readRecord: () => readBrokerRecord(recordPath),
      probe: async () => ({ brokerInstanceId: 'broker-remote' }),
      startBroker: async () => brokerRecord('unexpected'),
      publish: async () => undefined,
      now: () => 2_000,
      pid: 103,
    });

    assert.equal(result.kind, 'attached');
    assert.deepEqual(await readBrokerRecord(recordPath), record);
  });
});

test('a failing probe behind a fresh startup lock waits without taking over', async () => {
  await withTempDirectory(async (dir) => {
    const lockPath = join(dir, 'broker.lock');
    await writeFile(lockPath, JSON.stringify({ pid: 200, created_at: 950 }), { mode: 0o600 });
    let currentTime = 1_000;
    let startCalls = 0;

    const result = await electOrAttach({
      lockPath,
      readRecord: async () => brokerRecord('stale'),
      probe: async () => null,
      startBroker: async () => {
        startCalls += 1;
        return brokerRecord('unexpected');
      },
      publish: async () => undefined,
      now: () => currentTime,
      sleep: async (ms) => {
        currentTime += ms;
      },
      lockStaleMs: 100,
      waitTimeoutMs: 30,
      retryIntervalMs: 10,
      pid: 104,
    });

    assert.equal(result.kind, 'unavailable');
    assert.equal(startCalls, 0);
    assert.equal(await pathExists(lockPath), true);
  });
});

test('two racers perform exactly one stale-lock takeover', async () => {
  await withTempDirectory(async (dir) => {
    const lockPath = join(dir, 'broker.lock');
    await writeFile(lockPath, JSON.stringify({ pid: 200, created_at: 0 }), { mode: 0o600 });
    let publishedRecord: BrokerRecord | null = brokerRecord('dead');
    let startCalls = 0;
    let currentTime = 20_000;

    const common: Omit<ElectOrAttachOptions<BrokerRecord, Attachment>, 'pid'> = {
      lockPath,
      readRecord: async () => publishedRecord,
      probe: async (candidate) =>
        candidate.broker_instance_id === 'broker-winner'
          ? { brokerInstanceId: candidate.broker_instance_id }
          : null,
      startBroker: async () => {
        startCalls += 1;
        await new Promise<void>((resolve) => setImmediate(resolve));
        return brokerRecord('broker-winner');
      },
      publish: async (record) => {
        publishedRecord = record;
      },
      now: () => currentTime,
      sleep: async (ms) => {
        currentTime += ms;
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
      lockStaleMs: 100,
      waitTimeoutMs: 1_000,
      retryIntervalMs: 10,
    };

    const results = await Promise.all([
      electOrAttach({ ...common, pid: 301 }),
      electOrAttach({ ...common, pid: 302 }),
    ]);

    assert.equal(startCalls, 1);
    assert.equal(results.filter((result) => result.kind === 'started').length, 1);
    assert.equal(await pathExists(lockPath), false);
  });
});

test('separately imported takeover racers cannot both start a broker', async () => {
  await withTempDirectory(async (dir) => {
    const electionSource = await readFile(new URL('../src/adapter/broker/election.ts', import.meta.url), 'utf8');
    const firstElectionPath = join(dir, 'election-first.ts');
    const secondElectionPath = join(dir, 'election-second.ts');
    await Promise.all([
      writeFile(firstElectionPath, electionSource),
      writeFile(secondElectionPath, electionSource),
    ]);
    const [firstElection, secondElection] = await Promise.all([
      import(pathToFileURL(firstElectionPath).href),
      import(pathToFileURL(secondElectionPath).href),
    ]);
    const lockPath = join(dir, 'broker.lock');
    await writeFile(lockPath, JSON.stringify({ pid: 200, created_at: 0 }), { mode: 0o600 });

    let publishedRecord: BrokerRecord | null = brokerRecord('dead');
    let startCalls = 0;
    const currentTime = 20_000;
    let afterLockProbeCount = 0;
    let releaseAfterLockProbes!: () => void;
    const afterLockProbesReady = new Promise<void>((resolve) => {
      releaseAfterLockProbes = resolve;
    });
    const makeOptions = (pid: number): ElectOrAttachOptions<BrokerRecord, Attachment> => {
      let probeCalls = 0;
      return {
        lockPath,
        readRecord: async () => publishedRecord,
        probe: async (candidate) => {
          probeCalls += 1;
          if (candidate.broker_instance_id === 'broker-winner') {
            return { brokerInstanceId: candidate.broker_instance_id };
          }
          if (probeCalls === 2) {
            afterLockProbeCount += 1;
            if (afterLockProbeCount === 2) releaseAfterLockProbes();
            await afterLockProbesReady;
          }
          return null;
        },
        startBroker: async () => {
          startCalls += 1;
          return brokerRecord('broker-winner');
        },
        publish: async (record) => {
          publishedRecord = record;
        },
        now: () => currentTime,
        sleep: async () => {
          await new Promise<void>((resolve) => setImmediate(resolve));
        },
        lockStaleMs: 100,
        waitTimeoutMs: 1_000,
        retryIntervalMs: 10,
        pid,
      };
    };

    const results = await Promise.all([
      firstElection.electOrAttach(makeOptions(311)),
      secondElection.electOrAttach(makeOptions(312)),
    ]);

    assert.equal(startCalls, 1);
    assert.equal(results.filter((result) => result.kind === 'started').length, 1);
    assert.equal(results.filter((result) => result.kind === 'attached').length, 1);
    assert.equal(
      results.some(
        (result) => result.kind === 'attached' && result.record.broker_instance_id === 'broker-winner',
      ),
      true,
    );
    assert.equal(await pathExists(lockPath), false);
  });
});

test('a fresh lock replacing the observed stale lock is restored without takeover', async () => {
  await withTempDirectory(async (dir) => {
    const lockPath = join(dir, 'broker.lock');
    const displacedStalePath = join(dir, 'broker.lock.displaced-stale');
    const freshLock = { pid: 777, created_at: 19_950 };
    await writeFile(lockPath, JSON.stringify({ pid: 200, created_at: 0 }), { mode: 0o600 });
    let swappedLock = false;
    let startCalls = 0;

    const result = await electOrAttach({
      lockPath,
      readRecord: async () => brokerRecord('dead'),
      probe: async () => null,
      startBroker: async () => {
        startCalls += 1;
        return brokerRecord('unexpected');
      },
      publish: async () => undefined,
      now: () => {
        if (!swappedLock) {
          swappedLock = true;
          renameSync(lockPath, displacedStalePath);
          writeFileSync(lockPath, JSON.stringify(freshLock), { mode: 0o600 });
        }
        return 20_000;
      },
      lockStaleMs: 100,
      waitTimeoutMs: 0,
      pid: 313,
    });

    assert.equal(result.kind, 'unavailable');
    assert.equal(startCalls, 0);
    assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), freshLock);
  });
});

test('a dead broker record without a startup lock is replaced by a successful election', async () => {
  await withTempDirectory(async (dir) => {
    const lockPath = join(dir, 'broker.lock');
    let record: BrokerRecord | null = brokerRecord('dead');
    let startCalls = 0;

    const result = await electOrAttach({
      lockPath,
      readRecord: async () => record,
      probe: async () => null,
      startBroker: async () => {
        startCalls += 1;
        return brokerRecord('replacement');
      },
      publish: async (next) => {
        record = next;
      },
      now: () => 30_000,
      pid: 401,
    });

    assert.equal(result.kind, 'started');
    assert.equal(startCalls, 1);
    assert.equal(record?.broker_instance_id, 'replacement');
    assert.equal(await pathExists(lockPath), false);
  });
});

test('startup failure releases the exclusive lock', async () => {
  await withTempDirectory(async (dir) => {
    const lockPath = join(dir, 'broker.lock');
    await assert.rejects(
      electOrAttach({
        lockPath,
        readRecord: async () => null,
        probe: async () => null,
        startBroker: async () => {
          throw new Error('injected startup failure');
        },
        publish: async () => undefined,
        now: () => 40_000,
        pid: 501,
      }),
      /injected startup failure/,
    );
    assert.equal(await pathExists(lockPath), false);
  });
});

test('a malformed startup lock is immediately taken over without clock advancement', async () => {
  await withTempDirectory(async (dir) => {
    const lockPath = join(dir, 'broker.lock');
    const startedRecord = brokerRecord('broker-after-malformed-lock');
    await writeFile(lockPath, '{', { mode: 0o600 });
    let startCalls = 0;

    const result = await electOrAttach({
      lockPath,
      readRecord: async () => null,
      probe: async () => null,
      startBroker: async () => {
        startCalls += 1;
        return startedRecord;
      },
      publish: async () => undefined,
      now: () => 50_000,
      lockStaleMs: 10_000,
      waitTimeoutMs: 0,
      pid: 601,
    });

    assert.deepEqual(result, { kind: 'started', record: startedRecord });
    assert.equal(startCalls, 1);
  });
});

test('a successful election leaves no startup-lock temporary file behind', async () => {
  await withTempDirectory(async (dir) => {
    const lockPath = join(dir, 'broker.lock');

    const result = await electOrAttach({
      lockPath,
      readRecord: async () => null,
      probe: async () => null,
      startBroker: async () => brokerRecord('broker-with-clean-lock-directory'),
      publish: async () => undefined,
      now: () => 60_000,
      pid: 602,
    });

    assert.equal(result.kind, 'started');
    assert.deepEqual(
      (await readdir(dir)).filter((entry) => entry.endsWith('.tmp')),
      [],
    );
  });
});

test('concurrent startup-lock acquisitions have exactly one winner', async () => {
  await withTempDirectory(async (dir) => {
    const lockPath = join(dir, 'broker.lock');

    const locks = await Promise.all([
      acquireStartupLock({ lockPath, pid: 701, now: () => 70_000 }),
      acquireStartupLock({ lockPath, pid: 702, now: () => 70_000 }),
    ]);
    const winners = locks.filter((lock) => lock !== null);

    assert.equal(winners.length, 1);
    assert.equal(locks.filter((lock) => lock === null).length, 1);
    await winners[0]?.release();
  });
});
