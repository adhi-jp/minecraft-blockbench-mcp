#!/usr/bin/env node
// Git-checkout wrapper for the setup CLI: fails fast with build guidance when
// the dist output is missing instead of surfacing a raw module-load error.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../dist/adapter/cli.js', import.meta.url));
const setupModulePath = fileURLToPath(new URL('../dist/setup/run.js', import.meta.url));
if (!existsSync(cliPath) || !existsSync(setupModulePath)) {
  process.stderr.write('The dist output is missing or incomplete — run `npm run build` first.\n');
  process.exit(1);
}

const result = spawnSync(process.execPath, [cliPath, 'setup', ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(result.status ?? 1);
