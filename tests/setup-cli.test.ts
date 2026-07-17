// Tests for the `setup`/`doctor` CLI: full flows through fake SetupDeps
// (secret hygiene, idempotency, non-destructive registration, preflights,
// doctor states), plus integration checks that spawn the built adapter
// (dist/adapter/cli.js — `npm run build` must run before `npm test`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  isNpmCachePath,
  packageRootFromCli,
  parseFlags,
  routeCli,
  runDoctor,
  runSetup,
  runSetupCli,
  type SetupFlags,
} from '../src/setup/run.js';
import { createRealDeps, resolveConfigPath, type SetupDeps } from '../src/setup/deps.js';
import { checkAdapterHealth, type HealthState } from '../src/setup/health-check.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const builtCliPath = join(projectRoot, 'dist', 'adapter', 'cli.js');

const FAKE_CLI = '/repo/dist/adapter/cli.js';
const FAKE_PLUGIN = '/repo/dist/plugin/minecraft_blockbench_mcp.js';
const CONFIG_PATH = '/xdg/minecraft-blockbench-mcp/config.json';
const SENTINEL = 'sentinel-secret-4f2b9c81aa77de10';

interface FakeWorld {
  deps: SetupDeps;
  output: string[];
  files: Map<string, string>;
  writes: Array<{ path: string; content: string }>;
  deletes: string[];
  claudeCalls: string[][];
  clipboardInputs: string[];
}

interface FakeOptions {
  cliJsPath?: string;
  registrationDetail?: string | null;
  addStatus?: number;
  removeStatus?: number;
  claudeMissing?: boolean;
  health?: HealthState;
  portState?: 'free' | 'held';
  isWsl?: boolean;
  windowsPath?: string | null;
  existingConfig?: string;
  missingBundle?: boolean;
}

function ourRegistrationDetail(configPath: string, cliJsPath: string, scopeLine = 'Project config (shared via .mcp.json)'): string {
  return [
    'blockbench:',
    `  Scope: ${scopeLine}`,
    '  Type: stdio',
    '  Command: node',
    `  Args: ${cliJsPath}`,
    '  Environment:',
    `    BLOCKBENCH_MCP_CONFIG=${configPath}`,
  ].join('\n');
}

/** Asserts that neither the full secret nor a truncated prefix of it appears
 * anywhere in the captured output. */
function assertNoSecretLeak(world: FakeWorld, ...secrets: string[]): void {
  const text = allOutput(world);
  for (const secret of secrets) {
    assert.ok(!text.includes(secret), 'secret must not appear in output');
    assert.ok(!text.includes(secret.slice(0, 12)), 'secret prefix must not appear in output');
  }
}

function writtenSecret(world: FakeWorld, index = 0): string {
  return (JSON.parse(world.writes[index].content) as { secret: string }).secret;
}

function makeWorld(options: FakeOptions = {}): FakeWorld {
  const cliJsPath = options.cliJsPath ?? FAKE_CLI;
  const pluginPath = join(packageRootFromCli(cliJsPath), 'dist', 'plugin', 'minecraft_blockbench_mcp.js');
  const files = new Map<string, string>();
  if (options.missingBundle !== true) {
    files.set(cliJsPath, '// cli');
    files.set(pluginPath, '// plugin');
  }
  if (options.existingConfig !== undefined) files.set(CONFIG_PATH, options.existingConfig);

  const world: FakeWorld = {
    output: [],
    files,
    writes: [],
    deletes: [],
    claudeCalls: [],
    clipboardInputs: [],
    deps: undefined as unknown as SetupDeps,
  };

  world.deps = {
    env: { XDG_CONFIG_HOME: '/xdg', HOME: '/home/user' },
    osPlatform: 'linux',
    isWsl: options.isWsl ?? false,
    cliJsPath,
    out: (line) => world.output.push(line),
    runClaude: (args) => {
      world.claudeCalls.push(args);
      if (options.claudeMissing === true) return { status: null, stdout: '', stderr: '', missing: true };
      if (args[0] === '--version') return { status: 0, stdout: '1.0.0', stderr: '', missing: false };
      if (args[0] === 'mcp' && args[1] === 'get') {
        const detail = options.registrationDetail ?? null;
        return detail === null
          ? { status: 1, stdout: 'No MCP server named "blockbench".', stderr: '', missing: false }
          : { status: 0, stdout: detail, stderr: '', missing: false };
      }
      if (args[0] === 'mcp' && args[1] === 'add') {
        return { status: options.addStatus ?? 0, stdout: '', stderr: options.addStatus ? 'add failed' : '', missing: false };
      }
      if (args[0] === 'mcp' && args[1] === 'remove') {
        return { status: options.removeStatus ?? 0, stdout: '', stderr: '', missing: false };
      }
      return { status: 0, stdout: '', stderr: '', missing: false };
    },
    copyToClipboard: (secret) => {
      world.clipboardInputs.push(secret);
      return { ok: true, tool: 'fake-clip' };
    },
    fileExists: (path) => world.files.has(path),
    readTextFile: (path) => {
      const content = world.files.get(path);
      if (content === undefined) throw new Error(`missing file: ${path}`);
      return content;
    },
    writeSecretFile: (path, content) => {
      world.writes.push({ path, content });
      world.files.set(path, content);
    },
    deleteFile: (path) => {
      world.deletes.push(path);
      world.files.delete(path);
    },
    probePort: async () => options.portState ?? 'free',
    checkHealth: async () => options.health ?? { state: 'waiting', codes: [] },
    toWindowsPath: () => options.windowsPath ?? null,
  };
  return world;
}

function flags(overrides: Partial<SetupFlags> = {}): SetupFlags {
  return {
    scope: 'project',
    port: undefined,
    replace: false,
    rotateSecret: false,
    showSecret: false,
    clipboard: false,
    uninstall: false,
    waitSeconds: 0,
    ...overrides,
  };
}

function validConfig(secret = SENTINEL, port = 39731): string {
  return `${JSON.stringify({ version: 1, mode: 'shared-secret', port, secret }, null, 2)}\n`;
}

function allOutput(world: FakeWorld): string {
  return world.output.join('\n');
}

test('routeCli dispatches only the exact setup/doctor positionals at argv[2]', () => {
  assert.equal(routeCli('setup'), 'setup');
  assert.equal(routeCli('doctor'), 'doctor');
  assert.equal(routeCli(undefined), null);
  assert.equal(routeCli('--port'), null);
  assert.equal(routeCli('/models/pot.bbmodel'), null);
  assert.equal(routeCli('Setup'), null);
});

test('parseFlags rejects unknown flags, bad scope, bad port, bad wait', () => {
  assert.ok('error' in parseFlags(['--nope']));
  assert.ok('error' in parseFlags(['--scope', 'global']));
  assert.ok('error' in parseFlags(['--port', 'abc']));
  assert.ok('error' in parseFlags(['--wait', '-1']));
  const parsed = parseFlags(['--scope', 'user', '--port', '40000', '--replace']);
  assert.ok('flags' in parsed);
  assert.equal(parsed.flags.scope, 'user');
  assert.equal(parsed.flags.port, 40000);
  assert.equal(parsed.flags.replace, true);
});

test('runSetupCli returns exit code 2 on usage errors', async () => {
  assert.equal(await runSetupCli('setup', ['--nope'], builtCliPath), 2);
});

test('fresh setup writes a versioned config, registers with config-path env only, prints the manual steps', async () => {
  const world = makeWorld();
  const code = await runSetup(world.deps, flags());
  assert.equal(code, 0);

  assert.equal(world.writes.length, 1);
  assert.equal(world.writes[0].path, CONFIG_PATH);
  const written = JSON.parse(world.writes[0].content) as Record<string, unknown>;
  assert.equal(written.version, 1);
  assert.equal(written.mode, 'shared-secret');
  assert.equal(written.port, 39731);
  assert.match(written.secret as string, /^[0-9a-f]{32}$/);

  const addCall = world.claudeCalls.find((args) => args[1] === 'add');
  assert.deepEqual(addCall, [
    'mcp',
    'add',
    'blockbench',
    '--scope',
    'project',
    '-e',
    `BLOCKBENCH_MCP_CONFIG=${CONFIG_PATH}`,
    '--',
    'node',
    FAKE_CLI,
  ]);

  const text = allOutput(world);
  assert.match(text, /1\. File → Plugins → Load Plugin from File/);
  assert.match(text, /2\. File → Preferences → Settings → General/);
  assert.ok(text.includes(FAKE_PLUGIN));
  assertNoSecretLeak(world, written.secret as string);
  assert.match(text, /\*{8}/);
});

test('setup honors --scope user in registration args', async () => {
  const world = makeWorld();
  await runSetup(world.deps, flags({ scope: 'user' }));
  const addCall = world.claudeCalls.find((args) => args[1] === 'add');
  assert.ok(addCall?.includes('user'));
});

test('unchanged re-run is a no-op: no writes, no registration calls beyond the checks', async () => {
  const world = makeWorld({
    existingConfig: validConfig(),
    registrationDetail: ourRegistrationDetail(CONFIG_PATH, FAKE_CLI),
  });
  const code = await runSetup(world.deps, flags());
  assert.equal(code, 0);
  assert.equal(world.writes.length, 0);
  assert.equal(world.claudeCalls.filter((args) => args[1] === 'add' || args[1] === 'remove').length, 0);
  assert.match(allOutput(world), /Already configured — nothing changed\./);
  assertNoSecretLeak(world, SENTINEL);
});

test('a foreign blockbench registration aborts without any state change; --replace replaces it', async () => {
  const foreign = ourRegistrationDetail('/somewhere/else.json', '/other/cli.js');
  const abortWorld = makeWorld({ registrationDetail: foreign });
  const code = await runSetup(abortWorld.deps, flags());
  assert.equal(code, 1);
  assert.equal(abortWorld.writes.length, 0);
  assert.equal(abortWorld.claudeCalls.filter((args) => args[1] === 'add').length, 0);
  assert.match(allOutput(abortWorld), /already registered with a different configuration/);
  assert.match(allOutput(abortWorld), /--replace/);

  const replaceWorld = makeWorld({ registrationDetail: foreign });
  const replaceCode = await runSetup(replaceWorld.deps, flags({ replace: true }));
  assert.equal(replaceCode, 0);
  const calls = replaceWorld.claudeCalls.map((args) => args[1]);
  assert.ok(calls.includes('remove'));
  assert.ok(calls.includes('add'));
  assert.match(allOutput(replaceWorld), /Replaced the previous "blockbench" registration/);
  assert.ok(allOutput(replaceWorld).includes('/somewhere/else.json'), 'must say what was replaced');
  assertNoSecretLeak(replaceWorld, writtenSecret(replaceWorld));
});

test('a matching registration with a deleted config file recovers without --replace', async () => {
  const world = makeWorld({ registrationDetail: ourRegistrationDetail(CONFIG_PATH, FAKE_CLI) });
  const code = await runSetup(world.deps, flags());
  assert.equal(code, 0);
  assert.equal(world.writes.length, 1);
  assert.equal(world.claudeCalls.filter((args) => args[1] === 'add').length, 0, 'registration must be left untouched');
});

test('--rotate-secret regenerates the secret, keeps the port, and warns about Blockbench', async () => {
  const world = makeWorld({
    existingConfig: validConfig(SENTINEL, 40123),
    registrationDetail: ourRegistrationDetail(CONFIG_PATH, FAKE_CLI),
  });
  const code = await runSetup(world.deps, flags({ rotateSecret: true }));
  assert.equal(code, 0);
  const written = JSON.parse(world.writes[0].content) as Record<string, unknown>;
  assert.notEqual(written.secret, SENTINEL);
  assert.equal(written.port, 40123);
  assert.match(allOutput(world), /Secret rotated — update "MCP Shared Secret" in Blockbench settings/);
  assertNoSecretLeak(world, SENTINEL, written.secret as string);
});

test('--port change rewrites the config and tells the user to update Blockbench', async () => {
  const world = makeWorld({
    existingConfig: validConfig(SENTINEL, 39731),
    registrationDetail: ourRegistrationDetail(CONFIG_PATH, FAKE_CLI),
  });
  const code = await runSetup(world.deps, flags({ port: 40001 }));
  assert.equal(code, 0);
  const written = JSON.parse(world.writes[0].content) as Record<string, unknown>;
  assert.equal(written.port, 40001);
  assert.equal(written.secret, SENTINEL, 'port change must not rotate the secret');
  assert.match(allOutput(world), /update "MCP Adapter Port" in Blockbench settings/);
  assertNoSecretLeak(world, SENTINEL);
});

test('--port is honored when the existing config has no usable port field', async () => {
  const world = makeWorld({
    existingConfig: `${JSON.stringify({ version: 1, mode: 'shared-secret', secret: SENTINEL }, null, 2)}\n`,
    registrationDetail: ourRegistrationDetail(CONFIG_PATH, FAKE_CLI),
  });
  const code = await runSetup(world.deps, flags({ port: 40001 }));
  assert.equal(code, 0);
  assert.equal(world.writes.length, 1, 'config must be rewritten with the requested port');
  const written = JSON.parse(world.writes[0].content) as Record<string, unknown>;
  assert.equal(written.port, 40001);
  assert.equal(written.secret, SENTINEL);
  assertNoSecretLeak(world, SENTINEL);
});

test('preflight: missing claude CLI stops before any state change', async () => {
  const world = makeWorld({ claudeMissing: true });
  const code = await runSetup(world.deps, flags());
  assert.equal(code, 1);
  assert.equal(world.writes.length, 0);
  assert.equal(world.claudeCalls.filter((args) => args[0] === 'mcp').length, 0);
  assert.match(allOutput(world), /`claude` CLI was not found on PATH/);
});

test('preflight: missing bundle names the right remediation per install mode', async () => {
  const checkout = makeWorld({ missingBundle: true });
  assert.equal(await runSetup(checkout.deps, flags()), 1);
  assert.equal(checkout.writes.length, 0);
  assert.equal(checkout.claudeCalls.filter((args) => args[0] === 'mcp').length, 0);
  assert.match(allOutput(checkout), /run `npm run build` first/);

  const installedCli = '/home/user/tools/node_modules/@adhisang/minecraft-blockbench-mcp/dist/adapter/cli.js';
  const installed = makeWorld({ cliJsPath: installedCli, missingBundle: true });
  assert.equal(await runSetup(installed.deps, flags()), 1);
  assert.equal(installed.writes.length, 0);
  assert.equal(installed.claudeCalls.filter((args) => args[0] === 'mcp').length, 0);
  assert.match(allOutput(installed), /reinstall @adhisang\/minecraft-blockbench-mcp in a persistent directory/);
});

test('preflight: npm-cache install path is refused with persistent-install instructions', async () => {
  const cachedCli = '/home/user/.npm/_npx/0123abcd/node_modules/@adhisang/minecraft-blockbench-mcp/dist/adapter/cli.js';
  const world = makeWorld({ cliJsPath: cachedCli });
  const code = await runSetup(world.deps, flags());
  assert.equal(code, 1);
  assert.equal(world.writes.length, 0);
  assert.equal(world.claudeCalls.filter((args) => args[0] === 'mcp').length, 0);
  assert.match(allOutput(world), /npm install @adhisang\/minecraft-blockbench-mcp/);

  assert.ok(isNpmCachePath('C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\x\\node_modules\\p'));
  assert.ok(isNpmCachePath('/home/user/.npm/_cacache/tmp/node_modules/p'));
  assert.ok(isNpmCachePath('/home/user/npm-cache/x/node_modules/p'));
  assert.ok(!isNpmCachePath('/home/user/tools/node_modules/@adhisang/minecraft-blockbench-mcp'));
});

test('port held on fresh setup produces a warning but still completes', async () => {
  const world = makeWorld({ portState: 'held' });
  const code = await runSetup(world.deps, flags());
  assert.equal(code, 0);
  assert.match(allOutput(world), /Warning: port 39731 is already in use/);
  assertNoSecretLeak(world, writtenSecret(world));
});

test('a broken adapter state after successful registration exits 1 with the remediation', async () => {
  const world = makeWorld({ health: { state: 'broken', codes: ['E_LISTENER_FAILED'] } });
  const code = await runSetup(world.deps, flags());
  assert.equal(code, 1);
  const text = allOutput(world);
  assert.match(text, /Registered MCP server "blockbench" in Claude Code/);
  assert.match(text, /loopback listener/);
  assertNoSecretLeak(world, writtenSecret(world));
});

test('a config directory that cannot be written surfaces as an error before registration', async () => {
  const world = makeWorld();
  world.deps.writeSecretFile = () => {
    throw new Error('EACCES: permission denied');
  };
  await assert.rejects(() => runSetup(world.deps, flags()), /EACCES/);
  assert.equal(world.claudeCalls.filter((args) => args[1] === 'add').length, 0);
});

test('claude mcp add failure reports the manual command and a consistent state', async () => {
  const world = makeWorld({ addStatus: 1 });
  const code = await runSetup(world.deps, flags());
  assert.equal(code, 1);
  const text = allOutput(world);
  assert.match(text, /config file was written/);
  assert.ok(text.includes(`claude mcp add blockbench --scope project -e BLOCKBENCH_MCP_CONFIG=${CONFIG_PATH} -- node ${FAKE_CLI}`));
  assertNoSecretLeak(world, writtenSecret(world));
});

test('corrupt config file aborts without overwriting unless --rotate-secret', async () => {
  const world = makeWorld({ existingConfig: '{not json' });
  assert.equal(await runSetup(world.deps, flags()), 1);
  assert.equal(world.writes.length, 0);
  assert.match(allOutput(world), /--rotate-secret/);

  const rotate = makeWorld({ existingConfig: '{not json' });
  assert.equal(await runSetup(rotate.deps, flags({ rotateSecret: true })), 0);
  assert.equal(rotate.writes.length, 1);
  assertNoSecretLeak(rotate, writtenSecret(rotate));
});

test('rewriting a corrupt config salvages its in-range port', async () => {
  const world = makeWorld({ existingConfig: JSON.stringify({ secret: '', port: 40123 }) });
  assert.equal(await runSetup(world.deps, flags({ rotateSecret: true })), 0);
  const written = JSON.parse(world.writes[0].content) as Record<string, unknown>;
  assert.equal(written.port, 40123);
  assert.match(allOutput(world), /Port set to 40123 — ensure "MCP Adapter Port" in Blockbench settings matches\./);
  assertNoSecretLeak(world, writtenSecret(world));
});

test('WSL prints both path notations; non-WSL output has no Windows path line', async () => {
  const wsl = makeWorld({ isWsl: true, windowsPath: '\\\\wsl.localhost\\Ubuntu\\repo\\dist\\plugin\\minecraft_blockbench_mcp.js' });
  await runSetup(wsl.deps, flags());
  const wslText = allOutput(wsl);
  assert.ok(wslText.includes(FAKE_PLUGIN));
  assert.ok(wslText.includes('\\\\wsl.localhost\\Ubuntu'));
  assertNoSecretLeak(wsl, writtenSecret(wsl));

  const plain = makeWorld();
  await runSetup(plain.deps, flags());
  assert.ok(!allOutput(plain).toLowerCase().includes('wsl'));
  assert.ok(!allOutput(plain).includes('Windows path'));

  const noTranslation = makeWorld({ isWsl: true, windowsPath: null });
  await runSetup(noTranslation.deps, flags());
  assert.match(allOutput(noTranslation), /Windows path unavailable/);
});

test('--show-secret reveals the secret; --clipboard pipes it to the clipboard tool only', async () => {
  const shown = makeWorld({
    existingConfig: validConfig(),
    registrationDetail: ourRegistrationDetail(CONFIG_PATH, FAKE_CLI),
  });
  await runSetup(shown.deps, flags({ showSecret: true }));
  assert.ok(allOutput(shown).includes(SENTINEL));

  const clip = makeWorld({
    existingConfig: validConfig(),
    registrationDetail: ourRegistrationDetail(CONFIG_PATH, FAKE_CLI),
  });
  await runSetup(clip.deps, flags({ clipboard: true }));
  assert.deepEqual(clip.clipboardInputs, [SENTINEL]);
  assert.ok(!allOutput(clip).includes(SENTINEL));
  assert.match(allOutput(clip), /clipboard managers may retain it/);
});

test('doctor reports each of the four states with the plan exit codes', async () => {
  const cases: Array<{ health: HealthState; exit: number; pattern: RegExp }> = [
    { health: { state: 'broken', codes: ['E_SECRET_MISSING'] }, exit: 1, pattern: /rerun `minecraft-blockbench-mcp setup`/ },
    { health: { state: 'broken', codes: ['E_LISTENER_FAILED'] }, exit: 1, pattern: /loopback listener/ },
    { health: { state: 'port-held', codes: ['E_PORT_IN_USE'] }, exit: 0, pattern: /likely your registered adapter is already running/ },
    { health: { state: 'waiting', codes: [] }, exit: 0, pattern: /waiting for the Blockbench plugin/ },
    { health: { state: 'connected', codes: [] }, exit: 0, pattern: /Fully connected/ },
  ];
  for (const { health, exit, pattern } of cases) {
    const world = makeWorld({ existingConfig: validConfig(), health });
    assert.equal(await runDoctor(world.deps, flags()), exit, `state ${health.state}`);
    assert.match(allOutput(world), pattern);
    assertNoSecretLeak(world, SENTINEL);
  }
});

test('doctor without a config file says setup has not run', async () => {
  const world = makeWorld();
  assert.equal(await runDoctor(world.deps, flags()), 1);
  assert.match(allOutput(world), /Not configured — run `minecraft-blockbench-mcp setup` first\./);
});

test('uninstall removes the registration and config file and lists what it left', async () => {
  const world = makeWorld({
    existingConfig: validConfig(),
    registrationDetail: ourRegistrationDetail(CONFIG_PATH, FAKE_CLI),
  });
  const code = await runSetup(world.deps, flags({ uninstall: true }));
  assert.equal(code, 0);
  const removeCall = world.claudeCalls.find((args) => args[1] === 'remove');
  assert.deepEqual(removeCall, ['mcp', 'remove', 'blockbench', '--scope', 'project']);
  assert.deepEqual(world.deletes, [CONFIG_PATH]);
  const text = allOutput(world);
  assert.match(text, /Left in place/);
  assert.match(text, /File → Plugins/);
  assertNoSecretLeak(world, SENTINEL);
});

test('uninstall leaves a blockbench registration that points elsewhere untouched', async () => {
  const world = makeWorld({
    existingConfig: validConfig(),
    registrationDetail: ourRegistrationDetail('/somewhere/else.json', '/other/cli.js'),
  });
  const code = await runSetup(world.deps, flags({ uninstall: true }));
  assert.equal(code, 0);
  assert.equal(world.claudeCalls.filter((args) => args[1] === 'remove').length, 0);
  assert.deepEqual(world.deletes, [CONFIG_PATH], 'the owned config file is still removed');
  assert.match(allOutput(world), /does not point at this installation — leaving it in place/);
  assertNoSecretLeak(world, SENTINEL);
});

test('uninstall reports a removal failure and echoes the scope the registration reports', async () => {
  const world = makeWorld({
    registrationDetail: ourRegistrationDetail(CONFIG_PATH, FAKE_CLI, 'User config (available in all your projects)'),
    removeStatus: 1,
  });
  const code = await runSetup(world.deps, flags({ uninstall: true }));
  assert.equal(code, 1);
  assert.match(allOutput(world), /claude mcp remove blockbench -s <scope>/);
  assert.match(allOutput(world), /Scope: User config/);
});

test('runSetupCli refuses to run from a non-built entry path', async () => {
  assert.equal(await runSetupCli('setup', [], '/repo/src/adapter/cli.ts'), 1);
});

test('resolveConfigPath follows the per-platform table', () => {
  assert.equal(
    resolveConfigPath({ env: { XDG_CONFIG_HOME: '/xdg' }, osPlatform: 'linux' }),
    '/xdg/minecraft-blockbench-mcp/config.json',
  );
  assert.equal(
    resolveConfigPath({ env: { HOME: '/home/u' }, osPlatform: 'linux' }),
    '/home/u/.config/minecraft-blockbench-mcp/config.json',
  );
  assert.equal(
    resolveConfigPath({ env: { HOME: '/Users/u' }, osPlatform: 'darwin' }),
    '/Users/u/Library/Application Support/minecraft-blockbench-mcp/config.json',
  );
  assert.equal(
    resolveConfigPath({ env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, osPlatform: 'win32' }),
    join('C:\\Users\\u\\AppData\\Roaming', 'minecraft-blockbench-mcp', 'config.json'),
  );
});

test('the real clipboard path pipes the secret via stdin, never argv', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'bbmcp-clip-test-'));
  const previousPath = process.env.PATH;
  try {
    // Shadow every candidate clipboard tool with a shim that records its
    // argv and stdin, so the test works on WSL (clip.exe) and Linux alike.
    for (const tool of ['clip.exe', 'wl-copy', 'xclip', 'pbcopy']) {
      const shim = join(dir, tool);
      writeFileSync(shim, `#!/bin/sh\nprintf '%s' "$*" > "${join(dir, 'argv.txt')}"\ncat > "${join(dir, 'stdin.txt')}"\n`, {
        mode: 0o755,
      });
    }
    process.env.PATH = `${dir}:${previousPath ?? ''}`;
    const result = createRealDeps(builtCliPath).copyToClipboard('clip-sentinel-0aa1');
    assert.equal(result.ok, true);
    assert.equal(readFileSync(join(dir, 'stdin.txt'), 'utf8'), 'clip-sentinel-0aa1');
    assert.ok(!readFileSync(join(dir, 'argv.txt'), 'utf8').includes('clip-sentinel-0aa1'));
  } finally {
    process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeSecretFile writes atomically with 0600 permissions', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'bbmcp-setup-test-'));
  try {
    const deps = createRealDeps(builtCliPath);
    const target = join(dir, 'nested', 'config.json');
    deps.writeSecretFile(target, '{"secret":"x"}\n');
    assert.equal(readFileSync(target, 'utf8'), '{"secret":"x"}\n');
    assert.equal(statSync(target).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Integration: the classifier against the real built adapter (no fakes).
test('checkAdapterHealth reports E_SECRET_MISSING as broken against the real adapter', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bbmcp-health-test-'));
  try {
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ version: 1, port: 40911 }));
    const state = await checkAdapterHealth(builtCliPath, configPath, { timeoutMs: 20_000 });
    assert.equal(state.state, 'broken');
    assert.ok(state.codes.includes('E_SECRET_MISSING'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkAdapterHealth reports port-held while another listener owns the port', async () => {
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const heldPort = (server.address() as { port: number }).port;
  const dir = mkdtempSync(join(tmpdir(), 'bbmcp-health-test-'));
  try {
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ version: 1, mode: 'shared-secret', port: heldPort, secret: 'integration-x' }));
    const state = await checkAdapterHealth(builtCliPath, configPath, { timeoutMs: 20_000 });
    assert.equal(state.state, 'port-held');
    assert.ok(state.codes.includes('E_PORT_IN_USE'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
