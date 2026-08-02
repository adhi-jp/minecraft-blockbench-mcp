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

export function resolveRuntimeDirectory(options: RuntimeDirectoryOptions): string {
  const pathApi = options.platform === 'win32' ? win32 : posix;
  const xdgRuntimeDir = options.env.XDG_RUNTIME_DIR;
  if (xdgRuntimeDir !== undefined && xdgRuntimeDir.trim() !== '' && pathApi.isAbsolute(xdgRuntimeDir)) {
    return pathApi.join(xdgRuntimeDir, 'minecraft-blockbench-mcp');
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

export function ipcEndpointFor(options: IpcEndpointOptions): string {
  if (options.platform === 'win32') {
    return `\\\\.\\pipe\\minecraft-blockbench-mcp-${options.identity}`;
  }
  return posix.join(options.runtimeDir, `broker-${options.identity}.sock`);
}
