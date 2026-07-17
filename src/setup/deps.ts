// Environment wiring for the setup/doctor CLI. Every effectful operation sits
// behind SetupDeps so the command logic in run.ts stays testable with fakes.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

import { resolveDefaultConfigPath } from '../shared/config-path.js';
import { checkAdapterHealth, type HealthState } from './health-check.js';
import { createRealFullAutoDeps, runFullAuto } from './full-auto.js';

export interface ClaudeResult {
  /** null when the binary could not be spawned at all. */
  status: number | null;
  stdout: string;
  stderr: string;
  missing: boolean;
}

export interface SetupDeps {
  env: Record<string, string | undefined>;
  osPlatform: NodeJS.Platform;
  isWsl: boolean;
  /** Absolute path of the running dist/adapter/cli.js entry. */
  cliJsPath: string;
  out: (line: string) => void;
  runClaude: (args: string[]) => ClaudeResult;
  /** Pipes the secret to a clipboard tool via stdin; never via argv. */
  copyToClipboard: (secret: string) => { ok: boolean; tool?: string };
  fileExists: (path: string) => boolean;
  readTextFile: (path: string) => string;
  /** Atomic write; file is never readable by other users on POSIX. */
  writeSecretFile: (path: string, content: string) => void;
  deleteFile: (path: string) => void;
  probePort: (port: number) => Promise<'free' | 'held'>;
  checkHealth: (configPath: string, options?: { waitMs?: number }) => Promise<HealthState>;
  /** WSL-only translation to \\wsl.localhost notation; null when unavailable. */
  toWindowsPath: (path: string) => string | null;
  /** Launches and provisions Blockbench over CDP; see src/setup/full-auto.ts. */
  runFullAuto: (context: {
    pluginPath: string;
    port: number;
    secret: string;
    blockbenchPathOverride?: string | undefined;
  }) => Promise<'provisioned' | 'unsupported' | 'aborted'>;
}

function detectWsl(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    return readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
}

export function createRealDeps(cliJsPath: string): SetupDeps {
  const isWsl = detectWsl();
  const toWindowsPath = (path: string): string | null => {
    const viaTool = spawnSync('wslpath', ['-w', path], { encoding: 'utf8' });
    if (viaTool.error === undefined && viaTool.status === 0 && viaTool.stdout.trim() !== '') {
      return viaTool.stdout.trim();
    }
    const distro = process.env.WSL_DISTRO_NAME;
    if (distro !== undefined && distro !== '') {
      return `\\\\wsl.localhost\\${distro}${path.replaceAll('/', '\\')}`;
    }
    return null;
  };
  // Piping the CLI into `head` or a pager closes stdout early; exit quietly
  // instead of crashing with an unhandled EPIPE.
  process.stdout.once('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0);
  });
  return {
    env: process.env,
    osPlatform: process.platform,
    isWsl,
    cliJsPath,
    out: (line) => process.stdout.write(`${line}\n`),
    runClaude: (args) => {
      let result = spawnSync('claude', args, { encoding: 'utf8' });
      if (result.error !== undefined && process.platform === 'win32') {
        // npm installs expose `claude.cmd`, which Node cannot spawn without a
        // shell. Quote arguments that carry spaces (e.g. config paths).
        const quoted = args.map((arg) => (/[\s"]/.test(arg) ? `"${arg.replaceAll('"', '""')}"` : arg)).join(' ');
        result = spawnSync(`claude ${quoted}`, { encoding: 'utf8', shell: true, windowsHide: true });
      }
      return {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        missing: result.error !== undefined && (result.error as NodeJS.ErrnoException).code === 'ENOENT',
      };
    },
    copyToClipboard: (secret) => {
      const candidates = isWsl
        ? ['clip.exe']
        : process.platform === 'darwin'
          ? ['pbcopy']
          : process.platform === 'win32'
            ? ['clip']
            : ['wl-copy', 'xclip'];
      for (const tool of candidates) {
        const args = tool === 'xclip' ? ['-selection', 'clipboard'] : [];
        const result = spawnSync(tool, args, { input: secret });
        if (result.error === undefined && result.status === 0) return { ok: true, tool };
      }
      return { ok: false };
    },
    fileExists: (path) => existsSync(path),
    readTextFile: (path) => readFileSync(path, 'utf8'),
    writeSecretFile: (path, content) => {
      mkdirSync(dirname(path), { recursive: true });
      const tempPath = `${path}.tmp`;
      writeFileSync(tempPath, content, { mode: 0o600 });
      if (process.platform !== 'win32') chmodSync(tempPath, 0o600);
      renameSync(tempPath, path);
    },
    deleteFile: (path) => unlinkSync(path),
    probePort: (port) =>
      new Promise((resolve) => {
        const server = createServer();
        server.once('error', (error) =>
          resolve((error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? 'held' : 'free'),
        );
        server.listen({ host: '127.0.0.1', port }, () => {
          server.close(() => resolve('free'));
        });
      }),
    checkHealth: (configPath, options) => checkAdapterHealth(cliJsPath, configPath, options),
    toWindowsPath,
    runFullAuto: (context) => {
      const out = (line: string) => process.stdout.write(`${line}\n`);
      const fullAutoDeps = createRealFullAutoDeps(
        {
          osPlatform: process.platform,
          isWsl,
          blockbenchPathOverride: context.blockbenchPathOverride,
          toWindowsPath,
        },
        out,
      );
      return runFullAuto(fullAutoDeps, context);
    },
  };
}

/** Per-platform location of the shared config file, resolved from the
 * environment with the process home directory as a last resort. The Blockbench
 * plugin reads the same file (deriving the base from its userData directory),
 * so the path must stay stable. */
export function resolveConfigPath(deps: Pick<SetupDeps, 'env' | 'osPlatform'>): string {
  const resolved = resolveDefaultConfigPath({
    platform: deps.osPlatform,
    xdgConfigHome: deps.env.XDG_CONFIG_HOME,
    home: deps.env.HOME ?? homedir(),
    appData: deps.env.APPDATA,
    userProfile: deps.env.USERPROFILE ?? homedir(),
  });
  // Unreachable in practice: homedir() always supplies a base.
  if (resolved === null) throw new Error('could not resolve the per-user config directory');
  return resolved;
}
