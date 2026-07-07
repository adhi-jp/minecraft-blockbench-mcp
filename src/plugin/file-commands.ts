// Scoped file command logic (read_file / write_files / single-destination
// writes for exports). Browser-safe and unit-testable: all filesystem access
// goes through the injected scoped-FS surface, and every path is checked with
// the shared containment + symlink rules BEFORE any I/O.
import { DEFAULTS, type WriteResult } from '../shared/protocol.js';
import { resolveInScope, findSymlinkComponent, preflightWrites } from '../shared/scope.js';
import { CommandError } from './session.js';
import type { ScopeManager, ScopedFsLike } from './scope-manager.js';

interface DirEntryLike {
  name: string;
  isSymbolicLink(): boolean;
}

/** listDir adapter over the scoped FS, matching the shared walk contract:
 * entries with symlink flags, null ONLY for missing directories, throw on
 * any other failure (fail closed). */
export function makeListDir(fs: ScopedFsLike): (dir: string) => Array<{ name: string; isSymlink: boolean }> | null {
  return (dir) => {
    if (!fs.existsSync(dir)) return null;
    const entries = fs.readdirSync(dir, { withFileTypes: true }) as DirEntryLike[];
    return entries.map((entry) => ({ name: entry.name, isSymlink: entry.isSymbolicLink() }));
  };
}

/** Resolve an AI-supplied path against the confirmed scope and reject
 * symlinked components. Throws machine-readable CommandErrors. */
export function resolveForIo(scope: ScopeManager, inputPath: string): string {
  const root = scope.confirmedPath; // throws the distinguishable scope-state error
  const resolved = resolveInScope(root, inputPath);
  if (!resolved.ok) {
    throw new CommandError(resolved.error.code, resolved.error.message, { path: resolved.error.path });
  }
  const walk = findSymlinkComponent(root, resolved.path, makeListDir(scope.fs));
  if (!walk.ok) {
    throw new CommandError(walk.error.code, walk.error.message, { path: walk.error.path });
  }
  return resolved.path;
}

const READ_DEFAULT_MAX_BYTES = DEFAULTS.maxTextureDataUrlBytes;

export interface ReadFileParams {
  path: string;
  encoding?: 'utf8' | 'base64' | undefined;
  max_bytes?: number | undefined;
}

export function readFileCommand(
  scope: ScopeManager,
  params: ReadFileParams,
): { path: string; content: string; encoding: 'utf8' | 'base64'; bytes: number } {
  const path = resolveForIo(scope, params.path);
  const fs = scope.fs;
  if (!fs.existsSync(path)) {
    throw new CommandError('E_NOT_FOUND', 'The requested file does not exist inside the scoped directory.', { path });
  }
  const size = fs.statSync(path).size;
  const limit = params.max_bytes ?? READ_DEFAULT_MAX_BYTES;
  if (size > limit) {
    throw new CommandError('E_INVALID_PARAMS', `File is ${size} bytes, which exceeds the read limit of ${limit}.`, {
      path,
      size,
      limit,
    });
  }
  const encoding = params.encoding ?? 'utf8';
  const content = String(fs.readFileSync(path, encoding === 'utf8' ? 'utf8' : 'base64'));
  return { path, content, encoding, bytes: size };
}

export interface WriteFileEntry {
  path: string;
  content: string;
  encoding?: 'utf8' | 'base64' | undefined;
  overwrite?: boolean | undefined;
}

function parentDirOf(path: string): string | null {
  const index = path.lastIndexOf('/');
  if (index <= 0) return null;
  return path.slice(0, index);
}

/**
 * Multi-file write: preflight every destination first and write nothing when
 * any blocker exists. Runtime I/O failures after a clean preflight abort the
 * remaining writes and report what was completed (no rollback).
 */
export function writeFilesCommand(scope: ScopeManager, files: WriteFileEntry[]): { results: WriteResult[] } {
  const root = scope.confirmedPath;
  const fs = scope.fs;
  const listDir = makeListDir(fs);

  const { blockers, resolvedPaths } = preflightWrites(root, files, (path) => fs.existsSync(path), listDir);
  if (blockers.length > 0) {
    // Single-destination writes surface the concrete blocker code directly
    // (e.g. E_FILE_EXISTS for an overwrite conflict); batches report the
    // aggregated preflight blocker list.
    if (files.length === 1) {
      throw new CommandError(blockers[0].code, blockers[0].message, { path: blockers[0].path, blockers });
    }
    throw new CommandError('E_PREFLIGHT_FAILED', 'Write preflight found blockers; no file was written.', {
      blockers,
    });
  }

  const results: WriteResult[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const path = resolvedPaths[i];
    try {
      const existedBefore = fs.existsSync(path);
      const parent = parentDirOf(path);
      if (parent !== null && !fs.existsSync(parent)) {
        fs.mkdirSync(parent, { recursive: true });
      }
      const encoding = file.encoding ?? 'utf8';
      fs.writeFileSync(path, file.content, { encoding: encoding === 'utf8' ? 'utf8' : 'base64' });
      results.push({
        path,
        status: existedBefore ? 'overwritten' : 'created',
        bytes: fs.statSync(path).size,
      });
    } catch (error) {
      throw new CommandError(
        'E_BLOCKBENCH_ERROR',
        `Writing failed at ${path} after preflight passed; earlier files in the batch were already written.`,
        {
          failed_path: path,
          reason: error instanceof Error ? error.message : String(error),
          completed: results,
        },
      );
    }
  }
  return { results };
}

/** Single-destination write used by export_model; same preflight rules. */
export function writeSingleFile(
  scope: ScopeManager,
  path: string,
  content: string,
  overwrite: boolean | undefined,
): WriteResult {
  const { results } = writeFilesCommand(scope, [{ path, content, encoding: 'utf8', overwrite }]);
  return results[0];
}
