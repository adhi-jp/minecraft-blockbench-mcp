// Full-auto provisioning: launch Blockbench with a loopback CDP port and
// install the plugin + connection settings through Blockbench's own runtime
// APIs. Effects are injected so the orchestration is unit-testable; the secret
// travels only inside the CDP payload (never argv, never a script file).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { evaluateOnPage, fetchCdpVersion } from './cdp-client.js';
import { WINDOWS_DRIVER_SCRIPT, extractEvaluateValue, parseDriverOutput } from './windows-driver.js';

export type FullAutoTarget = 'posix-local' | 'windows-local' | 'windows-interop' | 'unsupported';

export interface FullAutoDeps {
  target: FullAutoTarget;
  /** Resolves the Blockbench binary in the target OS's own path notation. */
  discoverBinary: () => string | null;
  /** Receives the resolved binary so the running check can match its name. */
  isBlockbenchRunning: (binaryPath: string) => Promise<boolean>;
  launch: (binaryPath: string, args: string[]) => Promise<{ ok: boolean; error?: string }>;
  fetchVersion: (cdpPort: number) => Promise<{ ok: boolean; versionBody: string; error?: string }>;
  evaluate: (cdpPort: number, payload: string) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
  /** Translates a WSL path into the target OS's notation (identity locally). */
  pathForTarget: (path: string) => string | null;
  pickCdpPort: () => number;
  out: (line: string) => void;
}

export interface FullAutoContext {
  pluginPath: string;
  port: number;
  secret: string;
  blockbenchPathOverride?: string | undefined;
  extraBlockbenchArgs?: string[] | undefined;
  skipRunningCheck?: boolean | undefined;
}

export type FullAutoOutcome = 'provisioned' | 'unsupported' | 'aborted';

/**
 * The runtime calls proven live against retail Blockbench 5.1.4. The port and
 * secret are seeded into Settings.stored *before* the plugin loads so its
 * settings constructors pick them up and the session connects from the settings
 * source — this avoids the plugin's on-load config-file permission dialog, which
 * is a synchronous native dialog that would otherwise block the CDP evaluate.
 */
export function buildFullAutoPayload(details: { pluginPath: string; port: number; secret: string }): string {
  const portJson = JSON.stringify(details.port);
  const secretJson = JSON.stringify(details.secret);
  return `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 240 && (typeof Plugins === 'undefined' || typeof Plugin === 'undefined' || typeof settings === 'undefined' || typeof Settings === 'undefined'); i++) await wait(500);
  if (typeof Plugin === 'undefined' || typeof settings === 'undefined' || typeof Settings === 'undefined') return JSON.stringify({ ok: false, stage: 'boot-timeout' });
  Settings.stored = Settings.stored || {};
  Settings.stored['minecraft_blockbench_mcp_port'] = { value: ${portJson} };
  Settings.stored['minecraft_blockbench_mcp_secret'] = { value: ${secretJson} };
  const path = ${JSON.stringify(details.pluginPath)};
  try {
    await new Plugin().loadFromFile({ path, name: path, content: '' }, false);
  } catch (e) {
    return JSON.stringify({ ok: false, stage: 'load', error: String((e && e.message) || e) });
  }
  if (!settings.minecraft_blockbench_mcp_port || !settings.minecraft_blockbench_mcp_secret) {
    return JSON.stringify({ ok: false, stage: 'settings-missing' });
  }
  settings.minecraft_blockbench_mcp_port.set(${portJson});
  settings.minecraft_blockbench_mcp_secret.set(${secretJson});
  return JSON.stringify({ ok: true });
})()`;
}

function parsePayloadResult(value: unknown): { ok: boolean; stage?: string; error?: string } {
  if (typeof value !== 'string') return { ok: false, stage: 'no-result' };
  try {
    return JSON.parse(value) as { ok: boolean; stage?: string; error?: string };
  } catch {
    return { ok: false, stage: 'unparseable-result' };
  }
}

export async function runFullAuto(deps: FullAutoDeps, context: FullAutoContext): Promise<FullAutoOutcome> {
  if (deps.target === 'unsupported') {
    deps.out('Full-auto provisioning is not available on this platform yet — finish with the manual steps below.');
    return 'unsupported';
  }

  const binaryPath = context.blockbenchPathOverride ?? deps.discoverBinary();
  if (binaryPath === null) {
    deps.out('No Blockbench binary found — pass --blockbench-path <path to the Blockbench executable>.');
    return 'aborted';
  }

  if (context.skipRunningCheck !== true && (await deps.isBlockbenchRunning(binaryPath))) {
    deps.out('Blockbench is already running — close it and rerun `setup --full-auto` (an existing instance is never relaunched or killed).');
    return 'aborted';
  }

  const targetPluginPath = deps.pathForTarget(context.pluginPath);
  if (targetPluginPath === null) {
    deps.out('The plugin bundle path could not be translated for the target system.');
    return 'aborted';
  }

  const cdpPort = deps.pickCdpPort();
  deps.out(`Launching Blockbench (${binaryPath}) with a loopback DevTools port to provision it...`);
  const launched = await deps.launch(binaryPath, [
    `--remote-debugging-port=${cdpPort}`,
    ...(context.extraBlockbenchArgs ?? []),
  ]);
  if (!launched.ok) {
    deps.out(`Launching Blockbench failed: ${launched.error ?? 'unknown error'} — finish with the manual steps below.`);
    return 'aborted';
  }

  const version = await deps.fetchVersion(cdpPort);
  if (!version.ok) {
    deps.out(`Blockbench's DevTools endpoint never answered (${version.error ?? 'timeout'}) — if Blockbench opened, finish with the manual steps below.`);
    return 'aborted';
  }
  if (!version.versionBody.includes('Blockbench')) {
    deps.out('The DevTools endpoint does not identify as Blockbench — refusing to drive it.');
    return 'aborted';
  }

  const evaluated = await deps.evaluate(cdpPort, buildFullAutoPayload({
    pluginPath: targetPluginPath,
    port: context.port,
    secret: context.secret,
  }));
  const payloadResult = evaluated.ok ? parsePayloadResult(evaluated.result) : { ok: false, stage: 'cdp', error: evaluated.error };
  if (!payloadResult.ok) {
    deps.out(
      `Provisioning inside Blockbench failed (${payloadResult.stage ?? 'unknown'}${payloadResult.error !== undefined ? `: ${payloadResult.error}` : ''}) — Blockbench may be running unconfigured; finish with the manual steps below.`,
    );
    return 'aborted';
  }

  deps.out('Blockbench provisioned: plugin installed and connection settings applied — no clicks needed.');
  deps.out('Note: the DevTools port stays open until this Blockbench instance exits; restart Blockbench after provisioning to close it.');
  return 'provisioned';
}

// --- Real-environment wiring -------------------------------------------------

export type InteropRunner = (
  args: string[],
  input?: string,
  timeoutMs?: number,
) => { status: number | null; stdout: string; stderr: string };

export interface RealFullAutoOptions {
  osPlatform: NodeJS.Platform;
  isWsl: boolean;
  blockbenchPathOverride?: string | undefined;
  toWindowsPath: (path: string) => string | null;
  /** Test seam: replaces the real powershell.exe invocation. */
  interopRunner?: InteropRunner | undefined;
  /** Test seam: skips the interop TEMP probe. */
  windowsTempDirDrvfs?: string | undefined;
}

const realInteropRunner: InteropRunner = (args, input, timeoutMs) => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], {
    encoding: 'utf8',
    input,
    timeout: timeoutMs,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

function windowsTempDirViaDrvfs(runner: InteropRunner): string | null {
  const probe = runner(['-Command', "[System.Environment]::GetEnvironmentVariable('TEMP')"]);
  const windowsTemp = probe.stdout.trim();
  if (probe.status !== 0 || windowsTemp === '') return null;
  const wsl = spawnSync('wslpath', [windowsTemp], { encoding: 'utf8' });
  const path = wsl.stdout.trim();
  return wsl.status === 0 && path !== '' ? path : null;
}

export function resolveFullAutoTarget(options: RealFullAutoOptions): FullAutoTarget {
  if (options.osPlatform === 'win32') return 'windows-local';
  if (options.osPlatform === 'linux' && !options.isWsl) return 'posix-local';
  if (options.isWsl) {
    // An explicit POSIX path targets a Linux (WSLg) Blockbench; the default is
    // the Windows-native installation driven over interop.
    if (options.blockbenchPathOverride !== undefined && options.blockbenchPathOverride.startsWith('/')) {
      return 'posix-local';
    }
    return 'windows-interop';
  }
  return 'unsupported';
}

export function createRealFullAutoDeps(options: RealFullAutoOptions, out: (line: string) => void): FullAutoDeps {
  const target = resolveFullAutoTarget(options);
  const runner = options.interopRunner ?? realInteropRunner;

  const interopDriver = () => {
    // The script is constant text (no secret); it lives in the Windows %TEMP%
    // for the duration of the run and is deleted in the finally path.
    const tempDir = options.windowsTempDirDrvfs ?? windowsTempDirViaDrvfs(runner);
    if (tempDir === null) throw new Error('could not resolve the Windows temp directory via interop');
    const scriptDirDrvfs = mkdtempSync(join(tempDir, 'bbmcp-driver-'));
    const scriptDrvfs = join(scriptDirDrvfs, 'bbmcp-cdp-driver.ps1');
    writeFileSync(scriptDrvfs, WINDOWS_DRIVER_SCRIPT, 'utf8');
    const windowsScript = options.toWindowsPath(scriptDrvfs) ?? scriptDrvfs;
    return {
      run: (args: string[], input?: string, timeoutMs?: number) => runner(['-File', windowsScript, ...args], input, timeoutMs),
      cleanup: () => {
        try {
          unlinkSync(scriptDrvfs);
          rmSync(scriptDirDrvfs, { recursive: true, force: true });
        } catch {
          // Temp cleanup is best-effort.
        }
      },
    };
  };

  if (target === 'windows-interop') {
    return {
      target,
      discoverBinary: () => {
        const probe = runner(['-Command', `if (Test-Path "$env:LOCALAPPDATA\\Programs\\Blockbench\\Blockbench.exe") { "$env:LOCALAPPDATA\\Programs\\Blockbench\\Blockbench.exe" }`]);
        const found = probe.stdout.trim();
        return probe.status === 0 && found !== '' ? found : null;
      },
      isBlockbenchRunning: async () => {
        const probe = runner(['-Command', 'Get-Process -Name Blockbench -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count']);
        return Number(probe.stdout.trim()) > 0;
      },
      launch: async (binaryPath, args) => {
        const argList = args.map((arg) => `'${arg.replaceAll("'", "''")}'`).join(',');
        const result = runner(['-Command', `Start-Process -FilePath '${binaryPath.replaceAll("'", "''")}' -ArgumentList ${argList}`]);
        return result.status === 0 ? { ok: true } : { ok: false, error: result.stderr.trim() || `powershell exit ${result.status}` };
      },
      fetchVersion: async (cdpPort) => {
        let driver: ReturnType<typeof interopDriver> | undefined;
        try {
          driver = interopDriver();
          const run = driver.run([String(cdpPort), 'version', '90'], undefined, 130_000);
          const parsed = parseDriverOutput(run.stdout);
          return parsed.ok && parsed.versionBody !== undefined
            ? { ok: true, versionBody: parsed.versionBody }
            : { ok: false, versionBody: '', error: parsed.error ?? run.stderr.trim() };
        } catch (error) {
          return { ok: false, versionBody: '', error: error instanceof Error ? error.message : String(error) };
        } finally {
          driver?.cleanup();
        }
      },
      evaluate: async (cdpPort, payload) => {
        let driver: ReturnType<typeof interopDriver> | undefined;
        try {
          driver = interopDriver();
          const run = driver.run([String(cdpPort), 'evaluate', '180'], payload, 220_000);
          const parsed = parseDriverOutput(run.stdout);
          if (!parsed.ok || parsed.response === undefined) {
            return { ok: false, error: parsed.error ?? (run.stderr.trim() || 'driver failed') };
          }
          return { ok: true, result: extractEvaluateValue(parsed.response) };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        } finally {
          driver?.cleanup();
        }
      },
      pathForTarget: options.toWindowsPath,
      pickCdpPort: () => 42000 + Math.floor(Math.random() * 3000),
      out,
    };
  }

  return {
    target,
    discoverBinary: () => {
      if (target === 'windows-local') {
        const localAppData = process.env.LOCALAPPDATA;
        if (localAppData !== undefined) {
          const candidate = join(localAppData, 'Programs', 'Blockbench', 'Blockbench.exe');
          if (existsSync(candidate)) return candidate;
        }
        return null;
      }
      const which = spawnSync('which', ['blockbench'], { encoding: 'utf8' });
      const found = which.stdout.trim();
      return which.status === 0 && found !== '' ? found : null;
    },
    isBlockbenchRunning: async (binaryPath) => {
      if (target === 'windows-local') {
        const probe = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Blockbench.exe', '/NH'], { encoding: 'utf8' });
        return probe.stdout.toLowerCase().includes('blockbench.exe');
      }
      // Match the executable's own process name (comm), not an -f substring:
      // the setup CLI's cmdline contains the package path and would otherwise
      // match itself. Electron truncates comm to 15 chars.
      const processName = (binaryPath.split('/').pop() ?? 'blockbench').slice(0, 15);
      const probe = spawnSync('pgrep', ['-x', processName], { encoding: 'utf8' });
      return probe.status === 0 && probe.stdout.trim() !== '';
    },
    launch: async (binaryPath, args) => {
      try {
        const child = spawn(binaryPath, args, { detached: true, stdio: 'ignore' });
        child.unref();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    fetchVersion: (cdpPort) => fetchCdpVersion(cdpPort),
    evaluate: (cdpPort, payload) => evaluateOnPage(cdpPort, payload),
    pathForTarget: (path) => path,
    pickCdpPort: () => 42000 + Math.floor(Math.random() * 3000),
    out,
  };
}
