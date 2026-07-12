import { accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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

function parseHealth(result) {
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0 || content[0].type !== 'text') {
    throw new Error('packaged MCP health response did not contain text');
  }
  return JSON.parse(content[0].text);
}

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
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath],
    cwd: installedRoot,
    env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'package-verifier', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    if (!tools.tools.some(({ name }) => name === 'health')) throw new Error('packaged MCP server did not expose health');
    const health = parseHealth(await client.callTool({ name: 'health', arguments: {} }));
    if (!health.ok || !health.result?.setup_errors?.some(({ code }) => code === 'E_SECRET_MISSING')) {
      throw new Error(`packaged MCP health check returned an unexpected result: ${JSON.stringify(health)}`);
    }
  } finally {
    await client.close();
  }

  process.stdout.write(
    `Verified ${pack.name}@${pack.version}: ${actual.size} package files, clean install, npm bin, MCP startup, and plugin bundle\n`,
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
