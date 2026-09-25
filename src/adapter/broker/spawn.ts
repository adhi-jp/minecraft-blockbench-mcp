import type { AdapterConfig } from '../config.js';

export interface BrokerSpawnInput {
  execPath: string;
  cliEntryPath: string;
  configPath: string;
  /**
   * The shim's resolved configuration. The broker re-resolves its own settings
   * from argv, env, and the config file, so everything the shim resolved from
   * its own command line has to be handed over or the broker silently falls
   * back to file/env/default values.
   */
  config: AdapterConfig;
  /** The environment the broker inherits; the secret is added here, never to argv. */
  env: NodeJS.ProcessEnv;
}

export interface BuiltBrokerSpawn {
  command: string;
  args: string[];
  options: {
    detached: true;
    stdio: 'ignore';
    env: NodeJS.ProcessEnv;
  };
}

export interface DetachedChild {
  unref(): void;
  on?(event: 'error', listener: (error: Error) => void): unknown;
}

export type BrokerSpawnImplementation<T extends DetachedChild = DetachedChild> = (
  command: string,
  args: string[],
  options: BuiltBrokerSpawn['options'],
) => T;

/** The CLI flag for every non-secret setting; the secret travels only through the environment. */
const FORWARDED_FLAGS: Record<Exclude<keyof AdapterConfig, 'secret'>, string> = {
  port: '--port',
  requestTimeoutMs: '--request-timeout-ms',
  heartbeatIntervalMs: '--heartbeat-interval-ms',
  heartbeatMissLimit: '--heartbeat-miss-limit',
  handshakeTimeoutMs: '--handshake-timeout-ms',
  maxMessageBytes: '--max-message-bytes',
  brokerIdleTimeoutMs: '--broker-idle-timeout-ms',
  leaseIdleTimeoutMs: '--lease-idle-timeout-ms',
};

export function buildBrokerSpawnArgs(input: BrokerSpawnInput): BuiltBrokerSpawn {
  const flags = (Object.keys(FORWARDED_FLAGS) as Array<keyof typeof FORWARDED_FLAGS>).flatMap((key) => [
    FORWARDED_FLAGS[key],
    String(input.config[key]),
  ]);
  const env = { ...input.env };
  if (input.config.secret !== null) env.BLOCKBENCH_MCP_SECRET = input.config.secret;
  return {
    command: input.execPath,
    args: [input.cliEntryPath, '__broker', '--config', input.configPath, ...flags],
    options: { detached: true, stdio: 'ignore', env },
  };
}

export function spawnDetachedBroker<T extends DetachedChild>(
  spawnImpl: BrokerSpawnImplementation<T>,
  built: BuiltBrokerSpawn,
  onError: (error: Error) => void = () => undefined,
): T {
  const child = spawnImpl(built.command, built.args, built.options);
  child.on?.('error', onError);
  child.unref();
  return child;
}
