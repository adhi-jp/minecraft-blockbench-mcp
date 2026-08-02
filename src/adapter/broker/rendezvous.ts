import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { z } from 'zod';

export const brokerRecordSchema = z
  .object({
    endpoint: z.string(),
    broker_instance_id: z.string(),
    broker_pid: z.number().int(),
    ipc_protocol_version: z.number().int(),
    package_version: z.string(),
    ws_port: z.number().int(),
  })
  .strict();

export type BrokerRecord = z.infer<typeof brokerRecordSchema>;

export async function readBrokerRecord(path: string): Promise<BrokerRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    const record = brokerRecordSchema.safeParse(parsed);
    return record.success ? record.data : null;
  } catch {
    return null;
  }
}

export async function writeBrokerRecordAtomic(path: string, record: BrokerRecord): Promise<void> {
  const validated = brokerRecordSchema.parse(record);
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let tempExists = false;

  try {
    const file = await open(tempPath, 'wx', 0o600);
    tempExists = true;
    try {
      await file.writeFile(`${JSON.stringify(validated)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tempPath, path);
    tempExists = false;
  } finally {
    if (tempExists) {
      await unlink(tempPath).catch(() => undefined);
    }
  }
}

export async function removeBrokerRecordIfInstance(path: string, brokerInstanceId: string): Promise<boolean> {
  const record = await readBrokerRecord(path);
  if (record?.broker_instance_id !== brokerInstanceId) return false;
  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}
