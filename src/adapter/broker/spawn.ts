export interface BrokerSpawnInput {
  execPath: string;
  cliEntryPath: string;
  configPath: string;
}

export interface BuiltBrokerSpawn {
  command: string;
  args: string[];
  options: {
    detached: true;
    stdio: 'ignore';
  };
}

export interface DetachedChild {
  unref(): void;
}

export type BrokerSpawnImplementation<T extends DetachedChild = DetachedChild> = (
  command: string,
  args: string[],
  options: BuiltBrokerSpawn['options'],
) => T;

export function buildBrokerSpawnArgs(input: BrokerSpawnInput): BuiltBrokerSpawn {
  return {
    command: input.execPath,
    args: [input.cliEntryPath, '__broker', '--config', input.configPath],
    options: { detached: true, stdio: 'ignore' },
  };
}

export function spawnDetachedBroker<T extends DetachedChild>(
  spawnImpl: BrokerSpawnImplementation<T>,
  built: BuiltBrokerSpawn,
): T {
  const child = spawnImpl(built.command, built.args, built.options);
  child.unref();
  return child;
}
