// Adapter configuration loading.
// Precedence: CLI arguments > environment variables > JSON config file
// (path given by --config / BLOCKBENCH_MCP_CONFIG only; no implicit default
// path) > built-in defaults.
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
  handshakeTimeoutMs: 5_000,
  maxMessageBytes: DEFAULTS.maxMessageBytes,
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
];

export function loadConfig(
  argv: string[],
  env: Record<string, string | undefined>,
  readFile: (path: string) => string,
): { config: AdapterConfig; issues: SetupIssue[] } {
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
    },
  });

  // Config file layer (lowest precedence above defaults).
  let fileValues: Record<string, unknown> = {};
  const configPath =
    (typeof cli.config === 'string' ? cli.config : undefined) ?? env[`${ENV_PREFIX}CONFIG`] ?? undefined;
  if (configPath !== undefined && configPath !== '') {
    let raw: string | null = null;
    try {
      raw = readFile(configPath);
    } catch (error) {
      // Report only the error code, never the message: fs/parser messages can
      // echo file content, and the file may contain the shared secret.
      const code = (error as NodeJS.ErrnoException).code ?? 'read error';
      issues.push({
        code: 'E_INVALID_PARAMS',
        message: `Config file could not be read: ${configPath} (${code})`,
      });
    }
    if (raw !== null) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          fileValues = parsed as Record<string, unknown>;
        } else {
          issues.push({ code: 'E_INVALID_PARAMS', message: `Config file must contain a JSON object: ${configPath}` });
        }
      } catch (error) {
        // JSON.parse messages embed raw input snippets; keep only a position hint.
        const position = error instanceof Error ? /at position \d+/.exec(error.message)?.[0] : undefined;
        issues.push({
          code: 'E_INVALID_PARAMS',
          message: `Config file is not valid JSON: ${configPath}${position !== undefined ? ` (${position})` : ''}`,
        });
      }
    }
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

  return { config, issues };
}
