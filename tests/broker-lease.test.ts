import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTROLLER_LEASE_EVENTS,
  CONTROLLER_LEASE_STATES,
  CONTROLLER_LEASE_TRANSITION_TABLE,
  ControllerLease,
  listControllerLeaseTransitions,
  type ControllerLeaseEvent,
  type ControllerLeaseState,
} from '../src/adapter/broker/lease.js';

class FakeTimers {
  private nextHandle = 1;
  readonly callbacks = new Map<number, () => void>();
  readonly delays: number[] = [];

  setTimer = (callback: () => void, ms: number): number => {
    const handle = this.nextHandle++;
    this.callbacks.set(handle, callback);
    this.delays.push(ms);
    return handle;
  };

  clearTimer = (handle: number): void => {
    this.callbacks.delete(handle);
  };

  runNext(): void {
    const entry = this.callbacks.entries().next().value as [number, () => void] | undefined;
    assert.ok(entry, 'expected an active timer');
    this.callbacks.delete(entry[0]);
    entry[1]();
  }

  runAll(): void {
    for (const [handle, callback] of [...this.callbacks]) {
      this.callbacks.delete(handle);
      callback();
    }
  }
}

function makeLease(): { lease: ControllerLease<number>; timers: FakeTimers } {
  const timers = new FakeTimers();
  return {
    lease: new ControllerLease({
      idleTimeoutMs: 60_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    }),
    timers,
  };
}

function moveToState(state: ControllerLeaseState, event: ControllerLeaseEvent): ControllerLease<number> {
  const { lease } = makeLease();
  if (state === 'idle') return lease;

  assert.deepEqual(lease.acquire('session-a'), { outcome: 'granted' });
  if (state === 'owned') {
    if (event === 'requestFinished') lease.requestStarted('session-a');
    return lease;
  }

  if (state === 'releasing') {
    lease.requestStarted('session-a');
    lease.ownerDisconnected('session-a');
    return lease;
  }

  lease.idleExpired();
  assert.deepEqual(lease.acquire('session-b'), { outcome: 'revocation_required' });
  return lease;
}

function invokeEvent(lease: ControllerLease<number>, event: ControllerLeaseEvent): void {
  switch (event) {
    case 'acquire':
      lease.acquire(lease.ownerSessionId ?? 'session-b');
      return;
    case 'requestStarted':
      lease.requestStarted('session-a');
      return;
    case 'requestFinished':
      lease.requestFinished('session-a');
      return;
    case 'ownerDisconnected':
      lease.ownerDisconnected('session-a');
      return;
    case 'heartbeatExpired':
      lease.heartbeatExpired('session-a');
      return;
    case 'idleExpired':
      lease.idleExpired();
      return;
    case 'revocationResolved':
      lease.revocationResolved(true);
      return;
    case 'pluginDisconnected':
      lease.pluginDisconnected();
      return;
    case 'pluginAuthenticated':
      lease.pluginAuthenticated();
  }
}

test('the transition table covers every state and event as a transition or an explicit rejection', () => {
  const listed = listControllerLeaseTransitions();
  assert.equal(listed.length, CONTROLLER_LEASE_STATES.length * CONTROLLER_LEASE_EVENTS.length);

  for (const state of CONTROLLER_LEASE_STATES) {
    for (const event of CONTROLLER_LEASE_EVENTS) {
      const lease = moveToState(state, event);
      assert.equal(lease.state, state);
      const expectedNextStates = CONTROLLER_LEASE_TRANSITION_TABLE[state][event];
      if (expectedNextStates === undefined) {
        assert.throws(
          () => invokeEvent(lease, event),
          (error: unknown) =>
            error instanceof Error && error.message.includes(`state=${state}`) && error.message.includes(`event=${event}`),
        );
      } else {
        invokeEvent(lease, event);
        assert.ok(
          expectedNextStates.includes(lease.state),
          `${state} × ${event} reached undocumented state ${lease.state}`,
        );
      }
    }
  }
});

test('heartbeat expiry releases an owner with no request in flight', () => {
  const { lease, timers } = makeLease();
  lease.acquire('session-a');
  lease.heartbeatExpired('session-a');
  assert.deepEqual(lease.snapshot(), {
    state: 'idle',
    ownerSessionId: null,
    inFlightRequest: false,
    scopeEraOwnerSessionId: 'session-a',
    tainted: false,
    pendingAcquirerSessionId: null,
  });
  assert.equal(timers.callbacks.size, 0);
});

test('heartbeat expiry waits for an in-flight request before completing release', () => {
  const { lease, timers } = makeLease();
  lease.acquire('session-a');
  lease.requestStarted('session-a');

  lease.heartbeatExpired('session-a');
  assert.equal(lease.state, 'releasing');
  assert.equal(lease.ownerSessionId, 'session-a');
  assert.equal(lease.inFlightRequest, true);
  assert.equal(timers.callbacks.size, 0);

  lease.requestFinished('session-a');
  assert.ok(lease.state === 'idle' || lease.state === 'recovering');
  assert.equal(lease.ownerSessionId, null);
  assert.equal(lease.inFlightRequest, false);
});

test('the idle timer is absent while a request is in flight and resumes after it finishes', () => {
  const { lease, timers } = makeLease();
  lease.acquire('session-a');
  assert.equal(timers.callbacks.size, 1);
  assert.deepEqual(timers.delays, [60_000]);

  lease.requestStarted('session-a');
  assert.equal(timers.callbacks.size, 0);
  timers.runAll();
  assert.equal(lease.state, 'owned');

  lease.requestFinished('session-a');
  assert.equal(timers.callbacks.size, 1);
  assert.deepEqual(timers.delays, [60_000, 60_000]);
});

test('the same session re-acquires after idle expiry without scope revocation', () => {
  const { lease, timers } = makeLease();
  lease.acquire('session-a');
  timers.runNext();
  assert.equal(lease.state, 'idle');
  assert.equal(lease.scopeEraOwnerSessionId, 'session-a');
  assert.deepEqual(lease.acquire('session-a'), { outcome: 'granted' });
  assert.equal(lease.state, 'owned');
  assert.equal(lease.tainted, false);
});

test('a different session must complete revocation before acquiring a previous scope era', () => {
  const { lease } = makeLease();
  lease.acquire('session-a');
  lease.idleExpired();
  assert.deepEqual(lease.acquire('session-b'), { outcome: 'revocation_required' });
  assert.equal(lease.state, 'recovering');
  assert.equal(lease.ownerSessionId, null);

  lease.revocationResolved(true);
  assert.equal(lease.state, 'owned');
  assert.equal(lease.ownerSessionId, 'session-b');
  assert.equal(lease.scopeEraOwnerSessionId, 'session-b');
  assert.equal(lease.tainted, false);
});

test('a lost revocation acknowledgement remains tainted across plugin reconnect and blocks grant', () => {
  const { lease } = makeLease();
  lease.acquire('session-a');
  lease.idleExpired();
  assert.deepEqual(lease.acquire('session-b'), { outcome: 'revocation_required' });
  lease.revocationResolved(false);
  assert.equal(lease.state, 'recovering');
  assert.equal(lease.tainted, true);

  lease.pluginDisconnected();
  lease.pluginAuthenticated();
  assert.equal(lease.state, 'recovering');
  assert.equal(lease.tainted, true);
  assert.deepEqual(lease.acquire('session-b'), { outcome: 'revocation_required' });
  assert.equal(lease.ownerSessionId, null);

  lease.revocationResolved(true);
  assert.equal(lease.state, 'owned');
  assert.equal(lease.ownerSessionId, 'session-b');
});

test('taint survives two plugin reconnect cycles before a different session is granted', () => {
  const { lease } = makeLease();
  lease.acquire('session-a');
  lease.idleExpired();
  assert.deepEqual(lease.acquire('session-b'), { outcome: 'revocation_required' });
  lease.revocationResolved(false);

  for (let cycle = 0; cycle < 2; cycle += 1) {
    lease.pluginDisconnected();
    assert.equal(lease.state, 'recovering');
    assert.equal(lease.tainted, true);
    lease.pluginAuthenticated();
    assert.equal(lease.state, 'recovering');
    assert.equal(lease.tainted, true);
  }

  assert.deepEqual(lease.acquire('session-b'), { outcome: 'revocation_required' });
  assert.equal(lease.ownerSessionId, null);
  lease.revocationResolved(true);
  assert.equal(lease.state, 'owned');
  assert.equal(lease.ownerSessionId, 'session-b');
});

test('owner death during a request holds the lease in releasing until the request finishes', () => {
  const { lease, timers } = makeLease();
  lease.acquire('session-a');
  lease.requestStarted('session-a');
  lease.ownerDisconnected('session-a');

  assert.equal(lease.state, 'releasing');
  assert.equal(lease.ownerSessionId, 'session-a');
  assert.equal(lease.inFlightRequest, true);
  assert.equal(timers.callbacks.size, 0);
  assert.deepEqual(lease.acquire('session-b'), { outcome: 'busy', owner: 'session-a' });

  lease.requestFinished('session-a');
  assert.equal(lease.state, 'idle');
  assert.equal(lease.ownerSessionId, null);
  assert.equal(lease.inFlightRequest, false);
});

test('plugin re-authentication with a tainted scope requires revocation before any grant', () => {
  const { lease } = makeLease();
  lease.acquire('session-a');
  lease.idleExpired();
  lease.pluginDisconnected();
  assert.equal(lease.state, 'idle');
  assert.equal(lease.tainted, true);

  lease.pluginAuthenticated();
  assert.equal(lease.state, 'recovering');
  assert.deepEqual(lease.acquire('session-a'), { outcome: 'revocation_required' });
  lease.revocationResolved(true);
  assert.equal(lease.ownerSessionId, 'session-a');
});
