// Per-file floors for the named-test scan.
//
// `tests/fixtures/premigration/named-test-inventory.json` freezes the 417 test
// names that existed before the wire corpus was recorded, and the replay test
// checks that every one of them is still declared somewhere. That check has two
// blind spots, and this file closes them.
//
// The first is arithmetic. The inventory compares one repository-wide total
// against one recorded total, and the repository now declares far more tests
// than it did when the inventory was taken. All of that surplus is slack: tests
// could be deleted in bulk and the total would still clear the recorded floor.
// A count recorded per file removes it — deleting a test from any file fails
// against that file's own number, whatever the rest of the repository does.
//
// The second is that the scan matches a declaration, not a test. It reads
// `test('...')` line by line, so a test whose body was emptied still registers
// as present. `assertions` is the count of `assert.<method>(` calls in the same
// file, which an emptied body takes with it.
//
// Both numbers are measured, not estimated, and both are floors: adding tests
// or assertions is always allowed, removing them is not. When a removal is
// deliberate, lower the number here in the same change, so the removal is
// visible in the diff rather than absorbed by slack.
//
// `inventoried` marks the files the frozen pre-migration inventory covers. The
// rest were added by the MCP `2026-07-28` migration and carry floors for the
// same reason, but they are not part of that frozen record.

export interface TestFileFloor {
  /** Named `test(...)` declarations this file carried when the floor was set. */
  readonly tests: number;
  /** `assert.<method>(` calls this file carried when the floor was set. */
  readonly assertions: number;
  /** Whether the frozen pre-migration named-test inventory covers this file. */
  readonly inventoried: boolean;
}

/**
 * Every test file in `tests/`, except the replay test itself, which is excluded
 * from the frozen inventory on purpose and is where these floors are checked.
 */
export const TEST_FILE_FLOORS: Readonly<Record<string, TestFileFloor>> = {
  'adapter-config.test.ts': { tests: 12, assertions: 66, inventoried: true },
  'adapter-scope-isolation.test.ts': { tests: 6, assertions: 56, inventoried: false },
  'broker-dual-era-wire.test.ts': { tests: 11, assertions: 64, inventoried: false },
  'broker-e2e.test.ts': { tests: 14, assertions: 103, inventoried: true },
  'broker-election.test.ts': { tests: 10, assertions: 34, inventoried: true },
  // Re-measured when the platform-capability registry was added: the two
  // assertions that give `runtime directories are created and repaired to
  // owner-only mode` something to check on Windows are its entire coverage
  // there, and three assertions of slack would have let them be deleted again
  // without this floor noticing.
  'broker-endpoint.test.ts': { tests: 8, assertions: 24, inventoried: true },
  'broker-ipc.test.ts': { tests: 10, assertions: 26, inventoried: true },
  'broker-lease.test.ts': { tests: 12, assertions: 73, inventoried: true },
  'broker-queued-cancellation.test.ts': { tests: 11, assertions: 57, inventoried: false },
  'broker-server.test.ts': { tests: 18, assertions: 87, inventoried: true },
  'broker-session-identity.test.ts': { tests: 6, assertions: 38, inventoried: false },
  'broker-session-in-use-endpoint-preservation.test.ts': { tests: 3, assertions: 35, inventoried: false },
  'broker-startup-taint-and-ipc-version.test.ts': { tests: 4, assertions: 17, inventoried: false },
  'full-auto.test.ts': { tests: 16, assertions: 54, inventoried: true },
  'geckolib-animation-mapping.test.ts': { tests: 11, assertions: 25, inventoried: true },
  'geckolib-validate.test.ts': { tests: 40, assertions: 139, inventoried: true },
  'hybrid-opening-normalizer.test.ts': { tests: 20, assertions: 57, inventoried: false },
  'mcp-cancellation-wire.test.ts': { tests: 4, assertions: 30, inventoried: false },
  'mcp-era-negotiation-wire.test.ts': { tests: 17, assertions: 85, inventoried: false },
  'mcp-modern-era-wire.test.ts': { tests: 10, assertions: 48, inventoried: false },
  'mcp-public-entry-points.test.ts': { tests: 3, assertions: 6, inventoried: false },
  'mcp-request-identity-wire.test.ts': { tests: 7, assertions: 41, inventoried: false },
  'mcp-security-leakage-scan.test.ts': { tests: 8, assertions: 65, inventoried: false },
  'mcp-server-health.test.ts': { tests: 4, assertions: 17, inventoried: true },
  'mcp-tool-contract-dual-era.test.ts': { tests: 9, assertions: 42, inventoried: false },
  'plugin-dialog-text.test.ts': { tests: 5, assertions: 6, inventoried: true },
  'plugin-file-commands.test.ts': { tests: 13, assertions: 54, inventoried: true },
  'plugin-geckolib-commands.test.ts': { tests: 27, assertions: 189, inventoried: true },
  'plugin-min-version.test.ts': { tests: 1, assertions: 2, inventoried: false },
  'plugin-model-commands.test.ts': { tests: 45, assertions: 200, inventoried: true },
  'plugin-scope-commands.test.ts': { tests: 3, assertions: 10, inventoried: true },
  'plugin-session.test.ts': { tests: 18, assertions: 30, inventoried: true },
  'premigration-corpus-integrity.test.ts': { tests: 4, assertions: 13, inventoried: false },
  'premigration-deviation-runtime-backing.test.ts': { tests: 8, assertions: 29, inventoried: false },
  'protocol.test.ts': { tests: 35, assertions: 166, inventoried: true },
  'rendezvous.test.ts': { tests: 13, assertions: 52, inventoried: true },
  'scope-logic.test.ts': { tests: 12, assertions: 47, inventoried: true },
  'scope-manager.test.ts': { tests: 13, assertions: 31, inventoried: true },
  'setup-cli.test.ts': { tests: 42, assertions: 165, inventoried: true },
  'smoke-geckolib-animation-frame.test.ts': { tests: 10, assertions: 46, inventoried: true },
  'smoke-scope-isolation.test.ts': { tests: 19, assertions: 143, inventoried: false },
  'stdio-e2e.test.ts': { tests: 8, assertions: 58, inventoried: true },
  'ws-bridge.test.ts': { tests: 26, assertions: 71, inventoried: true },
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
