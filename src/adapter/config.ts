// Adapter configuration loading.
// Precedence: CLI arguments > environment variables > explicit JSON config
// file (--config / BLOCKBENCH_MCP_CONFIG) > implicit per-user default config
// file (when the caller supplies its path and the file exists) > built-in
// defaults.
import { parseArgs } from 'node:util';

import { DEFAULTS, DEFAULT_WS_PORT, type ErrorCode } from '../shared/protocol.js';

export interface AdapterConfig {
  port: number;
  /** Shared secret for plugin authentication; null when not configured. */
  secret: string | null;
  requestTimeoutMs: number;
  heartbeatIntervalMs: number;
  heartbeatMissLimit: number;
  handshakeTimeoutMs: number;
  maxMessageBytes: number;
  brokerIdleTimeoutMs: number;
  leaseIdleTimeoutMs: number;
}

export interface SetupIssue {
  code: ErrorCode;
  message: string;
}

export const CONFIG_DEFAULTS: AdapterConfig = {
  port: DEFAULT_WS_PORT,
  secret: null,
  requestTimeoutMs: DEFAULTS.requestTimeoutMs,
  heartbeatIntervalMs: DEFAULTS.heartbeatIntervalMs,
  heartbeatMissLimit: DEFAULTS.heartbeatMissLimit,
  handshakeTimeoutMs: DEFAULTS.handshakeTimeoutMs,
  maxMessageBytes: DEFAULTS.maxMessageBytes,
  brokerIdleTimeoutMs: 120_000,
  leaseIdleTimeoutMs: 60_000,
};

const ENV_PREFIX = 'BLOCKBENCH_MCP_';

interface NumericKey {
  configKey: Exclude<keyof AdapterConfig, 'secret'>;
  cliName: string;
  envName: string;
  fileKey: string;
  min: number;
  max: number;
}

const NUMERIC_KEYS: NumericKey[] = [
  { configKey: 'port', cliName: 'port', envName: `${ENV_PREFIX}PORT`, fileKey: 'port', min: 1, max: 65_535 },
  {
    configKey: 'requestTimeoutMs',
    cliName: 'request-timeout-ms',
    envName: `${ENV_PREFIX}REQUEST_TIMEOUT_MS`,
    fileKey: 'requestTimeoutMs',
    min: 1,
    max: 3_600_000,
  },
  {
    configKey: 'heartbeatIntervalMs',
    cliName: 'heartbeat-interval-ms',
    envName: `${ENV_PREFIX}HEARTBEAT_INTERVAL_MS`,
    fileKey: 'heartbeatIntervalMs',
    min: 1,
    max: 3_600_000,
  },
  {
    configKey: 'heartbeatMissLimit',
    cliName: 'heartbeat-miss-limit',
    envName: `${ENV_PREFIX}HEARTBEAT_MISS_LIMIT`,
    fileKey: 'heartbeatMissLimit',
    min: 1,
    max: 100,
  },
  {
    configKey: 'handshakeTimeoutMs',
    cliName: 'handshake-timeout-ms',
    envName: `${ENV_PREFIX}HANDSHAKE_TIMEOUT_MS`,
    fileKey: 'handshakeTimeoutMs',
    min: 1,
    max: 3_600_000,
  },
  {
    configKey: 'maxMessageBytes',
    cliName: 'max-message-bytes',
    envName: `${ENV_PREFIX}MAX_MESSAGE_BYTES`,
    fileKey: 'maxMessageBytes',
    min: 1_024,
    max: 1_073_741_824,
  },
  {
    configKey: 'brokerIdleTimeoutMs',
    cliName: 'broker-idle-timeout-ms',
    envName: `${ENV_PREFIX}BROKER_IDLE_TIMEOUT_MS`,
    fileKey: 'brokerIdleTimeoutMs',
    min: 1_000,
    max: 3_600_000,
  },
  {
    configKey: 'leaseIdleTimeoutMs',
    cliName: 'lease-idle-timeout-ms',
    envName: `${ENV_PREFIX}LEASE_IDLE_TIMEOUT_MS`,
    fileKey: 'leaseIdleTimeoutMs',
    min: 1_000,
    max: 3_600_000,
  },
];

export interface ConfigSource {
  kind: 'explicit' | 'explicit-failed' | 'default' | 'none';
  path?: string;
}

export function loadConfig(
  argv: string[],
  env: Record<string, string | undefined>,
  readFile: (path: string) => string,
  implicitDefaultPath?: string | null,
): { config: AdapterConfig; issues: SetupIssue[]; configSource: ConfigSource } {
  const issues: SetupIssue[] = [];
  const config: AdapterConfig = { ...CONFIG_DEFAULTS };

  const { values: cli } = parseArgs({
    args: argv,
    strict: false,
    options: {
      port: { type: 'string' },
      secret: { type: 'string' },
      config: { type: 'string' },
      'request-timeout-ms': { type: 'string' },
      'heartbeat-interval-ms': { type: 'string' },
      'heartbeat-miss-limit': { type: 'string' },
      'handshake-timeout-ms': { type: 'string' },
      'max-message-bytes': { type: 'string' },
      'broker-idle-timeout-ms': { type: 'string' },
      'lease-idle-timeout-ms': { type: 'string' },
    },
  });

  // Config file layer (lowest precedence above defaults). An explicit path is
  // required to exist; the implicit per-user default is used only when no
  // explicit path is given, and a missing default file is silently fine.
  let fileValues: Record<string, unknown> = {};
  let configSource: ConfigSource = { kind: 'none' };
  const explicitPath =
    (typeof cli.config === 'string' ? cli.config : undefined) ?? env[`${ENV_PREFIX}CONFIG`] ?? undefined;

  const parseConfigFile = (configPath: string, missingIsError: boolean): boolean => {
    let raw: string | null = null;
    try {
      raw = readFile(configPath);
    } catch (error) {
      // Report only the error code, never the message: fs/parser messages can
      // echo file content, and the file may contain the shared secret.
      const code = (error as NodeJS.ErrnoException).code ?? 'read error';
      if (missingIsError || code !== 'ENOENT') {
        issues.push({
          code: 'E_INVALID_PARAMS',
          message: `Config file could not be read: ${configPath} (${code})`,
        });
      }
      return false;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        fileValues = parsed as Record<string, unknown>;
        return true;
      }
      issues.push({ code: 'E_INVALID_PARAMS', message: `Config file must contain a JSON object: ${configPath}` });
    } catch (error) {
      // JSON.parse messages embed raw input snippets; keep only a position hint.
      const position = error instanceof Error ? /at position \d+/.exec(error.message)?.[0] : undefined;
      issues.push({
        code: 'E_INVALID_PARAMS',
        message: `Config file is not valid JSON: ${configPath}${position !== undefined ? ` (${position})` : ''}`,
      });
    }
    return false;
  };

  if (explicitPath !== undefined && explicitPath !== '') {
    configSource = parseConfigFile(explicitPath, true)
      ? { kind: 'explicit', path: explicitPath }
      : { kind: 'explicit-failed', path: explicitPath };
  } else if (implicitDefaultPath !== undefined && implicitDefaultPath !== null && implicitDefaultPath !== '') {
    if (parseConfigFile(implicitDefaultPath, false)) configSource = { kind: 'default', path: implicitDefaultPath };
  }

  const applyNumeric = (key: NumericKey, raw: unknown, source: string): boolean => {
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw !== '' ? Number(raw) : NaN;
    if (!Number.isInteger(value) || value < key.min || value > key.max) {
      issues.push({
        code: 'E_INVALID_PARAMS',
        message: `Invalid ${key.configKey} from ${source}: expected an integer in [${key.min}, ${key.max}].`,
      });
      return false;
    }
    config[key.configKey] = value;
    return true;
  };

  for (const key of NUMERIC_KEYS) {
    if (fileValues[key.fileKey] !== undefined) applyNumeric(key, fileValues[key.fileKey], 'config file');
    const envValue = env[key.envName];
    if (envValue !== undefined && envValue !== '') applyNumeric(key, envValue, `environment (${key.envName})`);
    const cliValue = cli[key.cliName];
    if (cliValue !== undefined) applyNumeric(key, cliValue, `CLI (--${key.cliName})`);
  }

  // Secret: CLI > env > config file. Never reported back in messages.
  const fileSecret = typeof fileValues.secret === 'string' && fileValues.secret !== '' ? fileValues.secret : null;
  const envSecret = env[`${ENV_PREFIX}SECRET`] !== undefined && env[`${ENV_PREFIX}SECRET`] !== '' ? env[`${ENV_PREFIX}SECRET`]! : null;
  const cliSecret = typeof cli.secret === 'string' && cli.secret !== '' ? cli.secret : null;
  config.secret = cliSecret ?? envSecret ?? fileSecret;

  return { config, issues, configSource };
}

export type AdapterMode = 'direct' | 'brokered';

export interface AdapterModeResolution {
  mode: AdapterMode;
  issues: SetupIssue[];
}

export function resolveAdapterMode(
  argv: string[],
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): AdapterModeResolution {
  const { values: cli } = parseArgs({
    args: argv,
    strict: false,
    options: {
      direct: { type: 'boolean' },
      broker: { type: 'boolean' },
    },
  });
  const issues: SetupIssue[] = [];
  const cliDirect = cli.direct === true;
  const cliBroker = cli.broker === true;

  if (cliDirect || cliBroker) {
    if (cliDirect && cliBroker) {
      issues.push({
        code: 'E_INVALID_PARAMS',
        message: 'Both --direct and --broker were provided; using direct mode.',
      });
    }
    return { mode: cliDirect ? 'direct' : 'brokered', issues };
  }

  const envDirect = env[`${ENV_PREFIX}DIRECT`] === '1';
  const envBroker = env[`${ENV_PREFIX}BROKER`] === '1';
  if (envDirect || envBroker) {
    if (envDirect && envBroker) {
      issues.push({
        code: 'E_INVALID_PARAMS',
        message: 'Both BLOCKBENCH_MCP_DIRECT and BLOCKBENCH_MCP_BROKER are set to 1; using direct mode.',
      });
    }
    return { mode: envDirect ? 'direct' : 'brokered', issues };
  }

  return { mode: platform === 'win32' ? 'direct' : 'brokered', issues };
}
