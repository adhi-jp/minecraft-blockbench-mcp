// Pure scoped-directory path logic shared by the adapter tests and the plugin.
// No Node builtins: path handling is self-written lexical string logic so it
// compiles under both the adapter (Node) and plugin (browser) configurations.
//
// Path policy: comparisons are case-sensitive and lexical. Both '/' and '\'
// are accepted as separators in input; normalized output uses '/'. Windows
// drive letters ('C:') and UNC prefixes ('//server/share') are preserved.
// Duplicate-destination detection additionally folds case and Unicode (NFC),
// and the symlink check folds case, because the common Blockbench desktop
// filesystems (Windows, macOS) are case-insensitive.

import type { ErrorCode } from './protocol.js';

export interface ScopeCheckError {
  code: ErrorCode;
  message: string;
  path?: string;
}

const WINDOWS_DRIVE_RE = /^[A-Za-z]:$/;

// Legacy Windows device names are not regular files; writing to them has
// surprising semantics, so they are rejected as path segments.
const WINDOWS_RESERVED_BASENAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

/** True when the (already separator-normalized) path starts at a filesystem root. */
function isAbsoluteNormalized(path: string): boolean {
  if (path.startsWith('/')) return true;
  const firstSegment = path.split('/', 1)[0] ?? '';
  return WINDOWS_DRIVE_RE.test(firstSegment);
}

/**
 * Lexically normalize a path: unify separators to '/', resolve '.' and '..'
 * segments, and drop trailing slashes (except a bare root). Returns null when
 * '..' would traverse above the root of an absolute path.
 */
export function normalizePath(input: string): string | null {
  const unified = input.replace(/\\/g, '/');
  const isUnc = unified.startsWith('//');
  const absolute = isAbsoluteNormalized(unified);
  const segments = unified.split('/');
  const out: string[] = [];
  let driveOrRoot = '';

  let startIndex = 0;
  if (absolute) {
    if (isUnc) {
      driveOrRoot = '//';
      startIndex = 2;
    } else if (unified.startsWith('/')) {
      driveOrRoot = '/';
      startIndex = 1;
    } else {
      // Windows drive-letter path such as C:/...
      driveOrRoot = `${segments[0]}/`;
      startIndex = 1;
    }
  }

  for (let i = startIndex; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0) {
        out.pop();
      } else if (absolute) {
        return null; // traversal above the root
      } else {
        out.push('..');
      }
      continue;
    }
    out.push(segment);
  }

  if (absolute) {
    const joined = out.join('/');
    if (driveOrRoot === '/') return `/${joined}`;
    if (driveOrRoot === '//') return joined.length > 0 ? `//${joined}` : '//';
    return joined.length > 0 ? `${driveOrRoot}${joined}` : driveOrRoot;
  }
  return out.length > 0 ? out.join('/') : '.';
}

/** Join a normalized directory and a child segment without doubling separators. */
function joinSegment(dir: string, segment: string): string {
  return dir.endsWith('/') ? `${dir}${segment}` : `${dir}/${segment}`;
}

/** True when `path` equals `scope` or sits below it (separator-aware; both must be normalized). */
export function isContained(scope: string, path: string): boolean {
  if (path === scope) return true;
  const prefix = scope.endsWith('/') ? scope : `${scope}/`;
  return path.startsWith(prefix);
}

/**
 * Validate the file-name segments of a normalized in-scope path (the part
 * below the scope root): rejects NTFS alternate-data-stream separators (':')
 * and legacy Windows device basenames.
 */
function findUnsafeSegment(relativeSegments: string[]): string | null {
  for (const segment of relativeSegments) {
    if (segment.includes(':')) return segment;
    if (WINDOWS_RESERVED_BASENAMES.test(segment)) return segment;
  }
  return null;
}

function relativeSegmentsBelow(scope: string, normalizedPath: string): string[] {
  if (normalizedPath === scope) return [];
  const start = scope.endsWith('/') ? scope.length : scope.length + 1;
  return normalizedPath.slice(start).split('/');
}

/**
 * Resolve an AI-supplied file path against a confirmed scope root.
 * Accepts absolute paths (must lie inside the scope) and scope-relative paths.
 * Returns the normalized absolute path or a machine-readable scope error.
 */
export function resolveInScope(
  scopeRoot: string,
  inputPath: string,
): { ok: true; path: string } | { ok: false; error: ScopeCheckError } {
  const scope = normalizePath(scopeRoot);
  if (scope === null || !isAbsoluteNormalized(scope)) {
    return {
      ok: false,
      error: { code: 'E_SCOPE_NOT_CONFIRMED', message: 'Scope root is not a valid absolute path.' },
    };
  }
  const trimmed = inputPath.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      error: { code: 'E_INVALID_PARAMS', message: 'File path must not be empty.', path: inputPath },
    };
  }
  const unified = trimmed.replace(/\\/g, '/');
  const candidate = isAbsoluteNormalized(unified) ? unified : `${scope.endsWith('/') ? scope : `${scope}/`}${unified}`;
  const normalized = normalizePath(candidate);
  if (normalized === null || !isContained(scope, normalized)) {
    return {
      ok: false,
      error: {
        code: 'E_PATH_OUTSIDE_SCOPE',
        message: 'Path is outside the confirmed scoped directory.',
        path: normalized ?? inputPath,
      },
    };
  }
  const unsafeSegment = findUnsafeSegment(relativeSegmentsBelow(scope, normalized));
  if (unsafeSegment !== null) {
    return {
      ok: false,
      error: {
        code: 'E_INVALID_PARAMS',
        message: `Path segment "${unsafeSegment}" is not allowed (reserved name or ':' in file names).`,
        path: normalized,
      },
    };
  }
  return { ok: true, path: normalized };
}

/**
 * Segment-walk symlink rejection. Walks each component of `normalizedPath`
 * strictly below the (normalized) scope root and rejects the path when any
 * component — including the final one — is a symbolic link, matching entry
 * names ignoring case. Blockbench's
 * scoped filesystem does not resolve symlinks, so a link inside the scope
 * could otherwise escape it.
 *
 * `listDir(dir)` contract: return the entries of `dir` with symlink flags;
 * return null ONLY when `dir` does not exist (missing components are fine for
 * write destinations); THROW on any other failure (permission errors,
 * not-a-directory, I/O errors) so unexpected states fail closed instead of
 * silently skipping the symlink check.
 */
export function findSymlinkComponent(
  scopeRoot: string,
  normalizedPath: string,
  listDir: (dir: string) => Array<{ name: string; isSymlink: boolean }> | null,
): { ok: true } | { ok: false; error: ScopeCheckError } {
  const scope = normalizePath(scopeRoot);
  if (scope === null || !isAbsoluteNormalized(scope)) {
    return {
      ok: false,
      error: { code: 'E_SCOPE_NOT_CONFIRMED', message: 'Scope root is not a valid absolute path.' },
    };
  }
  if (!isContained(scope, normalizedPath)) {
    return {
      ok: false,
      error: {
        code: 'E_PATH_OUTSIDE_SCOPE',
        message: 'Path is outside the confirmed scoped directory.',
        path: normalizedPath,
      },
    };
  }
  if (normalizedPath === scope) return { ok: true };

  const segments = relativeSegmentsBelow(scope, normalizedPath);
  let currentDir = scope;
  for (const segment of segments) {
    const entries = listDir(currentDir);
    if (entries === null) return { ok: true }; // remaining components do not exist yet
    // Case-insensitive filesystems resolve a differently cased name to the
    // same entry, so a link matching the segment ignoring case is rejected.
    const folded = segment.toLowerCase();
    const matches = entries.filter((e) => e.name.toLowerCase() === folded);
    if (matches.length === 0) return { ok: true }; // this component does not exist yet
    if (matches.some((e) => e.isSymlink)) {
      return {
        ok: false,
        error: {
          code: 'E_PATH_OUTSIDE_SCOPE',
          message: 'Symbolic links inside the scoped directory are not allowed.',
          path: joinSegment(currentDir, segment),
        },
      };
    }
    const entry = matches.find((e) => e.name === segment) ?? matches[0];
    currentDir = joinSegment(currentDir, entry.name);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Multi-file write preflight
// ---------------------------------------------------------------------------

export interface WriteRequestLike {
  path: string;
  overwrite?: boolean | undefined;
}

export interface PreflightBlocker {
  path: string;
  code: ErrorCode;
  message: string;
}

/** Duplicate-destination key: case-folded and NFC-normalized, because the
 * common Blockbench desktop filesystems are case-insensitive. */
function duplicateKey(normalizedPath: string): string {
  return normalizedPath.normalize('NFC').toLowerCase();
}

/**
 * Preflight a batch of write destinations against the confirmed scope.
 * Detects out-of-scope paths, symlinked components, duplicate destinations in
 * the same batch (case/Unicode-folded), and existing destinations without an
 * explicit per-file overwrite flag. Returns every blocker; callers must write
 * nothing when any blocker exists.
 */
export function preflightWrites(
  scopeRoot: string,
  files: WriteRequestLike[],
  fileExists: (normalizedPath: string) => boolean,
  listDir: (dir: string) => Array<{ name: string; isSymlink: boolean }> | null,
): { blockers: PreflightBlocker[]; resolvedPaths: string[] } {
  const blockers: PreflightBlocker[] = [];
  const resolvedPaths: string[] = [];

  const scope = normalizePath(scopeRoot);
  if (scope === null || !isAbsoluteNormalized(scope)) {
    return {
      blockers: [
        { path: scopeRoot, code: 'E_SCOPE_NOT_CONFIRMED', message: 'Scope root is not a valid absolute path.' },
      ],
      resolvedPaths: files.map((f) => f.path),
    };
  }

  const seen = new Set<string>();

  for (const file of files) {
    const resolved = resolveInScope(scope, file.path);
    if (!resolved.ok) {
      blockers.push({
        path: resolved.error.path ?? file.path,
        code: resolved.error.code,
        message: resolved.error.message,
      });
      resolvedPaths.push(file.path);
      continue;
    }
    const path = resolved.path;
    resolvedPaths.push(path);

    const symlinkCheck = findSymlinkComponent(scope, path, listDir);
    if (!symlinkCheck.ok) {
      blockers.push({ path, code: symlinkCheck.error.code, message: symlinkCheck.error.message });
      continue;
    }

    const key = duplicateKey(path);
    if (seen.has(key)) {
      blockers.push({
        path,
        code: 'E_PREFLIGHT_FAILED',
        message: 'Duplicate destination path in the same write batch (paths are compared case-insensitively).',
      });
    } else {
      seen.add(key);
    }

    if (fileExists(path) && file.overwrite !== true) {
      blockers.push({
        path,
        code: 'E_FILE_EXISTS',
        message: 'Destination exists and the request does not set the explicit overwrite flag for this file.',
      });
    }
  }

  return { blockers, resolvedPaths };
}
