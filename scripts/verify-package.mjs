import { accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const workDir = mkdtempSync(join(tmpdir(), 'minecraft-blockbench-mcp-package-'));
const cacheDir = join(workDir, 'npm-cache');
const packDir = join(workDir, 'pack');
const installDir = join(workDir, 'install');

function listJavaScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listJavaScriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.js') ? [path] : [];
  });
}

function runNpm(args, cwd) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('npm_execpath is unavailable; run this check through npm run test:package');

  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NPM_CONFIG_CACHE: cacheDir },
  });
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    const cause = result.error?.message ?? `exit ${result.status}${result.signal ? `, signal ${result.signal}` : ''}`;
    throw new Error(`npm ${args[0]} failed (${cause}):\n${result.stderr || result.stdout || '(no output)'}`);
  }
  return result.stdout;
}

/** The modern MCP revision the packaged executable must still serve. */
const MODERN_PROTOCOL_VERSION = '2026-07-28';

/** Tools the packaged catalogue must advertise, whichever era asks for it. */
const REQUIRED_TOOLS = ['health', 'get_plugin_status', 'get_project_state', 'read_file', 'write_files'];

function parseHealth(result, era) {
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0 || content[0].type !== 'text') {
    throw new Error(`packaged MCP health response over ${era} did not contain text`);
  }
  return JSON.parse(content[0].text);
}

// The catalogue is era-independent. Checking it on both connections is what
// stops a build that serves one era from a stale or empty tool registry from
// passing on the strength of the other era alone.
function assertToolCatalogue(tools, era) {
  const names = tools.map(({ name }) => name);
  const missing = REQUIRED_TOOLS.filter((name) => !names.includes(name));
  if (missing.length > 0) {
    throw new Error(`packaged MCP tool catalogue over ${era} is missing ${missing.join(', ')}`);
  }
  if (new Set(names).size !== names.length) {
    throw new Error(`packaged MCP tool catalogue over ${era} advertises a duplicate tool name`);
  }
  for (const tool of tools) {
    if (typeof tool.description !== 'string' || tool.description === '') {
      throw new Error(`packaged tool ${String(tool.name)} has no description over ${era}`);
    }
    const schema = tool.inputSchema;
    if (schema === null || typeof schema !== 'object' || schema.type !== 'object') {
      throw new Error(`packaged tool ${String(tool.name)} has no object input schema over ${era}`);
    }
  }
}

// This probe starts the packaged server with no shared secret and an empty
// config home, so the adapter must report that it cannot serve plugin traffic.
// Which setup error says so depends on the mode the adapter resolved for this
// platform, so the accepted codes are keyed by the mode health actually
// reports rather than assumed.
const ACCEPTED_SECRETLESS_SETUP_ERRORS = new Map([
  // Direct mode (the Windows default) opens the plugin WebSocket listener in
  // the adapter process, so the missing secret is reported directly.
  ['direct', ['E_SECRET_MISSING']],
  // Brokered mode (the POSIX default since commit 43ade3c) delegates the
  // listener to a detached broker process. That broker refuses to start
  // without a secret and never publishes its rendezvous record, so the adapter
  // reports the broker as unreachable. E_SECRET_MISSING is also accepted in
  // case the broker's underlying reason is ever propagated back to the client.
  ['brokered', ['E_BROKER_UNAVAILABLE', 'E_SECRET_MISSING']],
]);

// Fails whenever the packaged server did not start, did not answer with a
// well-formed health envelope, or did not report a setup error that matches
// the mode it resolved.
function assertSecretlessHealth(health, era) {
  const describe = () => `${era}: ${JSON.stringify(health)}`;
  if (health === null || typeof health !== 'object' || typeof health.summary !== 'string' || health.ok !== true) {
    throw new Error(`packaged MCP health check returned a malformed envelope: ${describe()}`);
  }

  const result = health.result;
  if (result === null || typeof result !== 'object') {
    throw new Error(`packaged MCP health check returned no result object: ${describe()}`);
  }
  if (typeof result.adapter_version !== 'string' || typeof result.protocol_version !== 'number') {
    throw new Error(`packaged MCP health result is missing version fields: ${describe()}`);
  }
  if (result.plugin_connected !== false) {
    throw new Error(`packaged MCP health result claims a plugin connection this probe cannot have: ${describe()}`);
  }

  const accepted = typeof result.mode === 'string' ? ACCEPTED_SECRETLESS_SETUP_ERRORS.get(result.mode) : undefined;
  if (accepted === undefined) {
    throw new Error(`packaged MCP health result reported an unknown adapter mode: ${describe()}`);
  }
  if (!Array.isArray(result.setup_errors)) {
    throw new Error(`packaged MCP health result is missing setup_errors: ${describe()}`);
  }

  const codes = result.setup_errors.map((issue) => (issue === null || typeof issue !== 'object' ? undefined : issue.code));
  if (!codes.some((code) => accepted.includes(code))) {
    throw new Error(
      `packaged MCP health check returned an unexpected result: expected one of ` +
        `${accepted.join(', ')} in setup_errors for mode ${result.mode}, got ${describe()}`,
    );
  }
}

// The `setup` and `doctor` subcommands are dispatched from `argv[2]` by
// `routeCli` (`src/setup/route.ts`) and pull in `src/setup/**`, which imports
// `@modelcontextprotocol/client` at module top level. Nothing in the serving
// path above touches that package, so only invoking the subcommands proves it
// is installed for a consumer: when it is missing the entry dies during module
// resolution with `ERR_MODULE_NOT_FOUND` and the adapter's `Fatal error:` line.
//
// Each probe is shaped to stop before any setup effect and without waiting for
// anything, so this stays a fast, non-interactive check that writes nothing:
//   - `setup` is given an invalid `--scope` value, so `parseFlags` rejects it,
//     usage is printed and the command exits 2 before it reads or writes a
//     config file, registers anything with `claude`, or probes a port; and
//   - `doctor` runs against the same empty config home as the MCP health
//     probes, finds no config file, and exits 1 without starting a health check.
// Both exit codes are reached only after every module on the subcommand's
// import chain has resolved and executed.
const SETUP_SUBCOMMAND_PROBES = [
  { label: 'setup', args: ['setup', '--scope', 'not-a-scope'], expectedStatus: 2, expectedStdout: 'Usage:' },
  { label: 'doctor', args: ['doctor'], expectedStatus: 1, expectedStdout: 'Not configured' },
];

/** Neither probe waits for anything, so exceeding this means it hung. */
const SETUP_SUBCOMMAND_TIMEOUT_MS = 30_000;

/** Removed in the `finally` block below; only created on non-Windows. */
let packageRuntimeDir = null;

try {
  mkdirSync(packDir, { recursive: true });
  mkdirSync(installDir, { recursive: true });
  const packOutput = runNpm(['pack', '--json', '--pack-destination', packDir], packageRoot);
  const packs = JSON.parse(packOutput);
  if (!Array.isArray(packs) || packs.length !== 1) throw new Error('npm pack returned an unexpected result');

  const pack = packs[0];
  if (pack.name !== '@adhisang/minecraft-blockbench-mcp') {
    throw new Error(`unexpected package name: ${pack.name}`);
  }

  const actual = new Set(pack.files.map(({ path }) => path));
  const distRoot = fileURLToPath(new URL('../dist', import.meta.url));
  const expectedRuntime = listJavaScriptFiles(distRoot).map((path) =>
    `dist/${relative(distRoot, path).split(sep).join('/')}`,
  );
  const expected = new Set(['LICENSE', 'README.md', 'package.json', ...expectedRuntime]);
  const missing = [...expected].filter((path) => !actual.has(path));
  const unexpected = [...actual].filter((path) => !expected.has(path));
  if (missing.length || unexpected.length) {
    throw new Error(
      `package contents differ from the runtime allowlist` +
        `\nmissing: ${missing.join(', ') || '(none)'}` +
        `\nunexpected: ${unexpected.join(', ') || '(none)'}`,
    );
  }

  const tarball = join(packDir, basename(pack.filename));
  runNpm(['install', '--ignore-scripts', tarball], installDir);

  const installedRoot = join(installDir, 'node_modules', '@adhisang', 'minecraft-blockbench-mcp');
  const cliPath = join(installedRoot, 'dist', 'adapter', 'cli.js');
  const pluginPath = join(installedRoot, 'dist', 'plugin', 'minecraft_blockbench_mcp.js');
  for (const required of [cliPath, pluginPath, join(installedRoot, 'README.md'), join(installedRoot, 'LICENSE')]) {
    if (!existsSync(required)) throw new Error(`installed package artifact is missing: ${required}`);
  }
  accessSync(cliPath, constants.R_OK);

  const binPath = join(installDir, 'node_modules', '.bin', 'minecraft-blockbench-mcp');
  const binStat = lstatSync(binPath);
  if (!binStat.isSymbolicLink() && !binStat.isFile()) throw new Error('npm did not create the package bin entry');
  if (process.platform !== 'win32') accessSync(binPath, constants.X_OK);

  const env = { ...process.env };
  delete env.BLOCKBENCH_MCP_SECRET;
  delete env.BLOCKBENCH_MCP_CONFIG;
  // The adapter resolves an implicit per-user default config file; isolate the
  // probe from any real `setup` state on this machine.
  const emptyConfigHome = join(workDir, 'empty-config-home');
  mkdirSync(emptyConfigHome, { recursive: true });
  env.XDG_CONFIG_HOME = emptyConfigHome;
  env.HOME = emptyConfigHome;
  env.APPDATA = emptyConfigHome;
  env.USERPROFILE = emptyConfigHome;
  if (process.platform !== 'win32') {
    // `workDir` sits under `os.tmpdir()`, which can put the brokered adapter's
    // Unix socket path over the platform limit; give the probe a short runtime
    // root instead (mirrors tests/helpers/runtime-root.ts).
    packageRuntimeDir = mkdtempSync('/tmp/bbmcp-pkg-');
    env.BLOCKBENCH_MCP_RUNTIME_DIR = packageRuntimeDir;
  }
  // The packaged executable serves two MCP wire eras, so the smoke has to open
  // the packaged bin on each of them. `legacy` is the client default and is
  // what negotiates a 2025-era handshake; pinning the modern revision fails
  // loudly rather than falling back, so a build that lost modern support does
  // not quietly pass as legacy.
  const eras = [
    { label: 'MCP 2025-era handshake', negotiation: { mode: 'legacy' } },
    { label: `MCP ${MODERN_PROTOCOL_VERSION}`, negotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } },
  ];
  const verifiedEras = [];
  for (const era of eras) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath],
      cwd: installedRoot,
      env,
      stderr: 'pipe',
    });
    const client = new Client(
      { name: 'package-verifier', version: '1.0.0' },
      { versionNegotiation: era.negotiation },
    );
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      if (!tools.tools.some(({ name }) => name === 'health')) {
        throw new Error(`packaged MCP server did not expose health over ${era.label}`);
      }
      assertToolCatalogue(tools.tools, era.label);
      const health = parseHealth(await client.callTool({ name: 'health', arguments: {} }), era.label);
      assertSecretlessHealth(health, era.label);
      verifiedEras.push(era.label);
    } finally {
      await client.close();
    }
  }
  if (verifiedEras.length !== eras.length) {
    throw new Error(`only ${verifiedEras.length} of ${eras.length} MCP era smoke(s) ran`);
  }

  for (const probe of SETUP_SUBCOMMAND_PROBES) {
    const started = spawnSync(process.execPath, [cliPath, ...probe.args], {
      cwd: installedRoot,
      encoding: 'utf8',
      env,
      timeout: SETUP_SUBCOMMAND_TIMEOUT_MS,
    });
    const output = `${started.stdout ?? ''}${started.stderr ?? ''}`;
    if (started.error) {
      throw new Error(`packaged \`${probe.label}\` could not be spawned: ${started.error.message}`);
    }
    if (started.status !== probe.expectedStatus) {
      throw new Error(
        `packaged \`${probe.label}\` did not start: expected exit ${probe.expectedStatus}, got ` +
          `exit ${started.status}${started.signal ? ` (signal ${started.signal})` : ''}.\n${output || '(no output)'}`,
      );
    }
    if (!started.stdout.includes(probe.expectedStdout)) {
      throw new Error(
        `packaged \`${probe.label}\` exited ${probe.expectedStatus} without reaching its command logic: ` +
          `stdout does not contain ${JSON.stringify(probe.expectedStdout)}.\n${output || '(no output)'}`,
      );
    }
  }

  process.stdout.write(
    `Verified ${pack.name}@${pack.version}: ${actual.size} package files, clean install, npm bin, ` +
      `plugin bundle, MCP startup over ${verifiedEras.join(' and ')}, and ` +
      `${SETUP_SUBCOMMAND_PROBES.map(({ label }) => label).join('/')} startup\n`,
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
  if (packageRuntimeDir !== null) rmSync(packageRuntimeDir, { recursive: true, force: true });
}
