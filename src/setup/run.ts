// Command logic for `minecraft-blockbench-mcp setup` and `doctor`. All effects
// go through SetupDeps (see deps.ts) so the complete flows are testable with
// fakes. The shared secret is written only to the 0600 config file and shown
// only behind the explicit --show-secret / --clipboard opt-ins.
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

import { DEFAULT_WS_PORT } from '../shared/protocol.js';
import { createRealDeps, resolveConfigPath, type SetupDeps } from './deps.js';
import type { HealthState } from './health-check.js';
import type { Subcommand } from './route.js';

const SERVER_NAME = 'blockbench';
const MASKED_SECRET = '********';

export { routeCli } from './route.js';
export type { Subcommand } from './route.js';

export interface SetupFlags {
  scope: 'project' | 'user' | 'local';
  port: number | undefined;
  replace: boolean;
  rotateSecret: boolean;
  showSecret: boolean;
  clipboard: boolean;
  uninstall: boolean;
  waitSeconds: number;
}

function usage(out: (line: string) => void): void {
  out('Usage:');
  out('  minecraft-blockbench-mcp setup  [--scope project|user|local] [--port <n>] [--replace]');
  out('                                  [--rotate-secret] [--show-secret] [--clipboard]');
  out('                                  [--wait <seconds>] [--uninstall]');
  out('  minecraft-blockbench-mcp doctor [--wait <seconds>]');
}

export function parseFlags(argv: string[]): { flags: SetupFlags } | { error: string } {
  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        scope: { type: 'string' },
        port: { type: 'string' },
        replace: { type: 'boolean' },
        'rotate-secret': { type: 'boolean' },
        'show-secret': { type: 'boolean' },
        clipboard: { type: 'boolean' },
        uninstall: { type: 'boolean' },
        wait: { type: 'string' },
      },
    }));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  const scope = (values.scope as string | undefined) ?? 'project';
  if (scope !== 'project' && scope !== 'user' && scope !== 'local') {
    return { error: `Invalid --scope "${scope}": expected project, user, or local.` };
  }
  let port: number | undefined;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return { error: `Invalid --port "${String(values.port)}": expected an integer in [1, 65535].` };
    }
  }
  let waitSeconds = 0;
  if (values.wait !== undefined) {
    waitSeconds = Number(values.wait);
    if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 3600) {
      return { error: `Invalid --wait "${String(values.wait)}": expected an integer in [0, 3600].` };
    }
  }
  return {
    flags: {
      scope,
      port,
      replace: values.replace === true,
      rotateSecret: values['rotate-secret'] === true,
      showSecret: values['show-secret'] === true,
      clipboard: values.clipboard === true,
      uninstall: values.uninstall === true,
      waitSeconds,
    },
  };
}

export function packageRootFromCli(cliJsPath: string): string {
  // dist/adapter/cli.js -> package root is two directories up from dist/adapter.
  return dirname(dirname(dirname(cliJsPath)));
}

export function isNpmCachePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return ['/_npx/', '/_cacache/', '/npm-cache/'].some((marker) => normalized.includes(marker));
}

function isInstalledMode(packageRoot: string): boolean {
  return packageRoot.replaceAll('\\', '/').includes('/node_modules/');
}

interface ConfigRead {
  kind: 'missing' | 'corrupt' | 'valid';
  secret?: string;
  port?: number;
}

function readConfigFile(deps: SetupDeps, path: string): ConfigRead {
  if (!deps.fileExists(path)) return { kind: 'missing' };
  try {
    const parsed: unknown = JSON.parse(deps.readTextFile(path));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'corrupt' };
    const record = parsed as Record<string, unknown>;
    const rawPort = record.port;
    // Salvage an in-range port even from otherwise unusable files so a rewrite
    // does not silently move the adapter off the port Blockbench is set to.
    const port =
      typeof rawPort === 'number' && Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65_535
        ? rawPort
        : undefined;
    if (typeof record.secret !== 'string' || record.secret === '') return { kind: 'corrupt', port };
    return { kind: 'valid', secret: record.secret, port };
  } catch {
    return { kind: 'corrupt' };
  }
}

function renderManualSteps(
  deps: SetupDeps,
  details: { pluginPath: string; port: number; configPath: string; secret: string; showSecret: boolean },
): void {
  deps.out('');
  deps.out('Next steps in Blockbench:');
  deps.out('  1. File → Plugins → Load Plugin from File');
  deps.out(`     Select: ${details.pluginPath}`);
  if (deps.isWsl) {
    const windowsPath = deps.toWindowsPath(details.pluginPath);
    if (windowsPath !== null) {
      deps.out(`     Windows path (when Blockbench runs on Windows): ${windowsPath}`);
    } else {
      deps.out('     (Windows path unavailable: wslpath and WSL_DISTRO_NAME are both missing)');
    }
  }
  deps.out('  2. File → Preferences → Settings → General');
  deps.out(`     MCP Adapter Port: ${details.port}`);
  deps.out(`     MCP Shared Secret: ${details.showSecret ? details.secret : MASKED_SECRET}`);
  if (!details.showSecret) {
    deps.out('     (rerun with --show-secret to display it, or --clipboard to copy it)');
  }
  deps.out('');
  deps.out(`The shared secret is stored in ${details.configPath}.`);
}

function renderHealthState(deps: SetupDeps, state: HealthState, port: number): void {
  switch (state.state) {
    case 'broken': {
      deps.out('Adapter check failed:');
      for (const code of state.codes) {
        if (code === 'E_SECRET_MISSING') {
          deps.out('  - The adapter has no shared secret — rerun `minecraft-blockbench-mcp setup`.');
        } else if (code === 'E_LISTENER_FAILED') {
          deps.out('  - The adapter could not create its loopback listener — check local network permissions and platform policy, then restart.');
        } else if (code === 'E_INVALID_PARAMS') {
          deps.out('  - The adapter rejected its configuration — inspect the config file, or rerun setup with --rotate-secret to rewrite it.');
        } else {
          deps.out(`  - ${code}`);
        }
      }
      break;
    }
    case 'port-held':
      deps.out(
        `Port ${port} is busy — likely your registered adapter is already running, so plugin connectivity is not observable from this probe. If Blockbench shows "MCP adapter connected", everything is working.`,
      );
      break;
    case 'waiting':
      deps.out('Adapter is healthy and waiting for the Blockbench plugin to connect.');
      break;
    case 'connected':
      deps.out('Fully connected — the Blockbench plugin is talking to the adapter.');
      break;
  }
}

function stateExitCode(state: HealthState): number {
  return state.state === 'broken' ? 1 : 0;
}

function registrationLookup(deps: SetupDeps): { missingCli: boolean; exists: boolean; detail: string } {
  const result = deps.runClaude(['mcp', 'get', SERVER_NAME]);
  return { missingCli: result.missing, exists: result.status === 0, detail: result.stdout.trim() };
}

async function runUninstall(deps: SetupDeps, flags: SetupFlags): Promise<number> {
  let failed = false;
  const configPath = resolveConfigPath(deps);
  const registration = registrationLookup(deps);
  const registrationMatches =
    registration.exists &&
    registration.detail.includes(`BLOCKBENCH_MCP_CONFIG=${configPath}`) &&
    registration.detail.includes(deps.cliJsPath);
  if (registration.missingCli) {
    deps.out('The `claude` CLI was not found on PATH — cannot remove the MCP registration.');
    failed = true;
  } else if (!registration.exists) {
    deps.out(`No "${SERVER_NAME}" MCP registration found.`);
  } else if (!registrationMatches) {
    // Only remove what setup created; a same-named entry pointing elsewhere
    // stays untouched.
    deps.out(`A "${SERVER_NAME}" MCP registration exists but does not point at this installation — leaving it in place:`);
    for (const line of registration.detail.split('\n')) deps.out(`  ${line}`);
    deps.out(`  Remove it manually with: claude mcp remove ${SERVER_NAME} -s <scope>`);
  } else {
    const removal = deps.runClaude(['mcp', 'remove', SERVER_NAME, '--scope', flags.scope]);
    if (removal.status === 0) {
      deps.out(`Removed the "${SERVER_NAME}" MCP registration (scope: ${flags.scope}).`);
    } else {
      const scopeLine = /Scope:\s*([^\n]+)/.exec(registration.detail)?.[1]?.trim();
      deps.out(`Could not remove the "${SERVER_NAME}" registration at scope "${flags.scope}".`);
      if (scopeLine !== undefined) {
        deps.out(`  The registration reports: Scope: ${scopeLine}`);
      }
      deps.out(`  Remove it manually with: claude mcp remove ${SERVER_NAME} -s <scope>`);
      failed = true;
    }
  }

  if (deps.fileExists(configPath)) {
    deps.deleteFile(configPath);
    deps.out(`Deleted the config file ${configPath}.`);
  } else {
    deps.out(`No config file at ${configPath}.`);
  }

  deps.out('Left in place (remove manually if desired):');
  deps.out('  - The Blockbench-side plugin and its settings (File → Plugins to remove the plugin).');
  deps.out('  - This package installation directory.');
  return failed ? 1 : 0;
}

export async function runSetup(deps: SetupDeps, flags: SetupFlags): Promise<number> {
  if (flags.uninstall) return runUninstall(deps, flags);

  // Preflights: nothing below changes any state until every check passes.
  const claudeProbe = deps.runClaude(['--version']);
  if (claudeProbe.missing) {
    deps.out('The `claude` CLI was not found on PATH. Install Claude Code first: https://claude.com/claude-code');
    return 1;
  }

  const packageRoot = packageRootFromCli(deps.cliJsPath);
  const pluginPath = join(packageRoot, 'dist', 'plugin', 'minecraft_blockbench_mcp.js');
  if (!deps.fileExists(pluginPath) || !deps.fileExists(deps.cliJsPath)) {
    deps.out(
      isInstalledMode(packageRoot)
        ? `The package runtime files are missing under ${packageRoot} — reinstall @adhisang/minecraft-blockbench-mcp in a persistent directory.`
        : 'The dist output is missing or incomplete — run `npm run build` first.',
    );
    return 1;
  }

  if (isNpmCachePath(packageRoot)) {
    deps.out(`This command is running from the npm cache (${packageRoot}).`);
    deps.out('Blockbench keeps loading the plugin from its original path, so the files must live in a persistent directory.');
    deps.out('Install persistently, then rerun setup from inside that directory:');
    deps.out('  mkdir minecraft-blockbench-mcp && cd minecraft-blockbench-mcp');
    deps.out('  npm init -y && npm install @adhisang/minecraft-blockbench-mcp');
    deps.out('  npx minecraft-blockbench-mcp setup');
    return 1;
  }

  const configPath = resolveConfigPath(deps);
  const existing = readConfigFile(deps, configPath);
  if (existing.kind === 'corrupt' && !flags.rotateSecret) {
    deps.out(`The config file at ${configPath} is not usable (invalid JSON or empty secret).`);
    deps.out('Fix it manually, or rerun with --rotate-secret to replace it with a fresh secret.');
    return 1;
  }

  const port = flags.port ?? existing.port ?? DEFAULT_WS_PORT;
  const reuseSecret = existing.kind === 'valid' && !flags.rotateSecret;
  const secret = reuseSecret ? existing.secret! : randomBytes(16).toString('hex');
  const portChanged = existing.kind === 'valid' && (existing.port ?? DEFAULT_WS_PORT) !== port;
  const needConfigWrite = !reuseSecret || portChanged;

  const registration = registrationLookup(deps);
  // A registration is "ours" when it points at this config file and this CLI;
  // then re-runs can repair the config file without touching the registration.
  const registrationMatches =
    registration.exists &&
    registration.detail.includes(`BLOCKBENCH_MCP_CONFIG=${configPath}`) &&
    registration.detail.includes(deps.cliJsPath);

  // Idempotent no-op: nothing to write and our registration is already there.
  if (!needConfigWrite && registrationMatches && !flags.replace) {
    deps.out('Already configured — nothing changed.');
    deps.out(`Config file: ${configPath}`);
    if (flags.showSecret || flags.clipboard) {
      renderManualSteps(deps, { pluginPath, port, configPath, secret, showSecret: flags.showSecret });
      if (flags.clipboard) copySecret(deps, secret);
    }
    const state = await deps.checkHealth(configPath, { waitMs: flags.waitSeconds * 1000 });
    renderHealthState(deps, state, port);
    return stateExitCode(state);
  }

  if (registration.exists && !registrationMatches && !flags.replace) {
    deps.out(`An MCP server named "${SERVER_NAME}" is already registered with a different configuration:`);
    for (const line of registration.detail.split('\n')) deps.out(`  ${line}`);
    deps.out('Nothing was changed. Rerun with --replace to replace it, or remove it with `claude mcp remove blockbench`.');
    return 1;
  }

  const portState = await deps.probePort(port);
  if (portState === 'held' && !registration.exists) {
    deps.out(
      `Warning: port ${port} is already in use by another process. If it is not a Blockbench MCP adapter, rerun with --port <free port> and set the same port in Blockbench.`,
    );
  }

  if (needConfigWrite) {
    const content = `${JSON.stringify({ version: 1, mode: 'shared-secret', port, secret }, null, 2)}\n`;
    deps.writeSecretFile(configPath, content);
    deps.out(
      `Wrote ${configPath}${deps.osPlatform === 'win32' ? '' : ' (permissions 0600 — readable only by your user)'}.`,
    );
    if (!reuseSecret && (existing.kind !== 'missing' || registrationMatches)) {
      deps.out('Secret rotated — update "MCP Shared Secret" in Blockbench settings to the new value.');
    }
    if (portChanged) {
      deps.out(`Port changed to ${port} — update "MCP Adapter Port" in Blockbench settings to match.`);
    } else if (existing.kind === 'corrupt') {
      deps.out(`Port set to ${port} — ensure "MCP Adapter Port" in Blockbench settings matches.`);
    }
  }

  if (!registration.exists || (flags.replace && !registrationMatches)) {
    if (registration.exists && flags.replace) {
      const removal = deps.runClaude(['mcp', 'remove', SERVER_NAME, '--scope', flags.scope]);
      if (removal.status !== 0) {
        deps.out(`Could not replace the existing "${SERVER_NAME}" registration (scope: ${flags.scope}).`);
        deps.out(`  Remove it manually with: claude mcp remove ${SERVER_NAME} -s <scope>, then rerun setup.`);
        return 1;
      }
      deps.out(`Replaced the previous "${SERVER_NAME}" registration:`);
      for (const line of registration.detail.split('\n')) deps.out(`  ${line}`);
    }
    const addition = deps.runClaude([
      'mcp',
      'add',
      SERVER_NAME,
      '--scope',
      flags.scope,
      '-e',
      `BLOCKBENCH_MCP_CONFIG=${configPath}`,
      '--',
      'node',
      deps.cliJsPath,
    ]);
    if (addition.status !== 0) {
      deps.out('Registering the MCP server in Claude Code failed. The config file was written; register manually with:');
      deps.out(`  claude mcp add ${SERVER_NAME} --scope ${flags.scope} -e BLOCKBENCH_MCP_CONFIG=${configPath} -- node ${deps.cliJsPath}`);
      if (addition.stderr.trim() !== '') deps.out(`  (claude reported: ${addition.stderr.trim()})`);
      return 1;
    }
    deps.out(`Registered MCP server "${SERVER_NAME}" in Claude Code (scope: ${flags.scope}).`);
    if (flags.scope === 'project') {
      deps.out('  The project .mcp.json stores only the config file path — collaborators run setup themselves.');
    }
  }

  renderManualSteps(deps, { pluginPath, port, configPath, secret, showSecret: flags.showSecret });
  if (flags.clipboard) copySecret(deps, secret);

  const state = await deps.checkHealth(configPath, { waitMs: flags.waitSeconds * 1000 });
  renderHealthState(deps, state, port);
  return stateExitCode(state);
}

function copySecret(deps: SetupDeps, secret: string): void {
  const copied = deps.copyToClipboard(secret);
  if (copied.ok) {
    deps.out(`Copied the shared secret to the clipboard via ${copied.tool}. Note: clipboard managers may retain it.`);
  } else {
    deps.out('No clipboard tool found (tried the platform defaults) — rerun with --show-secret instead.');
  }
}

export async function runDoctor(deps: SetupDeps, flags: SetupFlags): Promise<number> {
  const configPath = resolveConfigPath(deps);
  if (!deps.fileExists(configPath)) {
    deps.out(`Config file: ${configPath} (missing)`);
    deps.out('Not configured — run `minecraft-blockbench-mcp setup` first.');
    return 1;
  }
  deps.out(`Config file: ${configPath}`);

  const existing = readConfigFile(deps, configPath);
  const port = existing.kind === 'valid' ? (existing.port ?? DEFAULT_WS_PORT) : DEFAULT_WS_PORT;

  const registration = registrationLookup(deps);
  if (registration.missingCli) {
    deps.out('The `claude` CLI was not found on PATH — skipping the registration check.');
  } else {
    deps.out(`Claude Code registration "${SERVER_NAME}": ${registration.exists ? 'found' : 'not found (run setup, or it may use another name)'}`);
  }

  const state = await deps.checkHealth(configPath, { waitMs: flags.waitSeconds * 1000 });
  renderHealthState(deps, state, port);
  return stateExitCode(state);
}

/** Entry used by dist/adapter/cli.js. Returns the process exit code. */
export async function runSetupCli(subcommand: Subcommand, argv: string[], cliJsPath: string): Promise<number> {
  const deps = createRealDeps(cliJsPath);
  // Running from a source checkout via tsx would register an unrunnable
  // `node .../cli.ts` command; only the built entry may configure anything.
  if (!cliJsPath.replaceAll('\\', '/').endsWith('/dist/adapter/cli.js')) {
    deps.out('setup and doctor must run from the built CLI (dist/adapter/cli.js).');
    deps.out('Use `npm run setup` in a checkout, or `npx minecraft-blockbench-mcp setup` in an installation directory.');
    return 1;
  }
  const parsed = parseFlags(argv);
  if ('error' in parsed) {
    deps.out(parsed.error);
    usage(deps.out);
    return 2;
  }
  try {
    return subcommand === 'setup' ? await runSetup(deps, parsed.flags) : await runDoctor(deps, parsed.flags);
  } catch (error) {
    deps.out(`Unexpected failure: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
