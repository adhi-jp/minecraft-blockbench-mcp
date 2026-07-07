import { build } from 'esbuild';

// The plugin is executed by Blockbench via `new Function('requireNativeModule', 'require', code)`,
// so the bundle must be a single self-contained IIFE that treats those two
// identifiers as free variables provided by the plugin loader.
await build({
  entryPoints: ['src/plugin/main.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outfile: 'dist/plugin/minecraft_blockbench_mcp.js',
  logLevel: 'info',
});
