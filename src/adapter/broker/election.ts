import { randomUUID } from 'node:crypto';
import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

export interface StartupLock {
  release(): Promise<void>;
}

export interface AcquireStartupLockOptions {
  lockPath: string;
  pid: number;
  now: () => number;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

export async function acquireStartupLock(options: AcquireStartupLockOptions): Promise<StartupLock | null> {
  let file: FileHandle | undefined;
  try {
    file = await open(options.lockPath, 'wx', 0o600);
  } catch (error) {
    if (isNodeError(error, 'EEXIST')) return null;
    throw error;
  }

  try {
    await file.writeFile(JSON.stringify({ pid: options.pid, created_at: options.now() }), 'utf8');
    await file.sync();
    const acquiredStats = await file.stat();
    await file.close();
    file = undefined;

    return {
      release: async () => {
        try {
          const currentStats = await stat(options.lockPath);
          if (currentStats.dev === acquiredStats.dev && currentStats.ino === acquiredStats.ino) {
            await unlink(options.lockPath);
          }
        } catch (error) {
          if (!isNodeError(error, 'ENOENT')) throw error;
        }
      },
    };
  } catch (error) {
    if (file !== undefined) await file.close().catch(() => undefined);
    await unlink(options.lockPath).catch(() => undefined);
    throw error;
  }
}

type Awaitable<T> = T | Promise<T>;

export interface ElectOrAttachOptions<RecordType, AttachType> {
  lockPath: string;
  readRecord: () => Awaitable<RecordType | null>;
  probe: (record: RecordType) => Promise<AttachType | null>;
  startBroker: () => Promise<RecordType>;
  publish: (record: RecordType) => Awaitable<void>;
  now: () => number;
  lockStaleMs?: number;
  pid: number;
  sleep?: (ms: number) => Promise<void>;
  waitTimeoutMs?: number;
  retryIntervalMs?: number;
}

export type ElectionResult<RecordType, AttachType> =
  | { kind: 'attached'; record: RecordType; attachment: AttachType }
  | { kind: 'started'; record: RecordType }
  | { kind: 'unavailable'; reason: string };

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const inProcessTakeovers = new Set<string>();

async function probeCurrent<RecordType, AttachType>(
  options: ElectOrAttachOptions<RecordType, AttachType>,
): Promise<{ record: RecordType; attachment: AttachType } | null> {
  const record = await options.readRecord();
  if (record === null) return null;
  const attachment = await options.probe(record);
  return attachment === null ? null : { record, attachment };
}

async function readLockCreatedAt(lockPath: string): Promise<number | null> {
  try {
    const value: unknown = JSON.parse(await readFile(lockPath, 'utf8'));
    if (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { created_at?: unknown }).created_at === 'number' &&
      Number.isFinite((value as { created_at: number }).created_at)
    ) {
      return (value as { created_at: number }).created_at;
    }
  } catch {
    // An unreadable or malformed lock is treated conservatively as non-stale.
  }
  return null;
}

async function renameLockForTakeover(lockPath: string, takeoverPath: string): Promise<boolean> {
  try {
    await rename(lockPath, takeoverPath);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    return false;
  }
}

async function restoreRenamedLock(lockPath: string, takeoverPath: string): Promise<void> {
  try {
    await rename(takeoverPath, lockPath);
  } catch {
    await unlink(takeoverPath).catch(() => undefined);
  }
}

async function removeRenamedLock(takeoverPath: string): Promise<boolean> {
  try {
    await unlink(takeoverPath);
    return true;
  } catch {
    return false;
  }
}

async function runAsLockOwner<RecordType, AttachType>(
  options: ElectOrAttachOptions<RecordType, AttachType>,
  lock: StartupLock,
): Promise<ElectionResult<RecordType, AttachType>> {
  try {
    const existing = await probeCurrent(options);
    if (existing !== null) {
      return { kind: 'attached', ...existing };
    }

    const record = await options.startBroker();
    await options.publish(record);
    return { kind: 'started', record };
  } finally {
    await lock.release();
  }
}

async function waitForBroker<RecordType, AttachType>(
  options: ElectOrAttachOptions<RecordType, AttachType>,
): Promise<ElectionResult<RecordType, AttachType>> {
  const sleep = options.sleep ?? defaultSleep;
  const retryIntervalMs = options.retryIntervalMs ?? 50;
  const deadline = options.now() + (options.waitTimeoutMs ?? 15_000);

  while (true) {
    const existing = await probeCurrent(options);
    if (existing !== null) return { kind: 'attached', ...existing };

    const remaining = deadline - options.now();
    if (remaining <= 0) {
      return { kind: 'unavailable', reason: 'Timed out waiting for a healthy broker.' };
    }
    await sleep(Math.min(retryIntervalMs, remaining));
  }
}

export async function electOrAttach<RecordType, AttachType>(
  options: ElectOrAttachOptions<RecordType, AttachType>,
): Promise<ElectionResult<RecordType, AttachType>> {
  const existing = await probeCurrent(options);
  if (existing !== null) return { kind: 'attached', ...existing };

  const lockOptions = { lockPath: options.lockPath, pid: options.pid, now: options.now };
  const lock = await acquireStartupLock(lockOptions);
  if (lock !== null) return runAsLockOwner(options, lock);

  const afterLock = await probeCurrent(options);
  if (afterLock !== null) return { kind: 'attached', ...afterLock };

  const createdAt = await readLockCreatedAt(options.lockPath);
  const lockStaleMs = options.lockStaleMs ?? 10_000;
  if (
    createdAt !== null &&
    options.now() - createdAt > lockStaleMs &&
    !inProcessTakeovers.has(options.lockPath)
  ) {
    inProcessTakeovers.add(options.lockPath);
    try {
      const takeoverPath = `${options.lockPath}.takeover.${options.pid}.${randomUUID()}`;
      const renamed = await renameLockForTakeover(options.lockPath, takeoverPath);
      if (renamed) {
        const renamedCreatedAt = await readLockCreatedAt(takeoverPath);
        if (renamedCreatedAt !== createdAt) {
          await restoreRenamedLock(options.lockPath, takeoverPath);
          return waitForBroker(options);
        }

        const removed = await removeRenamedLock(takeoverPath);
        if (!removed) return waitForBroker(options);
        const takeoverLock = await acquireStartupLock(lockOptions);
        if (takeoverLock !== null) return await runAsLockOwner(options, takeoverLock);
      }
    } finally {
      inProcessTakeovers.delete(options.lockPath);
    }
  }

  return waitForBroker(options);
}
