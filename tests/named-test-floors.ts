// Per-file floors for the named-test scan.
//
// Each test file carries its own recorded count, so deleting a test from any
// file fails against that file's number, whatever the rest of the repository
// gains in the meantime. A single repository-wide total would let new tests
// elsewhere absorb the loss.
//
// The scan matches a declaration, not a test: it reads `test('...')` line by
// line, so a test whose body was emptied still registers as present.
// `assertions` is the count of `assert.<method>(` calls in the same file, which
// an emptied body takes with it.
//
// Both numbers are measured, not estimated, and both are floors: adding tests
// or assertions is always allowed, removing them is not. When a removal is
// deliberate, lower the number here in the same change, so the removal is
// visible in the diff rather than absorbed by slack.

export interface TestFileFloor {
  /** Named `test(...)` declarations this file carried when the floor was set. */
  readonly tests: number;
  /** `assert.<method>(` calls this file carried when the floor was set. */
  readonly assertions: number;
}

/**
 * Every test file in `tests/`, except the replay test itself, which is where
 * these floors are checked.
 */
export const TEST_FILE_FLOORS: Readonly<Record<string, TestFileFloor>> = {
  'adapter-config.test.ts': { tests: 12, assertions: 66 },
  'adapter-scope-isolation.test.ts': { tests: 6, assertions: 56 },
  'broker-dual-era-wire.test.ts': { tests: 11, assertions: 64 },
  'broker-e2e.test.ts': { tests: 15, assertions: 112 },
  'broker-election.test.ts': { tests: 13, assertions: 40 },
  // Re-measured when the platform-capability registry was added: the two
  // assertions that give `runtime directories are created and repaired to
  // owner-only mode` something to check on Windows are its entire coverage
  // there, and three assertions of slack would have let them be deleted again
  // without this floor noticing.
  'broker-endpoint.test.ts': { tests: 12, assertions: 39 },
  'broker-ipc.test.ts': { tests: 10, assertions: 26 },
  'broker-lease.test.ts': { tests: 12, assertions: 73 },
  'broker-queued-cancellation.test.ts': { tests: 11, assertions: 57 },
  'broker-server.test.ts': { tests: 18, assertions: 87 },
  'broker-session-identity.test.ts': { tests: 6, assertions: 38 },
  'broker-session-in-use-endpoint-preservation.test.ts': { tests: 3, assertions: 35 },
  'broker-startup-taint-and-ipc-version.test.ts': { tests: 4, assertions: 17 },
  'full-auto.test.ts': { tests: 16, assertions: 54 },
  'geckolib-animation-mapping.test.ts': { tests: 11, assertions: 25 },
  'geckolib-validate.test.ts': { tests: 40, assertions: 139 },
  'hybrid-opening-normalizer.test.ts': { tests: 20, assertions: 57 },
  'java-model-normalize.test.ts': { tests: 12, assertions: 54 },
  'mcp-cancellation-wire.test.ts': { tests: 4, assertions: 30 },
  'mcp-capture-results.test.ts': { tests: 6, assertions: 30 },
  'mcp-era-negotiation-wire.test.ts': { tests: 17, assertions: 85 },
  'mcp-modern-era-wire.test.ts': { tests: 10, assertions: 48 },
  'mcp-public-entry-points.test.ts': { tests: 3, assertions: 6 },
  'mcp-request-identity-wire.test.ts': { tests: 7, assertions: 41 },
  'mcp-security-leakage-scan.test.ts': { tests: 8, assertions: 65 },
  'mcp-server-health.test.ts': { tests: 4, assertions: 17 },
  'mcp-tool-contract-dual-era.test.ts': { tests: 9, assertions: 42 },
  'plugin-dialog-text.test.ts': { tests: 5, assertions: 6 },
  'plugin-file-commands.test.ts': { tests: 13, assertions: 54 },
  'plugin-geckolib-commands.test.ts': { tests: 30, assertions: 225 },
  'plugin-min-version.test.ts': { tests: 1, assertions: 2 },
  'plugin-model-commands.test.ts': { tests: 56, assertions: 285 },
  'plugin-scope-commands.test.ts': { tests: 3, assertions: 10 },
  'plugin-session.test.ts': { tests: 18, assertions: 30 },
  'premigration-corpus-integrity.test.ts': { tests: 4, assertions: 11 },
  'premigration-deviation-runtime-backing.test.ts': { tests: 8, assertions: 28 },
  'protocol.test.ts': { tests: 35, assertions: 166 },
  'rendezvous.test.ts': { tests: 13, assertions: 52 },
  'scope-logic.test.ts': { tests: 12, assertions: 47 },
  'scope-manager.test.ts': { tests: 13, assertions: 31 },
  'setup-cli.test.ts': { tests: 42, assertions: 165 },
  'smoke-geckolib-animation-frame.test.ts': { tests: 10, assertions: 46 },
  'smoke-scope-isolation.test.ts': { tests: 19, assertions: 143 },
  'stdio-e2e.test.ts': { tests: 8, assertions: 58 },
  'ws-bridge.test.ts': { tests: 26, assertions: 71 },
};

/**
 * The test declarations that carry a `skip` condition, reviewed and pinned.
 *
 * A disabled test still matches the name scan, so `skip`, `todo`, and
 * `t.skip(...)` are otherwise refused outright. These three are the exception:
 * each guards a platform-specific behaviour and each runs on the platform it is
 * written for. They are pinned by condition text, so an unconditional
 * `skip: true`, a widened condition, or a fourth skip appearing anywhere fails
 * instead of quietly removing a test from the run.
 */
export interface ReviewedConditionalSkip {
  readonly file: string;
  readonly test: string;
  /** The condition source text, exactly as written after `skip:`. */
  readonly condition: string;
}

export const REVIEWED_CONDITIONAL_SKIPS: readonly ReviewedConditionalSkip[] = [
  {
    file: 'setup-cli.test.ts',
    test: 'the real clipboard path pipes the secret via stdin, never argv',
    condition: "process.platform === 'win32'",
  },
  {
    file: 'setup-cli.test.ts',
    test: 'writeSecretFile writes atomically with 0600 permissions',
    condition: "process.platform === 'win32'",
  },
  {
    file: 'setup-cli.test.ts',
    test: 'a bare adapter resolves the implicit per-user default config file',
    condition: "process.platform !== 'linux'",
  },
];
