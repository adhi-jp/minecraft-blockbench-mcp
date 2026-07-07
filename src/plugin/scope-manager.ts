// Session-only scoped-directory state machine. Browser-safe: the confirmation
// dialog, scoped-filesystem factory, and previous-grant memo storage are all
// injected so the logic is unit-testable in Node.
//
// Access lifecycle (per spec): a directory proposed by the AI client becomes
// usable only after the Blockbench user confirms it inside Blockbench, the
// grant lasts for the current session only, it is revocable mid-session, and
// after a plugin reload the previous grant reports as expired until the user
// confirms again.
import { normalizePath } from '../shared/scope.js';
import type { ScopeStatus } from '../shared/protocol.js';
import { CommandError } from './session.js';

/** Minimal scoped-filesystem surface the file commands need (a subset of
 * Blockbench's `requireNativeModule('fs', {scope})` wrapper). */
export interface ScopedFsLike {
  readFileSync(path: string, options?: unknown): unknown;
  writeFileSync(path: string, content: unknown, options?: unknown): unknown;
  existsSync(path: string): boolean;
  mkdirSync(path: string, options?: unknown): unknown;
  readdirSync(path: string, options?: unknown): unknown;
  statSync(path: string, options?: unknown): { size: number };
}

export interface ScopeManagerOptions {
  /** Shows the in-Blockbench confirmation dialog; resolves true on confirm. */
  confirmDialog: (normalizedPath: string, reason: string | undefined) => Promise<boolean>;
  /** Acquires the scoped filesystem for a confirmed directory (may trigger
   * Blockbench's own native permission dialog); null when the user denies it. */
  acquireScopedFs: (normalizedPath: string) => ScopedFsLike | null;
  /** Remembers the last confirmed path across sessions (never grants access;
   * only lets the next session report "expired" instead of "unconfirmed"). */
  memo: {
    get: () => string | null;
    set: (path: string | null) => void;
  };
  onScopeChanged?: (status: ScopeStatus) => void;
}

export class ScopeManager {
  readonly #options: ScopeManagerOptions;
  #state: ScopeStatus['state'];
  #normalizedPath: string | null = null;
  #fs: ScopedFsLike | null = null;
  #proposalInFlight = false;

  constructor(options: ScopeManagerOptions) {
    this.#options = options;
    const previous = options.memo.get();
    if (previous !== null && previous !== '') {
      this.#state = 'expired';
      this.#normalizedPath = previous;
    } else {
      this.#state = 'unconfirmed';
    }
  }

  get status(): ScopeStatus {
    return this.#normalizedPath === null
      ? { state: this.#state }
      : { state: this.#state, normalized_path: this.#normalizedPath };
  }

  /** The scoped filesystem for file commands; throws a distinguishable
   * machine-readable error when no confirmed scope is available. */
  get fs(): ScopedFsLike {
    if (this.#state === 'confirmed' && this.#fs !== null) return this.#fs;
    throw this.#scopeError();
  }

  get confirmedPath(): string {
    if (this.#state === 'confirmed' && this.#normalizedPath !== null) return this.#normalizedPath;
    throw this.#scopeError();
  }

  #scopeError(): CommandError {
    switch (this.#state) {
      case 'revoked':
        return new CommandError(
          'E_SCOPE_REVOKED',
          'The Blockbench user revoked the scoped directory. Propose a directory again to restore file access.',
        );
      case 'expired':
        return new CommandError(
          'E_SCOPE_EXPIRED',
          'The scoped-directory confirmation expired with the previous session. Propose a directory again.',
          this.#normalizedPath !== null ? { previous_path: this.#normalizedPath } : undefined,
        );
      default:
        return new CommandError(
          'E_SCOPE_NOT_CONFIRMED',
          'No scoped directory has been confirmed by the Blockbench user. Use propose_scoped_directory first.',
        );
    }
  }

  #emit(): void {
    this.#options.onScopeChanged?.(this.status);
  }

  /** Handle propose_scoped_directory: dialog → scoped-fs acquisition. */
  async propose(path: string, reason: string | undefined): Promise<{ state: 'confirmed'; normalized_path: string }> {
    if (this.#proposalInFlight) {
      throw new CommandError('E_INVALID_PARAMS', 'Another scoped-directory proposal is already awaiting the user.');
    }
    const normalized = normalizePath(path);
    if (normalized === null || !(normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized))) {
      throw new CommandError('E_INVALID_PARAMS', 'The proposed scoped directory must be a valid absolute path.', {
        path,
      });
    }
    this.#proposalInFlight = true;
    this.#state = 'proposed';
    this.#normalizedPath = normalized;
    this.#emit();
    try {
      const confirmed = await this.#options.confirmDialog(normalized, reason);
      if (!confirmed) {
        this.#state = 'unconfirmed';
        this.#normalizedPath = null;
        this.#emit();
        throw new CommandError('E_SCOPE_NOT_CONFIRMED', 'The Blockbench user rejected the proposed scoped directory.', {
          reason: 'user_rejected',
          proposed_path: normalized,
        });
      }
      const fs = this.#options.acquireScopedFs(normalized);
      if (fs === null) {
        this.#state = 'unconfirmed';
        this.#normalizedPath = null;
        this.#emit();
        throw new CommandError(
          'E_SCOPE_NOT_CONFIRMED',
          'Blockbench denied filesystem access for the proposed directory.',
          { reason: 'native_permission_denied', proposed_path: normalized },
        );
      }
      this.#fs = fs;
      this.#state = 'confirmed';
      this.#normalizedPath = normalized;
      this.#options.memo.set(normalized);
      this.#emit();
      return { state: 'confirmed', normalized_path: normalized };
    } finally {
      this.#proposalInFlight = false;
    }
  }

  /** In-session revocation by the Blockbench user. */
  revoke(): void {
    this.#fs = null;
    if (this.#state === 'confirmed' || this.#state === 'proposed') {
      this.#state = 'revoked';
      this.#emit();
    }
  }

  /** Called on plugin unload: drop the handle without emitting further events. */
  dispose(): void {
    this.#fs = null;
  }
}
