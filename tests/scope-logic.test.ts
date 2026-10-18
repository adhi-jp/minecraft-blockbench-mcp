import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normalizePath,
  isContained,
  resolveInScope,
  findSymlinkComponent,
  preflightWrites,
} from '../src/shared/scope.js';

test('normalizePath unifies separators and resolves dot segments', () => {
  assert.equal(normalizePath('/scope/models/../textures/./stone.png'), '/scope/textures/stone.png');
  assert.equal(normalizePath('C:\\scope\\models\\..\\a.json'), 'C:/scope/a.json');
  assert.equal(normalizePath('/scope//deep///x'), '/scope/deep/x');
  assert.equal(normalizePath('/scope/'), '/scope');
  assert.equal(normalizePath('relative/dir/../file'), 'relative/file');
});

test('normalizePath rejects any traversal above an absolute root as invalid', () => {
  assert.equal(normalizePath('/scope/../../etc/passwd'), null);
  assert.equal(normalizePath('/../etc'), null);
  assert.equal(normalizePath('C:/../x'), null);
});

test('containment is separator-aware: sibling directories sharing a name prefix stay outside', () => {
  assert.equal(isContained('/scope', '/scope'), true);
  assert.equal(isContained('/scope', '/scope/a/b.json'), true);
  assert.equal(isContained('/scope', '/scope-evil/x'), false);
  assert.equal(isContained('/scope', '/scopeX'), false);
});

test('resolveInScope accepts scope-relative and inside-absolute paths, rejects escapes', () => {
  const okRelative = resolveInScope('/scope', 'models/block.json');
  assert.deepEqual(okRelative, { ok: true, path: '/scope/models/block.json' });

  const okAbsolute = resolveInScope('/scope', '/scope/tex/a.png');
  assert.deepEqual(okAbsolute, { ok: true, path: '/scope/tex/a.png' });

  const dotEscape = resolveInScope('/scope', '../outside.txt');
  assert.equal(dotEscape.ok, false);
  if (!dotEscape.ok) assert.equal(dotEscape.error.code, 'E_PATH_OUTSIDE_SCOPE');

  const absEscape = resolveInScope('/scope', '/etc/passwd');
  assert.equal(absEscape.ok, false);
  if (!absEscape.ok) assert.equal(absEscape.error.code, 'E_PATH_OUTSIDE_SCOPE');

  const prefixCollision = resolveInScope('/scope', '/scope-evil/x.json');
  assert.equal(prefixCollision.ok, false);
  if (!prefixCollision.ok) assert.equal(prefixCollision.error.code, 'E_PATH_OUTSIDE_SCOPE');

  const backslashEscape = resolveInScope('/scope', '..\\outside.txt');
  assert.equal(backslashEscape.ok, false);

  const empty = resolveInScope('/scope', '   ');
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.error.code, 'E_INVALID_PARAMS');
});

function nodeListDir(dir: string): Array<{ name: string; isSymlink: boolean }> | null {
  if (!existsSync(dir)) return null;
  return readdirSync(dir, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    isSymlink: entry.isSymbolicLink(),
  }));
}

test('segment walk rejects symlinked components inside the scope (real temp symlink)', (t) => {
  const scope = mkdtempSync(join(tmpdir(), 'bbmcp-scope-'));
  const outside = mkdtempSync(join(tmpdir(), 'bbmcp-outside-'));
  t.after(() => {
    rmSync(scope, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  mkdirSync(join(scope, 'real'));
  writeFileSync(join(outside, 'secret.txt'), 'outside');
  symlinkSync(outside, join(scope, 'link'));
  // A symlink as the final path component (the write target itself).
  writeFileSync(join(outside, 'target.json'), '{}');
  symlinkSync(join(outside, 'target.json'), join(scope, 'real', 'final-link.json'));

  const normalizedScope = normalizePath(scope)!;

  const throughLink = findSymlinkComponent(
    normalizedScope,
    `${normalizedScope}/link/secret.txt`,
    nodeListDir,
    existsSync,
  );
  assert.equal(throughLink.ok, false);
  if (!throughLink.ok) assert.equal(throughLink.error.code, 'E_PATH_OUTSIDE_SCOPE');

  const finalComponentLink = findSymlinkComponent(
    normalizedScope,
    `${normalizedScope}/real/final-link.json`,
    nodeListDir,
    existsSync,
  );
  assert.equal(finalComponentLink.ok, false, 'a symlink as the write target itself must be rejected');

  const realDir = findSymlinkComponent(normalizedScope, `${normalizedScope}/real/file.json`, nodeListDir, existsSync);
  assert.equal(realDir.ok, true);

  const notYetExisting = findSymlinkComponent(
    normalizedScope,
    `${normalizedScope}/new/dir/file.json`,
    nodeListDir,
    existsSync,
  );
  assert.equal(notYetExisting.ok, true);
});

test('segment walk joins drive-root and trailing-slash scopes without doubling separators', () => {
  const listed: string[] = [];
  const fakeListDir = (dir: string) => {
    listed.push(dir);
    if (dir === 'C:/') return [{ name: 'a', isSymlink: false }];
    if (dir === 'C:/a') return [{ name: 'evil', isSymlink: true }];
    return null;
  };
  const result = findSymlinkComponent('C:/', 'C:/a/evil/x.json', fakeListDir, () => false);
  assert.equal(result.ok, false, 'symlink below a drive-root scope must be detected');
  assert.ok(listed.every((dir) => !dir.includes('//')), `listDir received a malformed path: ${listed.join(', ')}`);

  // A trailing-slash scope root must behave like its canonical form.
  const trailing = findSymlinkComponent(
    '/scope/',
    '/scope/a/x.json',
    (dir) => (dir === '/scope' ? [{ name: 'a', isSymlink: true }] : null),
    () => false,
  );
  assert.equal(trailing.ok, false, 'trailing-slash scope roots must still detect symlinks');
});

test('segment walk matches entry names ignoring case, as case-insensitive filesystems resolve them', () => {
  const linked = findSymlinkComponent(
    '/scope',
    '/scope/renders/new.png',
    (dir) => (dir === '/scope' ? [{ name: 'Renders', isSymlink: true }] : null),
    () => false,
  );
  assert.equal(linked.ok, false, 'a symlink whose name differs only in case must be rejected');
  if (!linked.ok) assert.equal(linked.error.code, 'E_PATH_OUTSIDE_SCOPE');

  const listed: string[] = [];
  const plain = findSymlinkComponent(
    '/scope',
    '/scope/renders/new.png',
    (dir) => {
      listed.push(dir);
      if (dir === '/scope') return [{ name: 'Renders', isSymlink: false }];
      if (dir === '/scope/Renders') return [{ name: 'other.png', isSymlink: false }];
      return null;
    },
    () => false,
  );
  assert.equal(plain.ok, true, 'a differently cased real directory still passes');
  assert.deepEqual(listed, ['/scope', '/scope/Renders'], 'the walk descends through the matching entry');
});

test('segment walk rejects a component that exists under a name the listing does not show', () => {
  // Windows resolves an 8.3 short name or a trailing period to the listed
  // 'run_shared' entry, so either spelling would follow its link.
  const exists = (path: string) => path === '/scope/RUN_SH~1' || path === '/scope/run_shared.';
  for (const alias of ['RUN_SH~1', 'run_shared.']) {
    const listed: string[] = [];
    const result = findSymlinkComponent(
      '/scope',
      `/scope/${alias}/x.json`,
      (dir) => {
        listed.push(dir);
        return dir === '/scope' ? [{ name: 'run_shared', isSymlink: true }] : null;
      },
      exists,
    );
    assert.equal(result.ok, false, `${alias} must be rejected`);
    if (!result.ok) {
      assert.equal(result.error.code, 'E_PATH_OUTSIDE_SCOPE');
      assert.equal(result.error.path, `/scope/${alias}`);
    }
    assert.deepEqual(listed, ['/scope'], 'the walk must not list through the unlisted alias');
  }
});

test('segment walk rejects an unlisted alias-shaped component that the existence probe misses', () => {
  // The probe follows links, so an alias of a dangling link (for example
  // LONG_O~1.JSO for long_output_link.json -> a missing outside file)
  // reports missing although writing through it would create the target.
  const rootEntries = [
    { name: 'long_output_link.json', isSymlink: true },
    { name: 'run_shared', isSymlink: true },
    { name: 'name', isSymlink: true },
  ];
  for (const alias of ['LONG_O~1.JSO', 'RUN_SH~1', 'name.', 'name ']) {
    for (const path of [`/scope/${alias}`, `/scope/${alias}/x.json`]) {
      const listed: string[] = [];
      const result = findSymlinkComponent(
        '/scope',
        path,
        (dir) => {
          listed.push(dir);
          return dir === '/scope' ? rootEntries : null;
        },
        () => false,
      );
      assert.equal(result.ok, false, `${JSON.stringify(path)} must be rejected`);
      if (!result.ok) {
        assert.equal(result.error.code, 'E_PATH_OUTSIDE_SCOPE');
        assert.equal(result.error.path, `/scope/${alias}`);
      }
      assert.deepEqual(listed, ['/scope'], 'the walk must not list through the unlisted alias');
    }
  }
});

test('segment walk still accepts components that do not exist yet', () => {
  for (const relative of ['new/dir/x.json', 'tilde~name.json', 'a.b.json']) {
    const result = findSymlinkComponent(
      '/scope',
      `/scope/${relative}`,
      (dir) => (dir === '/scope' ? [{ name: 'run_shared', isSymlink: true }] : null),
      (path) => path === '/scope' || path === '/scope/run_shared',
    );
    assert.deepEqual(result, { ok: true }, `${relative} must be accepted`);
  }
});

test('segment walk matches entry names across Unicode normalization forms', () => {
  // exists reports nothing, so only the folded name match can reject these.
  const nfdListing = findSymlinkComponent(
    '/scope',
    '/scope/caf\u00e9/x.json',
    (dir) => (dir === '/scope' ? [{ name: 'cafe\u0301', isSymlink: true }] : null),
    () => false,
  );
  assert.equal(nfdListing.ok, false, 'an NFC request must match an NFD-listed symlink');
  if (!nfdListing.ok) assert.equal(nfdListing.error.code, 'E_PATH_OUTSIDE_SCOPE');

  const nfcListing = findSymlinkComponent(
    '/scope',
    '/scope/cafe\u0301/x.json',
    (dir) => (dir === '/scope' ? [{ name: 'caf\u00e9', isSymlink: true }] : null),
    () => false,
  );
  assert.equal(nfcListing.ok, false, 'an NFD request must match an NFC-listed symlink');
  if (!nfcListing.ok) assert.equal(nfcListing.error.code, 'E_PATH_OUTSIDE_SCOPE');
});

test('segment walk prefers an exactly named entry over folded siblings on distinguishing filesystems', () => {
  // A case- or normalization-sensitive filesystem can list both names; the OS
  // opens the exact one, so only that entry decides.
  const unicodeEntries = [
    { name: 'caf\u00e9.json', isSymlink: false },
    { name: 'cafe\u0301.json', isSymlink: true },
  ];
  const unicodeListDir = (dir: string) => (dir === '/scope' ? unicodeEntries : null);
  assert.deepEqual(
    findSymlinkComponent('/scope', '/scope/caf\u00e9.json', unicodeListDir, () => false),
    { ok: true },
    'the exact NFC regular file must be accepted',
  );
  const nfdLink = findSymlinkComponent('/scope', '/scope/cafe\u0301.json', unicodeListDir, () => false);
  assert.equal(nfdLink.ok, false, 'the exact NFD symlink must be rejected');
  if (!nfdLink.ok) assert.equal(nfdLink.error.code, 'E_PATH_OUTSIDE_SCOPE');

  const listed: string[] = [];
  const caseListDir = (dir: string) => {
    listed.push(dir);
    if (dir === '/scope') {
      return [
        { name: 'Foo', isSymlink: false },
        { name: 'foo', isSymlink: true },
      ];
    }
    return dir === '/scope/Foo' ? [] : null;
  };
  assert.deepEqual(
    findSymlinkComponent('/scope', '/scope/Foo/x.json', caseListDir, () => false),
    { ok: true },
    'the exactly cased real directory must be accepted',
  );
  assert.deepEqual(listed, ['/scope', '/scope/Foo'], 'the walk descends through the exact entry');
  const lowerLink = findSymlinkComponent('/scope', '/scope/foo/x.json', caseListDir, () => false);
  assert.equal(lowerLink.ok, false, 'the exactly cased symlink must be rejected');
  if (!lowerLink.ok) assert.equal(lowerLink.error.code, 'E_PATH_OUTSIDE_SCOPE');
});

test('normalizePath handles UNC prefixes and drive roots', () => {
  assert.equal(normalizePath('//server/share/dir/../file'), '//server/share/file');
  assert.equal(normalizePath('C:/'), 'C:/');
  assert.equal(normalizePath('C:\\scope\\'), 'C:/scope');
});

test('resolveInScope rejects NTFS alternate data streams and reserved device names', () => {
  const ads = resolveInScope('/scope', 'model.json:hidden');
  assert.equal(ads.ok, false);
  if (!ads.ok) assert.equal(ads.error.code, 'E_INVALID_PARAMS');

  const device = resolveInScope('/scope', 'textures/CON');
  assert.equal(device.ok, false);

  const deviceWithExt = resolveInScope('/scope', 'NUL.json');
  assert.equal(deviceWithExt.ok, false);
});

test('multi-file preflight aggregates every blocker and reports duplicates, conflicts, and escapes', (t) => {
  const scope = mkdtempSync(join(tmpdir(), 'bbmcp-preflight-'));
  t.after(() => rmSync(scope, { recursive: true, force: true }));
  const normalizedScope = normalizePath(scope)!;
  writeFileSync(join(scope, 'existing.json'), '{}');

  const { blockers } = preflightWrites(
    normalizedScope,
    [
      { path: 'new.json' },
      { path: 'existing.json' }, // conflict without overwrite flag
      { path: 'existing.json', overwrite: true }, // duplicate destination in batch
      { path: '../escape.json' }, // outside scope
    ],
    (p) => existsSync(p),
    nodeListDir,
  );

  const codes = blockers.map((b) => b.code).sort();
  assert.deepEqual(codes, ['E_FILE_EXISTS', 'E_PATH_OUTSIDE_SCOPE', 'E_PREFLIGHT_FAILED']);
  const conflictBlocker = blockers.find((b) => b.code === 'E_FILE_EXISTS');
  assert.ok(conflictBlocker && conflictBlocker.path.endsWith('/existing.json'));
});

test('preflight with an explicit overwrite flag and clean destinations reports no blockers', (t) => {
  const scope = mkdtempSync(join(tmpdir(), 'bbmcp-preflight-ok-'));
  t.after(() => rmSync(scope, { recursive: true, force: true }));
  const normalizedScope = normalizePath(scope)!;
  writeFileSync(join(scope, 'existing.json'), '{}');

  const { blockers, resolvedPaths } = preflightWrites(
    normalizedScope,
    [{ path: 'fresh.json' }, { path: 'existing.json', overwrite: true }],
    (p) => existsSync(p),
    nodeListDir,
  );

  assert.deepEqual(blockers, []);
  assert.equal(resolvedPaths.length, 2);
  assert.ok(resolvedPaths[0].endsWith('/fresh.json'));
});

test('preflight normalizes the scope root before the symlink walk (fail-closed wiring)', (t) => {
  const scope = mkdtempSync(join(tmpdir(), 'bbmcp-preflight-slash-'));
  const outside = mkdtempSync(join(tmpdir(), 'bbmcp-preflight-out-'));
  t.after(() => {
    rmSync(scope, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  mkdirSync(join(scope, 'a'));
  symlinkSync(outside, join(scope, 'a', 'evil'));

  // Trailing-slash scope root: the symlink below it must still be detected.
  const { blockers } = preflightWrites(
    `${normalizePath(scope)!}/`,
    [{ path: 'a/evil/x.json' }],
    (p) => existsSync(p),
    nodeListDir,
  );
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].code, 'E_PATH_OUTSIDE_SCOPE');
});

test('preflight flags case-variant duplicate destinations in one batch', (t) => {
  const scope = mkdtempSync(join(tmpdir(), 'bbmcp-preflight-case-'));
  t.after(() => rmSync(scope, { recursive: true, force: true }));

  const { blockers } = preflightWrites(
    normalizePath(scope)!,
    [{ path: 'Model.json' }, { path: 'model.json' }],
    (p) => existsSync(p),
    nodeListDir,
  );
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].code, 'E_PREFLIGHT_FAILED');
});
