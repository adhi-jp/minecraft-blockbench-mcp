import { createHash } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

export function computeConfigIdentity(resolvedConfigPath: string): string {
  return createHash('sha256').update(resolvedConfigPath).digest('hex').slice(0, 16);
}

export interface RuntimeDirectoryOptions {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  configDir: string;
}

/**
 * Where the broker's socket, record and lock live for one config file. Only the
 * config directory and the product's own override decide it, never an ambient
 * variable such as XDG_RUNTIME_DIR: MCP harnesses pass their servers different
 * environments, and every client of one config file must find the same broker.
 */
export function resolveRuntimeDirectory(options: RuntimeDirectoryOptions): string {
  const pathApi = options.platform === 'win32' ? win32 : posix;
  const override = options.env.BLOCKBENCH_MCP_RUNTIME_DIR;
  if (override !== undefined && override.trim() !== '' && pathApi.isAbsolute(override)) {
    return pathApi.join(override, 'minecraft-blockbench-mcp');
  }
  return pathApi.join(options.configDir, 'run');
}

export async function ensureRuntimeDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    await chmod(dir, 0o700);
  }
}

export interface IpcEndpointOptions {
  platform: NodeJS.Platform;
  runtimeDir: string;
  identity: string;
}

export const MAX_UNIX_SOCKET_PATH_LENGTH = 103;

export class UnixSocketPathTooLongError extends Error {
  constructor(composedPath: string, measuredByteLength: number, maxByteLength: number) {
    super(
      `The Unix socket path ${composedPath} is ${String(measuredByteLength)} bytes, the limit is ${String(maxByteLength)}. ` +
        'Use the --direct CLI flag or set BLOCKBENCH_MCP_DIRECT=1 to use direct mode, or set BLOCKBENCH_MCP_RUNTIME_DIR to a short absolute path.',
    );
    this.name = 'UnixSocketPathTooLongError';
  }
}

export function ipcEndpointFor(options: IpcEndpointOptions): string {
  if (options.platform === 'win32') {
    return `\\\\.\\pipe\\minecraft-blockbench-mcp-${options.identity}`;
  }
  const composedPath = posix.join(options.runtimeDir, `broker-${options.identity}.sock`);
  const measuredByteLength = Buffer.byteLength(composedPath, 'utf8');
  if (measuredByteLength > MAX_UNIX_SOCKET_PATH_LENGTH) {
    throw new UnixSocketPathTooLongError(composedPath, measuredByteLength, MAX_UNIX_SOCKET_PATH_LENGTH);
  }
  return composedPath;
}
