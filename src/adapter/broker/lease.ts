export const CONTROLLER_LEASE_STATES = ['idle', 'owned', 'releasing', 'recovering'] as const;
export type ControllerLeaseState = (typeof CONTROLLER_LEASE_STATES)[number];

export const CONTROLLER_LEASE_EVENTS = [
  'acquire',
  'requestStarted',
  'requestFinished',
  'ownerDisconnected',
  'heartbeatExpired',
  'idleExpired',
  'revocationResolved',
  'acquirerDisconnected',
  'pluginDisconnected',
  'pluginAuthenticated',
] as const;
export type ControllerLeaseEvent = (typeof CONTROLLER_LEASE_EVENTS)[number];

export const CONTROLLER_LEASE_TRANSITION_TABLE: Readonly<
  Record<ControllerLeaseState, Readonly<Partial<Record<ControllerLeaseEvent, readonly ControllerLeaseState[]>>>>
> = {
  idle: {
    acquire: ['owned', 'recovering'],
    pluginDisconnected: ['idle'],
    pluginAuthenticated: ['idle', 'recovering'],
  },
  owned: {
    acquire: ['owned'],
    requestStarted: ['owned'],
    requestFinished: ['owned'],
    ownerDisconnected: ['idle', 'releasing'],
    heartbeatExpired: ['idle', 'releasing'],
    idleExpired: ['idle'],
    pluginDisconnected: ['releasing', 'recovering'],
    pluginAuthenticated: ['owned'],
  },
  releasing: {
    acquire: ['releasing'],
    requestFinished: ['idle', 'recovering'],
    pluginDisconnected: ['releasing'],
    pluginAuthenticated: ['releasing'],
  },
  recovering: {
    acquire: ['recovering'],
    revocationResolved: ['idle', 'owned', 'recovering'],
    acquirerDisconnected: ['recovering'],
    pluginDisconnected: ['recovering'],
    pluginAuthenticated: ['recovering'],
  },
};

export interface ControllerLeaseTransition {
  state: ControllerLeaseState;
  event: ControllerLeaseEvent;
  nextStates: readonly ControllerLeaseState[] | null;
}

export function listControllerLeaseTransitions(): ControllerLeaseTransition[] {
  return CONTROLLER_LEASE_STATES.flatMap((state) =>
    CONTROLLER_LEASE_EVENTS.map((event) => ({
      state,
      event,
      nextStates: CONTROLLER_LEASE_TRANSITION_TABLE[state][event] ?? null,
    })),
  );
}

export type LeaseAcquireResult =
  | { outcome: 'granted' }
  | { outcome: 'busy'; owner: string }
  | { outcome: 'revocation_required' };

export interface ControllerLeaseOptions<TimerHandle> {
  idleTimeoutMs: number;
  setTimer: (callback: () => void, ms: number) => TimerHandle;
  clearTimer: (handle: TimerHandle) => void;
}

export interface ControllerLeaseSnapshot {
  state: ControllerLeaseState;
  ownerSessionId: string | null;
  inFlightRequest: boolean;
  scopeEraOwnerSessionId: string | null;
  tainted: boolean;
  pendingAcquirerSessionId: string | null;
}

export class ControllerLease<TimerHandle> {
  private currentState: ControllerLeaseState = 'idle';
  private owner: string | null = null;
  private requestInFlight = false;
  private scopeEraOwner: string | null = null;
  private taint = false;
  private pendingAcquirer: string | null = null;
  private recoverAfterRelease = false;
  private idleTimer: TimerHandle | undefined;
  private timerGeneration = 0;

  constructor(private readonly options: ControllerLeaseOptions<TimerHandle>) {
    if (!Number.isInteger(options.idleTimeoutMs) || options.idleTimeoutMs <= 0) {
      throw new RangeError('idleTimeoutMs must be a positive integer.');
    }
  }

  get state(): ControllerLeaseState {
    return this.currentState;
  }

  get ownerSessionId(): string | null {
    return this.owner;
  }

  get inFlightRequest(): boolean {
    return this.requestInFlight;
  }

  get scopeEraOwnerSessionId(): string | null {
    return this.scopeEraOwner;
  }

  get tainted(): boolean {
    return this.taint;
  }

  snapshot(): ControllerLeaseSnapshot {
    return {
      state: this.currentState,
      ownerSessionId: this.owner,
      inFlightRequest: this.requestInFlight,
      scopeEraOwnerSessionId: this.scopeEraOwner,
      tainted: this.taint,
      pendingAcquirerSessionId: this.pendingAcquirer,
    };
  }

  acquire(sessionId: string): LeaseAcquireResult {
    this.assertAllowed('acquire');

    if (this.currentState === 'owned') {
      if (this.owner !== sessionId) return { outcome: 'busy', owner: this.owner! };
      if (!this.requestInFlight) this.scheduleIdleTimer();
      return { outcome: 'granted' };
    }

    if (this.currentState === 'releasing') {
      return { outcome: 'busy', owner: this.owner! };
    }

    if (this.currentState === 'recovering') {
      if (this.pendingAcquirer === null) {
        this.pendingAcquirer = sessionId;
      } else if (this.pendingAcquirer !== sessionId) {
        return { outcome: 'busy', owner: this.pendingAcquirer };
      }
      return { outcome: 'revocation_required' };
    }

    if (this.taint || (this.scopeEraOwner !== null && this.scopeEraOwner !== sessionId)) {
      this.pendingAcquirer = sessionId;
      this.taint = true;
      this.currentState = 'recovering';
      return { outcome: 'revocation_required' };
    }

    this.grant(sessionId);
    return { outcome: 'granted' };
  }

  requestStarted(sessionId: string): void {
    this.assertAllowed('requestStarted');
    this.assertOwner(sessionId, 'requestStarted');
    if (this.requestInFlight) this.illegal('requestStarted', 'a request is already in flight');
    this.requestInFlight = true;
    this.clearIdleTimer();
  }

  requestFinished(sessionId: string): void {
    this.assertAllowed('requestFinished');
    this.assertOwner(sessionId, 'requestFinished');
    if (!this.requestInFlight) this.illegal('requestFinished', 'no request is in flight');
    this.requestInFlight = false;

    if (this.currentState === 'owned') {
      this.scheduleIdleTimer();
      return;
    }

    this.owner = null;
    if (this.recoverAfterRelease || this.taint) {
      this.recoverAfterRelease = false;
      this.currentState = 'recovering';
    } else {
      this.currentState = 'idle';
    }
  }

  ownerDisconnected(sessionId: string): void {
    this.releaseOwnerForLivenessEvent(sessionId, 'ownerDisconnected');
  }

  heartbeatExpired(sessionId: string): void {
    this.releaseOwnerForLivenessEvent(sessionId, 'heartbeatExpired');
  }

  idleExpired(): void {
    this.assertAllowed('idleExpired');
    if (this.requestInFlight) this.illegal('idleExpired', 'a request is in flight');
    this.clearIdleTimer();
    this.owner = null;
    this.currentState = 'idle';
  }

  revocationResolved(ok: boolean): void {
    this.assertAllowed('revocationResolved');
    if (!ok) {
      this.taint = true;
      return;
    }

    this.taint = false;
    this.scopeEraOwner = null;
    const pending = this.pendingAcquirer;
    this.pendingAcquirer = null;
    if (pending === null) {
      this.currentState = 'idle';
      return;
    }
    this.grant(pending);
  }

  acquirerDisconnected(sessionId: string): void {
    this.assertAllowed('acquirerDisconnected');
    if (this.pendingAcquirer === sessionId) this.pendingAcquirer = null;
  }

  pluginDisconnected(): void {
    this.assertAllowed('pluginDisconnected');
    if (this.scopeEraOwner !== null || this.owner !== null || this.taint) this.taint = true;
    this.clearIdleTimer();

    if (this.currentState === 'owned') {
      this.pendingAcquirer = this.owner;
      if (this.requestInFlight) {
        this.recoverAfterRelease = true;
        this.currentState = 'releasing';
      } else {
        this.owner = null;
        this.currentState = 'recovering';
      }
      return;
    }

    if (this.currentState === 'releasing') {
      this.recoverAfterRelease = true;
    }
  }

  pluginAuthenticated(): void {
    this.assertAllowed('pluginAuthenticated');
    if (this.currentState === 'idle' && this.taint) {
      this.currentState = 'recovering';
    }
  }

  private grant(sessionId: string): void {
    this.currentState = 'owned';
    this.owner = sessionId;
    this.requestInFlight = false;
    this.scopeEraOwner = sessionId;
    this.pendingAcquirer = null;
    this.recoverAfterRelease = false;
    this.scheduleIdleTimer();
  }

  private releaseOwnerForLivenessEvent(
    sessionId: string,
    event: 'ownerDisconnected' | 'heartbeatExpired',
  ): void {
    this.assertAllowed(event);
    this.assertOwner(sessionId, event);
    this.clearIdleTimer();
    if (this.requestInFlight) {
      this.currentState = 'releasing';
      return;
    }
    this.owner = null;
    this.currentState = 'idle';
  }

  private scheduleIdleTimer(): void {
    this.clearIdleTimer();
    const generation = ++this.timerGeneration;
    this.idleTimer = this.options.setTimer(() => {
      if (generation !== this.timerGeneration) return;
      this.idleTimer = undefined;
      this.idleExpired();
    }, this.options.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    this.timerGeneration += 1;
    if (this.idleTimer !== undefined) {
      this.options.clearTimer(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private assertAllowed(event: ControllerLeaseEvent): void {
    if (CONTROLLER_LEASE_TRANSITION_TABLE[this.currentState][event] === undefined) {
      this.illegal(event);
    }
  }

  private assertOwner(sessionId: string, event: ControllerLeaseEvent): void {
    if (this.owner !== sessionId) this.illegal(event, `session ${sessionId} is not the owner`);
  }

  private illegal(event: ControllerLeaseEvent, detail?: string): never {
    const suffix = detail === undefined ? '' : ` ${detail}.`;
    throw new Error(`Illegal controller lease transition: state=${this.currentState}, event=${event}.${suffix}`);
  }
}
