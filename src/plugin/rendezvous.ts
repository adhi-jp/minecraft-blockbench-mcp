// Rendezvous config-file source for the plugin: resolves the connection
// port/secret from the explicit settings or the shared per-user config file
// written by the setup CLI. Injectable and Blockbench-free so the precedence,
// validation, and permission state machine are unit-testable.
//
// Permission policy: at most one native permission dialog per plugin session.
// A granted filesystem handle is retained and re-used for every later read
// ("Allow once" therefore works for the whole session); after a deny only
// silent probes run, so the reconnect loop can never spam dialogs. Changing
// the config-path setting re-arms a single prompt.
import { DEFAULT_WS_PORT } from '../shared/protocol.js';
import { parentDirectory } from '../shared/config-path.js';

export interface RendezvousFsLike {
  readFileSync(path: string, options?: unknown): unknown;
  existsSync(path: string): boolean;
}

/** Wraps requireNativeModule('fs', ...): `allowPrompt` controls whether the
 * native permission dialog may appear; a silent probe returns undefined when
 * no persisted grant exists. */
export type AcquireRendezvousFs = (scopeDirectory: string, allowPrompt: boolean) => RendezvousFsLike | null | undefined;

export type RendezvousDetail =
  | 'settings'
  | 'file'
  | 'no-path'
  | 'not-granted'
  | 'declined'
  | 'missing'
  | 'unreadable'
  | 'invalid-format';

export interface RendezvousSnapshot {
  /** Where the connection values came from. */
  source: 'settings' | 'file' | 'none';
  detail: RendezvousDetail;
  port: number;
  secret: string;
  path: string | null;
}

export interface RendezvousSourceOptions {
  acquireFs: AcquireRendezvousFs;
  /** Same-OS default path (derived from SystemInfo); null when underivable. */
  defaultPath: () => string | null;
  /** The "MCP Config File Path" setting; empty string when unset. */
  explicitPath: () => string;
  /** The "MCP Shared Secret" setting; empty string when unset. */
  settingsSecret: () => string;
  /** The "MCP Adapter Port" setting value. */
  settingsPort: () => number;
}

interface ParsedRendezvousFile {
  ok: boolean;
  port: number | null;
  secret: string;
}

function parseRendezvousFile(raw: string): ParsedRendezvousFile {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, port: null, secret: '' };
    const record = parsed as Record<string, unknown>;
    if (record.version !== undefined && record.version !== 1) return { ok: false, port: null, secret: '' };
    if (record.mode !== undefined && record.mode !== 'shared-secret') return { ok: false, port: null, secret: '' };
    if (typeof record.secret !== 'string' || record.secret === '') return { ok: false, port: null, secret: '' };
    const port =
      typeof record.port === 'number' && Number.isInteger(record.port) && record.port >= 1 && record.port <= 65_535
        ? record.port
        : null;
    return { ok: true, port, secret: record.secret };
  } catch {
    return { ok: false, port: null, secret: '' };
  }
}

export class RendezvousSource {
  #options: RendezvousSourceOptions;
  #promptArmed = true;
  #retainedFs: RendezvousFsLike | null = null;
  #retainedScope: string | null = null;
  #lastDetail: RendezvousDetail = 'no-path';
  #lastPath: string | null = null;

  constructor(options: RendezvousSourceOptions) {
    this.#options = options;
  }

  /** Re-arms a single permission prompt (called when the config-path setting changes). */
  noteConfigPathChanged(): void {
    this.#promptArmed = true;
    this.#retainedFs = null;
    this.#retainedScope = null;
  }

  /** Resolves the current connection values; at most one prompt per session. */
  snapshot(): RendezvousSnapshot {
    const settingsSecret = this.#options.settingsSecret();
    if (settingsSecret !== '') {
      this.#lastDetail = 'settings';
      this.#lastPath = null;
      return { source: 'settings', detail: 'settings', port: this.#options.settingsPort(), secret: settingsSecret, path: null };
    }

    const explicit = this.#options.explicitPath();
    const path = explicit !== '' ? explicit : this.#options.defaultPath();
    this.#lastPath = path;
    if (path === null || path === '') return this.#finish('no-path', null);

    const scope = parentDirectory(path);
    let fs = this.#retainedFs !== null && this.#retainedScope === scope ? this.#retainedFs : null;
    if (fs === null) {
      const allowPrompt = this.#promptArmed;
      if (allowPrompt) this.#promptArmed = false;
      const acquired = this.#options.acquireFs(scope, allowPrompt);
      if (acquired === null || acquired === undefined) {
        return this.#finish(allowPrompt ? 'declined' : 'not-granted', path);
      }
      fs = acquired;
      this.#retainedFs = fs;
      this.#retainedScope = scope;
    }

    let raw: string;
    try {
      if (!fs.existsSync(path)) return this.#finish('missing', path);
      const content = fs.readFileSync(path, 'utf8');
      raw = typeof content === 'string' ? content : String(content);
    } catch {
      return this.#finish('unreadable', path);
    }

    const parsed = parseRendezvousFile(raw);
    if (!parsed.ok) return this.#finish('invalid-format', path);
    this.#lastDetail = 'file';
    return {
      source: 'file',
      detail: 'file',
      port: parsed.port ?? this.#options.settingsPort(),
      secret: parsed.secret,
      path,
    };
  }

  #finish(detail: RendezvousDetail, path: string | null): RendezvousSnapshot {
    this.#lastDetail = detail;
    return { source: 'none', detail, port: this.#options.settingsPort(), secret: '', path };
  }

  /** Status text for the last snapshot; performs no acquisition or read. */
  describe(): string {
    switch (this.#lastDetail) {
      case 'settings':
        return 'plugin settings (port/secret entered in Blockbench)';
      case 'file':
        return `config file ${this.#lastPath ?? ''}`.trim();
      case 'no-path':
        return 'not configured (no settings and no config file path)';
      case 'declined':
      case 'not-granted':
        return `config file access not granted${this.#lastPath !== null ? ` (${this.#lastPath})` : ''} — change "MCP Config File Path" to be asked again, or enter the settings manually`;
      case 'missing':
        return `config file not found${this.#lastPath !== null ? ` (${this.#lastPath})` : ''}`;
      case 'unreadable':
        return `config file could not be read${this.#lastPath !== null ? ` (${this.#lastPath})` : ''}`;
      case 'invalid-format':
        return `config file has an unrecognized format${this.#lastPath !== null ? ` (${this.#lastPath})` : ''}`;
    }
  }
}

export const RENDEZVOUS_DEFAULT_PORT = DEFAULT_WS_PORT;
