// Contract scan: every reference to an MCP dependency in this repository must
// go through a published entry point of `@modelcontextprotocol/server` or
// `@modelcontextprotocol/client`. Reaching into `dist/`, into an internal
// module path, or into a package that is only present transitively (such as
// `@modelcontextprotocol/core`) couples this project to file layout the
// dependency is free to change in a patch release, and it is explicitly
// forbidden for both production code and tests.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCANNED_DIRECTORIES = ['src', 'tests', 'scripts'];
const SCANNED_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];
const SKIPPED_DIRECTORY_NAMES = new Set(['node_modules', 'dist', 'coverage', '.git']);

/**
 * The complete set of module specifiers this repository is allowed to import an
 * MCP dependency through. Anything else that starts with `@modelcontextprotocol/`
 * is a violation, including a subpath of one of these packages that is not
 * listed here.
 */
const ALLOWED_MCP_SPECIFIERS: ReadonlySet<string> = new Set([
  '@modelcontextprotocol/server',
  '@modelcontextprotocol/server/stdio',
  '@modelcontextprotocol/client',
  '@modelcontextprotocol/client/stdio',
]);

const MCP_SCOPE_PREFIX = '@modelcontextprotocol/';

/**
 * Every module specifier a source file names, from static `import`/`export …
 * from`, bare `import '…'` side-effect imports, dynamic `import('…')`, and
 * `require('…')`. Deliberately textual: the scan must see a forbidden path even
 * in a file that does not type-check or does not run.
 */
function moduleSpecifiersIn(source: string): string[] {
  const patterns = [
    /(?:^|[^\w$.])(?:import|export)\s+[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /(?:^|[^\w$.])import\s*['"]([^'"]+)['"]/g,
    /(?:^|[^\w$.])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|[^\w$.])require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  const found: string[] = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) found.push(match[1]);
    }
  }
  return found;
}

/** The MCP specifiers in `source` that are not published entry points. */
function forbiddenMcpSpecifiersIn(source: string): string[] {
  return moduleSpecifiersIn(source).filter(
    (specifier) => specifier.startsWith(MCP_SCOPE_PREFIX) && !ALLOWED_MCP_SPECIFIERS.has(specifier),
  );
}

function sourceFilesUnder(directory: string): string[] {
  const collected: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (SKIPPED_DIRECTORY_NAMES.has(entry)) continue;
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (SCANNED_EXTENSIONS.some((extension) => entry.endsWith(extension))) collected.push(path);
    }
  };
  walk(directory);
  return collected;
}

function scanRepository(): { files: string[]; mcpSpecifiers: string[]; violations: string[] } {
  const files: string[] = [];
  const mcpSpecifiers: string[] = [];
  const violations: string[] = [];
  for (const directory of SCANNED_DIRECTORIES) {
    for (const path of sourceFilesUnder(join(REPO_ROOT, directory))) {
      files.push(path);
      const source = readFileSync(path, 'utf8');
      for (const specifier of moduleSpecifiersIn(source)) {
        if (specifier.startsWith(MCP_SCOPE_PREFIX)) mcpSpecifiers.push(specifier);
      }
      for (const specifier of forbiddenMcpSpecifiersIn(source)) {
        violations.push(`${relative(REPO_ROOT, path).split(sep).join('/')}: ${specifier}`);
      }
    }
  }
  return { files, mcpSpecifiers, violations };
}

test('no source, test, or script file imports an MCP package through a deep or internal path', () => {
  const { violations } = scanRepository();
  assert.deepEqual(
    violations,
    [],
    `Only published MCP entry points may be imported (${[...ALLOWED_MCP_SPECIFIERS].join(', ')}). Offending imports:\n${violations.join('\n')}`,
  );
});

test('the MCP entry-point scan actually reaches real files and real MCP imports', () => {
  const { files, mcpSpecifiers } = scanRepository();
  // Without these two floors the scan above would pass just as happily on an
  // empty tree, a renamed directory, or a broken specifier matcher.
  assert.ok(files.length > 20, `expected the scan to visit the repository's source files, saw ${files.length}`);
  assert.ok(
    mcpSpecifiers.length >= 8,
    `expected the scan to observe the MCP imports this repository really has, saw ${mcpSpecifiers.length}`,
  );
  for (const specifier of mcpSpecifiers) {
    assert.ok(ALLOWED_MCP_SPECIFIERS.has(specifier), `unexpected MCP specifier observed: ${specifier}`);
  }
});

test('the MCP entry-point scan rejects deep, internal, and transitive-package imports', () => {
  // The control sources are assembled at run time rather than written out as
  // literals, so this file contributes no matchable specifier of its own to the
  // repository scan above and cannot mask or manufacture a violation there.
  const staticImport = (specifier: string): string => ['import { X } from ', JSON.stringify(specifier), ';'].join('');
  const dynamicImport = (specifier: string): string => ['const X = await import(', JSON.stringify(specifier), ');'].join('');
  const requireCall = (specifier: string): string => ['const X = require(', JSON.stringify(specifier), ');'].join('');
  const reExport = (specifier: string): string => ['export { X } from ', JSON.stringify(specifier), ';'].join('');

  const forbidden = [
    staticImport(`${MCP_SCOPE_PREFIX}server/dist/stdio.mjs`),
    staticImport(`${MCP_SCOPE_PREFIX}server/dist/index.mjs`),
    staticImport(`${MCP_SCOPE_PREFIX}core`),
    staticImport(`${MCP_SCOPE_PREFIX}sdk/server/stdio.js`),
    dynamicImport(`${MCP_SCOPE_PREFIX}client/dist/index.mjs`),
    requireCall(`${MCP_SCOPE_PREFIX}core/dist/types.cjs`),
    reExport(`${MCP_SCOPE_PREFIX}server/dist/types.mjs`),
  ];
  for (const source of forbidden) {
    assert.deepEqual(forbiddenMcpSpecifiersIn(source).length, 1, `expected the scan to flag: ${source}`);
  }

  const permitted = [
    ...[...ALLOWED_MCP_SPECIFIERS].map(staticImport),
    ...[...ALLOWED_MCP_SPECIFIERS].map(dynamicImport),
    staticImport('zod'),
    staticImport('node:assert/strict'),
  ];
  for (const source of permitted) {
    assert.deepEqual(forbiddenMcpSpecifiersIn(source), [], `expected the scan to accept: ${source}`);
  }
});
