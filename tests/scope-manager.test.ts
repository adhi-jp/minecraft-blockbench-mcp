// Unit tests for the session-only scoped-directory state machine, with the
// confirmation dialog, scoped-fs factory, and memo storage injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ScopeManager, type ScopedFsLike } from '../src/plugin/scope-manager.js';
import { CommandError } from '../src/plugin/session.js';
import type { ScopeStatus } from '../src/shared/protocol.js';

const fakeFs = {} as ScopedFsLike;

interface Harness {
  manager: ScopeManager;
  events: ScopeStatus[];
  memoValue: () => string | null;
}

function makeManager(options: {
  confirm?: boolean | (() => Promise<boolean>);
  acquire?: (() => ScopedFsLike | null) | undefined;
  initialMemo?: string | null;
}): Harness {
  const events: ScopeStatus[] = [];
  let memo: string | null = options.initialMemo ?? null;
  const confirm = options.confirm ?? true;
  const manager = new ScopeManager({
    confirmDialog: typeof confirm === 'function' ? confirm : () => Promise.resolve(confirm),
    acquireScopedFs: options.acquire ?? (() => fakeFs),
    memo: {
      get: () => memo,
      set: (value) => {
        memo = value;
      },
    },
    onScopeChanged: (status) => events.push(status),
  });
  return { manager, events, memoValue: () => memo };
}

async function expectCommandError(promiseOrFn: Promise<unknown> | (() => unknown), code: string): Promise<CommandError> {
  try {
    if (typeof promiseOrFn === 'function') {
      promiseOrFn();
    } else {
      await promiseOrFn;
    }
  } catch (error) {
    assert.ok(error instanceof CommandError, `expected CommandError, got ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected CommandError ${code}, but nothing was thrown`);
}

test('file access before any confirmation fails with E_SCOPE_NOT_CONFIRMED', async () => {
  const { manager } = makeManager({});
  assert.deepEqual(manager.status, { state: 'unconfirmed' });
  await expectCommandError(() => manager.fs, 'E_SCOPE_NOT_CONFIRMED');
});

test('confirming a proposal grants access, persists the memo, and emits scope events', async () => {
  const { manager, events, memoValue } = makeManager({});
  const result = await manager.propose('/home/user/models/', 'export Minecraft models');
  assert.deepEqual(result, { state: 'confirmed', normalized_path: '/home/user/models' });
  assert.equal(manager.fs, fakeFs);
  assert.equal(manager.confirmedPath, '/home/user/models');
  assert.equal(memoValue(), '/home/user/models');
  assert.deepEqual(
    events.map((e) => e.state),
    ['proposed', 'confirmed'],
  );
});

test('a rejected proposal returns E_SCOPE_NOT_CONFIRMED with the user_rejected reason', async () => {
  const { manager } = makeManager({ confirm: false });
  const error = await expectCommandError(manager.propose('/home/user/models', undefined), 'E_SCOPE_NOT_CONFIRMED');
  assert.deepEqual(error.details, { reason: 'user_rejected', proposed_path: '/home/user/models' });
  await expectCommandError(() => manager.fs, 'E_SCOPE_NOT_CONFIRMED');
});

test('a denied native permission returns E_SCOPE_NOT_CONFIRMED with the native reason', async () => {
  const { manager } = makeManager({ acquire: () => null });
  const error = await expectCommandError(manager.propose('/home/user/models', undefined), 'E_SCOPE_NOT_CONFIRMED');
  assert.deepEqual(error.details, { reason: 'native_permission_denied', proposed_path: '/home/user/models' });
});

test('relative or invalid proposals are rejected with E_INVALID_PARAMS', async () => {
  const { manager } = makeManager({});
  await expectCommandError(manager.propose('models/relative', undefined), 'E_INVALID_PARAMS');
  await expectCommandError(manager.propose('/scope/../..', undefined), 'E_INVALID_PARAMS');
});

test('in-session revocation flips file access to E_SCOPE_REVOKED', async () => {
  const { manager, events } = makeManager({});
  await manager.propose('/home/user/models', undefined);
  manager.revoke();
  assert.equal(manager.status.state, 'revoked');
  await expectCommandError(() => manager.fs, 'E_SCOPE_REVOKED');
  assert.equal(events.at(-1)?.state, 'revoked');
});

test('a previous-session grant reports as expired until reconfirmed', async () => {
  const { manager } = makeManager({ initialMemo: '/home/user/old-scope' });
  assert.deepEqual(manager.status, { state: 'expired', normalized_path: '/home/user/old-scope' });
  const error = await expectCommandError(() => manager.fs, 'E_SCOPE_EXPIRED');
  assert.deepEqual(error.details, { previous_path: '/home/user/old-scope' });

  await manager.propose('/home/user/new-scope', undefined);
  assert.deepEqual(manager.status, { state: 'confirmed', normalized_path: '/home/user/new-scope' });
  assert.equal(manager.fs, fakeFs);
});

test('a rejected re-proposal keeps the previously confirmed scope intact', async () => {
  let confirmNext = true;
  const { manager } = makeManager({ confirm: () => Promise.resolve(confirmNext) });
  await manager.propose('/home/user/models', undefined);
  assert.equal(manager.status.state, 'confirmed');

  confirmNext = false;
  await expectCommandError(manager.propose('/home/user/typo-path', undefined), 'E_SCOPE_NOT_CONFIRMED');
  assert.deepEqual(manager.status, { state: 'confirmed', normalized_path: '/home/user/models' });
  assert.equal(manager.fs, fakeFs, 'the original grant must survive a rejected re-proposal');
});

test('concurrent proposals are rejected while a dialog is open', async () => {
  let resolveDialog: ((value: boolean) => void) | null = null;
  const { manager } = makeManager({
    confirm: () =>
      new Promise<boolean>((resolve) => {
        resolveDialog = resolve;
      }),
  });
  const first = manager.propose('/home/user/models', undefined);
  await expectCommandError(manager.propose('/home/user/other', undefined), 'E_INVALID_PARAMS');
  resolveDialog!(true);
  await first;
  assert.equal(manager.status.state, 'confirmed');
});
