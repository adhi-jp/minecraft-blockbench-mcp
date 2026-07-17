// Tests for the full-auto orchestration, the CDP payload builder, the Windows
// PowerShell driver generator, and the target resolver. All effects are
// injected, so no Blockbench, CDP endpoint, or interop runs here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildFullAutoPayload,
  createRealFullAutoDeps,
  resolveFullAutoTarget,
  runFullAuto,
  type FullAutoContext,
  type FullAutoDeps,
  type FullAutoTarget,
} from '../src/setup/full-auto.js';
import {
  WINDOWS_DRIVER_SCRIPT,
  extractEvaluateValue,
  parseDriverOutput,
} from '../src/setup/windows-driver.js';

const SENTINEL = 'fullauto-secret-abcdef0123456789';
const PLUGIN_PATH = '/repo/dist/plugin/minecraft_blockbench_mcp.js';

interface FakeWorld {
  out: string[];
  launches: Array<{ binary: string; args: string[] }>;
  evaluatePayloads: string[];
  deps: FullAutoDeps;
}

interface FakeOptions {
  target?: FullAutoTarget;
  binary?: string | null;
  running?: boolean;
  launchOk?: boolean;
  versionBody?: string;
  versionOk?: boolean;
  evaluateResult?: unknown;
  evaluateOk?: boolean;
  toTarget?: (path: string) => string | null;
}

function makeWorld(options: FakeOptions = {}): FakeWorld {
  const world: Partial<FakeWorld> & { out: string[]; launches: FakeWorld['launches']; evaluatePayloads: string[] } = {
    out: [],
    launches: [],
    evaluatePayloads: [],
  };
  world.deps = {
    target: options.target ?? 'posix-local',
    discoverBinary: () => (options.binary === undefined ? '/usr/bin/blockbench' : options.binary),
    isBlockbenchRunning: async () => options.running ?? false,
    launch: async (binary, args) => {
      world.launches.push({ binary, args });
      return (options.launchOk ?? true) ? { ok: true } : { ok: false, error: 'launch failed' };
    },
    fetchVersion: async () => ({
      ok: options.versionOk ?? true,
      versionBody: options.versionBody ?? '{"Browser":"Chrome/144","User-Agent":"... Blockbench/5.1.4 ..."}',
    }),
    evaluate: async (_port, payload) => {
      world.evaluatePayloads.push(payload);
      return {
        ok: options.evaluateOk ?? true,
        result: options.evaluateResult ?? JSON.stringify({ ok: true }),
      };
    },
    pathForTarget: options.toTarget ?? ((path) => path),
    pickCdpPort: () => 42123,
    out: (line) => world.out.push(line),
  };
  return world as FakeWorld;
}

function ctx(overrides: Partial<FullAutoContext> = {}): FullAutoContext {
  return { pluginPath: PLUGIN_PATH, port: 39731, secret: SENTINEL, skipRunningCheck: true, ...overrides };
}

test('the CDP payload carries the exact proven calls and the plugin path, and embeds the secret only as a settings value', () => {
  const payload = buildFullAutoPayload({ pluginPath: PLUGIN_PATH, port: 39731, secret: SENTINEL });
  assert.match(payload, /new Plugin\(\)\.loadFromFile\(\{ path, name: path, content: '' \}, false\)/);
  assert.match(payload, /settings\.minecraft_blockbench_mcp_port\.set\(39731\)/);
  assert.ok(payload.includes(`settings.minecraft_blockbench_mcp_secret.set(${JSON.stringify(SENTINEL)})`));
  assert.ok(payload.includes(JSON.stringify(PLUGIN_PATH)));
  // The settings are seeded before the plugin loads so its on-load session uses
  // the settings source and never opens the config-file permission dialog.
  const seedIndex = payload.indexOf("Settings.stored['minecraft_blockbench_mcp_secret']");
  const loadIndex = payload.indexOf('loadFromFile');
  assert.ok(seedIndex > -1 && seedIndex < loadIndex, 'the secret is seeded before loadFromFile');
});

test('happy Linux path: launches with a debug port, evaluates the payload, reports provisioned', async () => {
  const world = makeWorld({ target: 'posix-local' });
  const outcome = await runFullAuto(world.deps, ctx());
  assert.equal(outcome, 'provisioned');
  assert.equal(world.launches.length, 1);
  assert.ok(world.launches[0].args.some((arg) => arg.startsWith('--remote-debugging-port=')));
  assert.match(world.out.join('\n'), /provisioned/);
  assert.match(world.out.join('\n'), /restart Blockbench after provisioning/);
});

test('happy Windows path: the payload uses the Windows-notation plugin path', async () => {
  const world = makeWorld({
    target: 'windows-interop',
    binary: 'C:\\Users\\u\\AppData\\Local\\Programs\\Blockbench\\Blockbench.exe',
    toTarget: (path) => `\\\\wsl.localhost\\Ubuntu${path.replaceAll('/', '\\')}`,
  });
  const outcome = await runFullAuto(world.deps, ctx());
  assert.equal(outcome, 'provisioned');
  const payload = world.evaluatePayloads[0];
  assert.ok(payload.includes('\\\\\\\\wsl.localhost\\\\Ubuntu'), 'plugin path is passed in Windows UNC notation');
  assert.ok(!payload.includes(PLUGIN_PATH), 'the raw POSIX plugin path must not appear');
});

test('an already-running Blockbench aborts before any launch', async () => {
  const world = makeWorld({ running: true });
  const outcome = await runFullAuto(world.deps, ctx({ skipRunningCheck: false }));
  assert.equal(outcome, 'aborted');
  assert.equal(world.launches.length, 0);
  assert.match(world.out.join('\n'), /already running/);
});

test('the running check receives the resolved binary and does not fire on the setup process itself', async () => {
  const seen: string[] = [];
  const world = makeWorld();
  world.deps.isBlockbenchRunning = async (binaryPath) => {
    seen.push(binaryPath);
    return false;
  };
  const outcome = await runFullAuto(world.deps, ctx({ skipRunningCheck: false }));
  assert.equal(outcome, 'provisioned');
  assert.deepEqual(seen, ['/usr/bin/blockbench'], 'the check is handed the resolved binary, not a bare substring');
});

test('a missing binary aborts and names --blockbench-path', async () => {
  const world = makeWorld({ binary: null });
  const outcome = await runFullAuto(world.deps, ctx());
  assert.equal(outcome, 'aborted');
  assert.equal(world.launches.length, 0);
  assert.match(world.out.join('\n'), /--blockbench-path/);
});

test('an unsupported target returns without launching', async () => {
  const world = makeWorld({ target: 'unsupported' });
  const outcome = await runFullAuto(world.deps, ctx());
  assert.equal(outcome, 'unsupported');
  assert.equal(world.launches.length, 0);
  assert.match(world.out.join('\n'), /not available on this platform/);
});

test('a non-Blockbench DevTools endpoint is refused', async () => {
  const world = makeWorld({ versionBody: '{"Browser":"Chrome/144","User-Agent":"SomeOtherElectronApp/1.0"}' });
  const outcome = await runFullAuto(world.deps, ctx());
  assert.equal(outcome, 'aborted');
  assert.match(world.out.join('\n'), /does not identify as Blockbench/);
});

test('a payload failure inside Blockbench reports a consistent state', async () => {
  const world = makeWorld({ evaluateResult: JSON.stringify({ ok: false, stage: 'load', error: 'boom' }) });
  const outcome = await runFullAuto(world.deps, ctx());
  assert.equal(outcome, 'aborted');
  assert.match(world.out.join('\n'), /Provisioning inside Blockbench failed \(load: boom\)/);
});

test('the secret never appears in any orchestration output', async () => {
  for (const options of [
    { target: 'posix-local' as const },
    { evaluateResult: JSON.stringify({ ok: false, stage: 'settings-missing' }) },
    { versionOk: false },
  ]) {
    const world = makeWorld(options);
    await runFullAuto(world.deps, ctx());
    const text = world.out.join('\n');
    assert.ok(!text.includes(SENTINEL));
    assert.ok(!text.includes(SENTINEL.slice(0, 12)));
  }
});

test('resolveFullAutoTarget maps platforms and the WSL override correctly', () => {
  const base = { toWindowsPath: () => null };
  assert.equal(resolveFullAutoTarget({ ...base, osPlatform: 'linux', isWsl: false }), 'posix-local');
  assert.equal(resolveFullAutoTarget({ ...base, osPlatform: 'win32', isWsl: false }), 'windows-local');
  assert.equal(resolveFullAutoTarget({ ...base, osPlatform: 'linux', isWsl: true }), 'windows-interop');
  assert.equal(
    resolveFullAutoTarget({ ...base, osPlatform: 'linux', isWsl: true, blockbenchPathOverride: '/opt/blockbench' }),
    'posix-local',
  );
  assert.equal(resolveFullAutoTarget({ ...base, osPlatform: 'darwin', isWsl: false }), 'unsupported');
});

// --- Windows driver generator ---

test('the PowerShell driver script is a constant with no interpolated runtime data', () => {
  assert.ok(!WINDOWS_DRIVER_SCRIPT.includes(SENTINEL));
  // The payload and secret arrive on stdin / as evaluated values, never in code.
  assert.match(WINDOWS_DRIVER_SCRIPT, /\[Console\]::In\.ReadToEnd\(\)/);
  assert.match(WINDOWS_DRIVER_SCRIPT, /System\.Net\.WebSockets\.ClientWebSocket/);
  assert.match(WINDOWS_DRIVER_SCRIPT, /param\(\[int\]\$Port/);
});

test('parseDriverOutput reads the single JSON result line and ignores noise', () => {
  assert.deepEqual(parseDriverOutput('WARNING: something\n{"ok":true,"versionBody":"x"}\n'), {
    ok: true,
    versionBody: 'x',
  });
  assert.equal(parseDriverOutput('no json here').ok, false);
});

test('extractEvaluateValue unwraps the CDP response and surfaces errors', () => {
  assert.equal(
    extractEvaluateValue(JSON.stringify({ id: 1, result: { result: { value: JSON.stringify({ ok: true }) } } })),
    JSON.stringify({ ok: true }),
  );
  assert.throws(() => extractEvaluateValue(JSON.stringify({ id: 1, error: { message: 'evaluate blew up' } })), /evaluate blew up/);
});

// --- Interop wiring: driver argv is secret-free, payload rides stdin ---

test('the Windows interop runner receives the payload on stdin and never in argv, and cleans up its driver script', async () => {
  const interopCalls: Array<{ args: string[]; input: string | undefined }> = [];
  const scriptTempDir = mkdtempSync(join(tmpdir(), 'bbmcp-interop-test-'));
  try {
    const deps = createRealFullAutoDeps(
      {
        osPlatform: 'linux',
        isWsl: true,
        toWindowsPath: (path) => `\\\\wsl.localhost\\Ubuntu${path.replaceAll('/', '\\')}`,
        windowsTempDirDrvfs: scriptTempDir,
        interopRunner: (args, input) => {
          interopCalls.push({ args, input });
          if (args.includes('-Command')) {
            // discoverBinary / running-check / launch probes
            const command = args[args.indexOf('-Command') + 1];
            if (command.includes('Test-Path')) return { status: 0, stdout: 'C:\\Blockbench.exe', stderr: '' };
            if (command.includes('Get-Process')) return { status: 0, stdout: '0', stderr: '' };
            return { status: 0, stdout: '', stderr: '' };
          }
          // Driver -File invocation: -File <script> <port> <mode> <timeout>.
          const mode = args[args.indexOf('-File') + 3];
          if (mode === 'version') {
            return { status: 0, stdout: JSON.stringify({ ok: true, versionBody: '{"User-Agent":"Blockbench/5.1.4"}' }), stderr: '' };
          }
          return {
            status: 0,
            stdout: JSON.stringify({
              ok: true,
              response: JSON.stringify({ id: 1, result: { result: { value: JSON.stringify({ ok: true }) } } }),
            }),
            stderr: '',
          };
        },
      },
      () => {},
    );

    const outcome = await runFullAuto(deps, ctx());
    assert.equal(outcome, 'provisioned');
    assert.deepEqual(readdirSync(scriptTempDir), [], 'the generated driver script and its dir are deleted afterwards');

    const driverCalls = interopCalls.filter((call) => call.args.includes('-File'));
    assert.ok(driverCalls.length >= 2, 'version + evaluate driver invocations');
    const evaluateCall = driverCalls.find((call) => call.args.includes('evaluate'));
    assert.ok(evaluateCall !== undefined);
    assert.ok(evaluateCall.input !== undefined && evaluateCall.input.includes(SENTINEL), 'payload with secret rides stdin');
    for (const call of interopCalls) {
      assert.ok(!call.args.join(' ').includes(SENTINEL), 'the secret must never appear in any interop argv');
      assert.ok(!call.args.join(' ').includes(SENTINEL.slice(0, 12)));
    }
  } finally {
    rmSync(scriptTempDir, { recursive: true, force: true });
  }
});

test('an interop evaluate failure still deletes the driver script and reports a consistent state', async () => {
  const scriptTempDir = mkdtempSync(join(tmpdir(), 'bbmcp-interop-fail-'));
  const out: string[] = [];
  try {
    const deps = createRealFullAutoDeps(
      {
        osPlatform: 'linux',
        isWsl: true,
        toWindowsPath: (path) => `\\\\wsl.localhost\\Ubuntu${path.replaceAll('/', '\\')}`,
        windowsTempDirDrvfs: scriptTempDir,
        interopRunner: (args) => {
          if (args.includes('-Command')) {
            const command = args[args.indexOf('-Command') + 1];
            if (command.includes('Test-Path')) return { status: 0, stdout: 'C:\\Blockbench.exe', stderr: '' };
            return { status: 0, stdout: '0', stderr: '' };
          }
          const mode = args[args.indexOf('-File') + 3];
          if (mode === 'version') {
            return { status: 0, stdout: JSON.stringify({ ok: true, versionBody: '{"User-Agent":"Blockbench/5.1.4"}' }), stderr: '' };
          }
          return { status: 1, stdout: JSON.stringify({ ok: false, error: 'driver blew up' }), stderr: '' };
        },
      },
      (line) => out.push(line),
    );
    const outcome = await runFullAuto(deps, ctx());
    assert.equal(outcome, 'aborted');
    assert.deepEqual(readdirSync(scriptTempDir), [], 'a failed evaluate still deletes the driver script');
    assert.match(out.join('\n'), /Provisioning inside Blockbench failed/);
    assert.ok(!out.join('\n').includes(SENTINEL));
  } finally {
    rmSync(scriptTempDir, { recursive: true, force: true });
  }
});
