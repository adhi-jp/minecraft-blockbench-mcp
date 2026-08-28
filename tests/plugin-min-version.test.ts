import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pluginSource = readFileSync(new URL('../src/plugin/main.ts', import.meta.url), 'utf8');

test('plugin metadata requires Blockbench 5.1.4 or newer', () => {
  assert.ok(pluginSource.includes("min_version: '5.1.4'"));
  assert.ok(!pluginSource.includes("min_version: '5.1.0'"));
});
