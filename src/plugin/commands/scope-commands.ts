// Plugin-side handlers for broker control of the scoped-directory lifecycle.
import type { PluginSession } from '../session.js';
import type { ScopeManager } from '../scope-manager.js';

export function registerScopeCommands(session: PluginSession, scope: ScopeManager): void {
  session.registerHandler('revoke_scope', () => {
    scope.revoke();
    return scope.status;
  });
}
