import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerScopeCommands } from '../src/plugin/commands/scope-commands.js';
import { type CommandHandler, type PluginSession } from '../src/plugin/session.js';
import { ScopeManager, type ScopedFsLike } from '../src/plugin/scope-manager.js';
import type { ScopeStatus } from '../src/shared/protocol.js';

const fakeFs = {} as ScopedFsLike;

interface ScopeHarness {
  scope: ScopeManager;
  events: ScopeStatus[];
  memoValue: () => string | null;
}

function makeScope(): ScopeHarness {
  const events: ScopeStatus[] = [];
  let memo: string | null = null;
  const scope = new ScopeManager({
    confirmDialog: () => Promise.resolve(true),
    acquireScopedFs: () => fakeFs,
    memo: {
      get: () => memo,
      set: (value) => {
        memo = value;
      },
    },
    onScopeChanged: (status) => events.push(status),
  });
  return { scope, events, memoValue: () => memo };
}

function registerHandlers(scope: ScopeManager): Map<string, CommandHandler> {
  const handlers = new Map<string, CommandHandler>();
  const session = {
    registerHandler(command: string, handler: CommandHandler): void {
      handlers.set(command, handler);
    },
  } as unknown as PluginSession;
  registerScopeCommands(session, scope);
  return handlers;
}

test('registering scope commands exposes exactly the revoke_scope handler', () => {
  const { scope } = makeScope();
  const handlers = registerHandlers(scope);
  assert.deepEqual([...handlers.keys()], ['revoke_scope']);
});

test('revoke_scope revokes a confirmed scope and reports the resulting state', async () => {
  const { scope, events, memoValue } = makeScope();
  await scope.propose('/home/user/models', 'write model files');
  const handler = registerHandlers(scope).get('revoke_scope');
  assert.ok(handler !== undefined);

  const result = await handler({});

  assert.deepEqual(result, { state: 'revoked', normalized_path: '/home/user/models' });
  assert.deepEqual(scope.status, { state: 'revoked', normalized_path: '/home/user/models' });
  assert.equal(memoValue(), null);
  assert.deepEqual(events.map((event) => event.state), ['proposed', 'confirmed', 'revoked']);
});

test('revoke_scope leaves an unconfirmed scope unchanged without emitting scope_changed', async () => {
  const { scope, events } = makeScope();
  const handler = registerHandlers(scope).get('revoke_scope');
  assert.ok(handler !== undefined);

  const result = await handler({});

  assert.deepEqual(result, { state: 'unconfirmed' });
  assert.deepEqual(scope.status, { state: 'unconfirmed' });
  assert.deepEqual(events, []);
});
