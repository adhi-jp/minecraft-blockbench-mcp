// Reviewed registry of the invariants that do not exist on every platform, and
// the guard that holds every source under `tests/` to it.
//
// A test that narrows on the host platform is making a claim about an operating
// system: "this invariant is not there". That claim has to be reviewable. A
// bare `if (process.platform !== 'win32')` wrapped around a block of assertions
// says it silently — the test still passes on the platform it just stopped
// checking, still satisfies the frozen named-test inventory, and still counts
// toward the per-file assertion floor in `tests/named-test-floors.ts`, so the
// leg reports a green test that asserts nothing.
//
// Two mechanisms in this repository already refuse that silence, each for its
// own case: `REVIEWED_CONDITIONAL_SKIPS` in `tests/named-test-floors.ts` for a
// whole test that cannot run on a platform, and
// `tests/premigration-accepted-deviations.ts` for a wire difference the
// migration is allowed to introduce against the frozen corpus. Neither covers a
// branch *inside* a test, which is what this file is for. It is deliberately
// not the deviation ledger: that ledger's `authority` field ties every entry to
// the migration plan, and a platform difference has nothing to do with the
// migration.
//
// Every entry states the invariant in one sentence, the platform that lacks it,
// the operating-system mechanism it is absent for, what must be asserted on
// that platform instead, and what else covers the same intent. An entry is a
// claim that can be wrong, and the controls in
// `tests/premigration-wire-baseline.test.ts` are what hold it to the sources.
//
// HOW A NARROWING IS DECLARED
//
// A test narrows by asking this registry, never by asking the host itself:
//
//     if (platformHasCapability('posix-file-mode-bits')) {
//       assert.equal((await stat(runtimeDir)).mode & 0o777, 0o700);
//     }
//
// The id has to be a string literal at the call site. It is a union type, so a
// typo does not compile; it is also a literal, so the controls can find every
// call site in the syntax tree, which is what lets them report an entry that no
// longer narrows anything anywhere.
//
// `platformHasCapability` takes the id and nothing else. Asking about a
// platform the source names rather than about the host is a different function,
// `platformProvidesCapability(id, platform)`, which reads nothing about the
// host and therefore cannot narrow on it. That split is deliberate: it makes
// "narrow on the host" and "ask about a named platform" two different call
// sites instead of two shapes of one call, so a host-derived expression can
// never be smuggled in as the second argument of the narrowing form. The
// controls use the two-argument form to prove each entry really selects.
//
// WHAT THE GUARD BANS
//
// The guard parses each scanned file with the TypeScript compiler API and walks
// the syntax tree. Comments, string literals and regular expressions are not
// code, so they are not mentions; layout, spacing and line breaks are not
// syntax, so they do not matter. What it reports is any of these, anywhere in a
// scanned file, unless the exact construct is declared below:
//
//   1. Reading the `platform` member of `process`, in any spelling the syntax
//      allows: `process.platform`, `process['platform']`, `process?.platform`,
//      and a `platform` bound out of `process` by destructuring.
//   2. Any other use of the `process` binding that is not a member read — being
//      assigned to another name, destructured, passed as an argument, spread.
//      Once the binding has another name the guard cannot follow it, so the
//      laundering itself is what is reported.
//   3. Reading a host-identity member of `node:os`: `platform`, `type`,
//      `release`, `version`, `arch`, `machine`, `endianness`, `EOL`, `devNull`.
//      Namespace, default and named imports are all covered, under any local
//      alias — `import { platform as hostPlatform }` is the same read.
//   4. Reading a host-shaped member of `node:path`: `sep`, `delimiter`. (Not
//      `path.posix` or `path.win32`: those name a platform instead of asking
//      the host which one it is, so they cannot narrow on it.)
//   5. Reading `platform` from `node:process`, in any of the same import forms.
//   6. Reading an environment variable that names the host operating system,
//      by literal key: OS, OSTYPE, WINDIR, SYSTEMROOT, COMSPEC, PATHEXT,
//      PROCESSOR_ARCHITECTURE, HOMEDRIVE, HOMEPATH, MSYSTEM.
//   7. Any use of the `node:os` or `node:path` namespace binding that is not a
//      member read, for the reason in 2.
//   8. A `platformHasCapability` call that cannot be read: an id that is not a
//      string literal, an extra argument, an answer that is discarded (`void`,
//      or the call standing alone as a statement), a call in statically
//      unreachable code, or an import of the function under another name.
//
// The ban is on the capability, not on a syntactic shape: it does not matter
// whether the value reaches an `if`, a `&&`, a ternary, a default parameter, a
// lookup table, an expected value or an assertion message, because the read
// itself is what is reported, at the point the host is asked.
//
// WHAT IT DOES NOT BAN, STATED PLAINLY
//
// This is static syntax analysis with no type information and no data-flow
// analysis. It cannot see, and does not claim to see:
//
//   - `try`/`catch` narrowing. `try { assert.equal(...) } catch (error) { if
//     (error.code !== 'ENOENT') throw error }` removes an assertion on whatever
//     platform throws, and nothing here asks the host anything. This is the
//     largest known hole and there is no syntactic signature to key on.
//   - Where a legitimately obtained value goes afterwards. A declared value
//     pass hands the host platform to a callee by design; what that callee does
//     with it is outside the scan, as is a boolean derived from
//     `platformHasCapability` and carried through an object or a helper.
//   - Any other way of learning what the host is: spawning `uname` or `ver` and
//     reading its output, probing for a path only one platform has, catching
//     the error a platform-specific syscall raises, comparing `os.tmpdir()` or
//     `os.homedir()` against a platform-shaped prefix, a dynamic
//     `import()`/`require()` chosen by platform, or an environment variable
//     read under a computed key (`process.env[name]`).
//   - Whether a declared branch leaves anything asserted on the platform that
//     lacks the capability. `assertInstead` is where each entry writes that
//     down, and a reviewer checks it against the branch.
//   - Unreachability beyond a literal condition. `if (false)`, `if (true)
//     ... else`, `while (false)`, `false && …`, `true || …` and a ternary on a
//     literal are treated as unreachable; code after a `return`, or a function
//     nothing calls, is not.
//   - Anything outside the scanned set: `src/**`, `scripts/**`, and the plugin.
//     The scanned set is every `.ts` file directly in `tests/` and in
//     `tests/helpers/` — this file included, so the one host read that makes
//     `platformHasCapability` work is declared below like any other.
//
// The test that runs this guard is named for that: it enforces that no scanned
// source reads the host platform *through one of the interfaces listed above*
// except at a declared site. It is not, and must not be described as, proof
// that no test narrows on the platform at all.
//
// HOW A SITE IS DECLARED
//
// A declaration binds to a construct, not to a line: file, the enclosing named
// container (a function, or the test whose callback it sits in), and the exact
// source text of the smallest enclosing expression the read decides, with
// whitespace collapsed. A second, undeclared read on the same line is a
// different construct and is still reported. A declaration that matches no
// reachable construct on disk is dead and is reported too, so an exemption
// cannot outlive the code it was granted for, and cannot be satisfied by text
// sitting in a comment or in a block that can never run.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';

import { REVIEWED_CONDITIONAL_SKIPS } from './named-test-floors.ts';

/**
 * The platforms the CI matrix actually runs. `absentOn` is restricted to these:
 * declaring an invariant absent on a platform no leg exercises would satisfy
 * every control here while narrowing nothing that ever runs.
 */
export type MatrixPlatform = 'linux' | 'darwin' | 'win32';

export const MATRIX_PLATFORMS: readonly MatrixPlatform[] = ['linux', 'darwin', 'win32'];

/**
 * Identifier of a declared capability gap. A union rather than a bare string so
 * that a call site naming something this file does not declare fails to
 * compile, before any control has to notice it.
 */
export type PlatformCapabilityId =
  | 'posix-file-mode-bits'
  | 'posix-signal-delivery-to-a-child-process'
  | 'posix-socket-file-outlives-the-process-bound-to-it';

export interface PlatformCapability {
  /** Stable identifier, written literally at every call site that narrows on it. */
  readonly id: PlatformCapabilityId;
  /** The invariant itself, in one sentence, stated as what a platform provides. */
  readonly invariant: string;
  /** Every matrix platform where the invariant does not exist. */
  readonly absentOn: readonly MatrixPlatform[];
  /** The operating-system reason it is absent, specific enough to be checked. */
  readonly mechanism: string;
  /** What the test must still assert on the platform that lacks it. */
  readonly assertInstead: string;
  /** What else covers the same intent there, or that nothing does. */
  readonly alsoCoveredBy: string;
}

export const PLATFORM_CAPABILITIES: readonly PlatformCapability[] = [
  {
    id: 'posix-file-mode-bits',
    invariant:
      'A file or directory carries POSIX permission bits, so `stat().mode & 0o777` reads back the owner-only mode it was created or repaired with.',
    absentOn: ['win32'],
    mechanism:
      'Windows has no POSIX permission bits. Access is governed by ACLs on the object, and Node synthesizes `stat().mode` from the read-only file attribute alone, so masking it yields a value that never carried owner-only information in the first place — 0o666 for a writable path, whatever its ACL says. The product branches on the same fact: `ensureRuntimeDirectory` applies its `chmod(dir, 0o700)` only off win32 (`src/adapter/broker/endpoint.ts:26`), and `writeBrokerRecordAtomic` opens with mode 0o600 (`src/adapter/broker/rendezvous.ts:36`), which Windows reduces to the read-only bit.',
    assertInstead:
      'That the path was created and is what it claims to be: the runtime directory exists as a directory after `ensureRuntimeDirectory`, including its nested parents, and survives the repairing second call; the rendezvous record exists, round-trips through `readBrokerRecord`, and holds the bytes that were written.',
    alsoCoveredBy:
      'Nothing on Windows restates the confidentiality intent, because the platform expresses it differently. The two whole tests that exist only to check a 0600 secret file are declared through the other registry instead — `writeSecretFile writes atomically with 0600 permissions` and `the real clipboard path pipes the secret via stdin, never argv` in `REVIEWED_CONDITIONAL_SKIPS`.',
  },
  {
    id: 'posix-signal-delivery-to-a-child-process',
    invariant:
      "A parent can deliver SIGINT or SIGTERM to a child process, so the child's own handler runs and the child chooses the exit status it reports.",
    absentOn: ['win32'],
    mechanism:
      "Windows has no signal delivery to another process. libuv maps SIGINT, SIGTERM and SIGKILL in `child.kill()` onto `TerminateProcess`, which the target cannot intercept, so a `process.on('SIGINT')` handler in the child is unreachable by this stimulus and the exit status reported is the terminator's, not the child's. The adapter's handlers (`src/adapter/cli.ts:414-415` and `:475-476`) are correct and do run on POSIX; on Windows nothing can reach them this way. What the frozen corpus recorded for these two scenarios is therefore the outcome of a stimulus Windows cannot deliver: `kind` is the stimulus the harness applies, while `exitCode` and `signal` are the outcome observed on the recording platform.",
    assertInstead:
      'That the kill call really was accepted by a live process, that the process really terminated, and that it terminated exactly as a process carrying no handler at all terminates under the same `child.kill()` call — measured on the same host, in the same run, by a control child that installs nothing. And that it did NOT reproduce the recorded graceful outcome, which would mean the signal reached a handler after all. Everything else the scenario records still holds to the recording on every platform: each recorded wire message byte for byte, no stdout beyond what was recorded after termination, the total stdout message count, and every stderr line written before shutdown.',
    alsoCoveredBy:
      'The `shutdown-stdin-eof` scenario, which asserts the same graceful contract — exit code 0, no trailing stdout, one `Shutting down` log line — through the shutdown channel Windows does have, and which passes there. Graceful shutdown is not left unchecked on Windows; only the signal path is absent.',
  },
  {
    id: 'posix-socket-file-outlives-the-process-bound-to-it',
    invariant:
      'A Unix domain socket stays on the filesystem as a socket file after the process bound to it dies, so a stale leftover can be manufactured and observed with `stat().isSocket()`.',
    absentOn: ['win32'],
    mechanism:
      'Windows IPC here is a named pipe in NPFS, not a filesystem entry, and the kernel destroys the pipe when its last handle closes. A killed broker therefore leaves nothing behind to find, so the leftover this assertion describes cannot be manufactured. The product branches on the same fact: the `unlink` that clears a dead broker\'s leftover before a replacement binds is win32-guarded (`src/adapter/cli.ts:296`).',
    assertInstead:
      'The state both platforms do share after the broker is killed: the endpoint the stale record still names has nothing listening behind it, asserted immediately below the branch on every platform, and the whole recovery that follows — one replacement broker spawned, a fresh rendezvous record published, the endpoint rebound and answering as the replacement.',
    alsoCoveredBy:
      'The negative half of the same pair of tests: the `session_in_use` test asserts the live endpoint is never disturbed, on both platforms, so endpoint handling is checked in both directions on Windows too.',
  },
];

/**
 * Whether `platform` provides the invariant `id` describes.
 *
 * Pure over the platform argument and blind to the host, so both answers can be
 * exercised on one machine: the controls in
 * `tests/premigration-wire-baseline.test.ts` call it with an explicit platform
 * to prove each entry actually selects. Because it never reads the host, a call
 * to it decides nothing about the machine running the suite and does not count
 * as a use of an entry.
 */
export function platformProvidesCapability(id: PlatformCapabilityId, platform: NodeJS.Platform): boolean {
  const capability = PLATFORM_CAPABILITIES.find((entry) => entry.id === id);
  if (capability === undefined) throw new Error(`no platform capability is declared with the id ${id}`);
  return !capability.absentOn.includes(platform as MatrixPlatform);
}

/**
 * Whether the host running this suite provides the invariant `id` describes.
 *
 * This is the only narrowing form. It takes the id and nothing else, so no
 * host-derived expression can be passed to it, and the single host read it
 * performs is declared in `DECLARED_HOST_PLATFORM_SITES` like every other.
 */
export function platformHasCapability(id: PlatformCapabilityId): boolean {
  return platformProvidesCapability(id, process.platform);
}

// ---------------------------------------------------------------------------
// The declared host-platform sites
// ---------------------------------------------------------------------------

/**
 * What a declared read does, which is what a reviewer is checking.
 *
 * - `value-pass` hands the host platform to a callee as data and decides
 *   nothing here; the callee is named in `why`.
 * - `platform-dispatch` chooses between implementations of one answer, where
 *   both implementations answer the same question and no assertion is removed.
 * - `mode-selection` chooses which of two supported behaviours a run exercises,
 *   where both are asserted just as hard.
 * - `diagnostic` names the host in an error message and decides nothing.
 * - `path-shape` reads the shape of a path on this host, not its identity.
 * - `registry-source` is this file's own read, the one every declared narrowing
 *   is routed through.
 */
export type HostPlatformSiteKind =
  | 'value-pass'
  | 'platform-dispatch'
  | 'mode-selection'
  | 'diagnostic'
  | 'path-shape'
  | 'registry-source';

export interface DeclaredHostPlatformSite {
  /** Path relative to `tests/`, e.g. `helpers/process-scan.ts`. */
  readonly file: string;
  /** Enclosing named container: a function name, `test("…")`, or `<module>`. */
  readonly container: string;
  /** Exact source text of the construct the read decides, whitespace collapsed. */
  readonly construct: string;
  readonly kind: HostPlatformSiteKind;
  /** Why this read removes no assertion on any platform. */
  readonly why: string;
}

/** Identity of a declared site, used to report one that no longer exists. */
export function declaredSiteKey(site: DeclaredHostPlatformSite): string {
  return `${site.file} :: ${site.container} :: ${site.construct}`;
}

/**
 * The reason every `platform: process.platform` value pass carries. They are
 * the same construct in the same position in nine harnesses, so they are
 * reviewed once and each one names it.
 */
const IPC_ENDPOINT_VALUE_PASS =
  'Value pass, not a branch. The host platform is handed to `ipcEndpointFor` in ' +
  '`src/adapter/broker/endpoint.ts`, which is a pure function over the platform it is given: the harness has to ' +
  'name the same endpoint the adapter under test will derive, and on win32 that is a named pipe rather than a ' +
  'socket path. It selects nothing here and removes no assertion on any platform; every assertion in the file ' +
  'runs everywhere.';

/**
 * Every place a scanned source is allowed to read the host platform, and what
 * each one decides. A read that is not here fails the guard; an entry that
 * matches no reachable construct on disk is reported as dead.
 */
export const DECLARED_HOST_PLATFORM_SITES: readonly DeclaredHostPlatformSite[] = [
  {
    file: "adapter-scope-isolation.test.ts",
    container: "test(\"a broker that has just started revokes an inherited scoped directory before serving its first command\")",
    construct: "platform: process.platform",
    kind: "value-pass",
    why: IPC_ENDPOINT_VALUE_PASS,
  },
  {
    file: "broker-dual-era-wire.test.ts",
    container: "createBrokerWorld",
    construct: "platform: process.platform",
    kind: "value-pass",
    why: IPC_ENDPOINT_VALUE_PASS,
  },
  {
    file: "broker-e2e.test.ts",
    container: "startClient",
    construct: "brokered = options.mode === 'brokered' || (options.mode !== 'direct' && process.platform !== 'win32')",
    kind: "mode-selection",
    why: "Mode selection, not an assertion guard. It mirrors `resolveAdapterMode` in `src/adapter/config.ts`, whose default is brokered on POSIX and direct on Windows, so the harness can predict which mode the client it just launched is really in. Every assertion in that file runs on both platforms; only the mode being exercised by default differs, and the explicit `brokered` and `direct` options drive the other one.",
  },
  {
    file: "broker-e2e.test.ts",
    container: "writeConfig",
    construct: "platform: process.platform",
    kind: "value-pass",
    why: IPC_ENDPOINT_VALUE_PASS,
  },
  {
    file: "broker-queued-cancellation.test.ts",
    container: "createHarness",
    construct: "platform: process.platform",
    kind: "value-pass",
    why: IPC_ENDPOINT_VALUE_PASS,
  },
  {
    file: "broker-server.test.ts",
    container: "createHarness",
    construct: "platform: process.platform",
    kind: "value-pass",
    why: IPC_ENDPOINT_VALUE_PASS,
  },
  {
    file: "broker-session-identity.test.ts",
    container: "createHarness",
    construct: "platform: process.platform",
    kind: "value-pass",
    why: IPC_ENDPOINT_VALUE_PASS,
  },
  {
    file: "broker-session-in-use-endpoint-preservation.test.ts",
    container: "createWorld",
    construct: "platform: process.platform",
    kind: "value-pass",
    why: IPC_ENDPOINT_VALUE_PASS,
  },
  {
    file: "broker-startup-taint-and-ipc-version.test.ts",
    container: "createHarness",
    construct: "platform: process.platform",
    kind: "value-pass",
    why: IPC_ENDPOINT_VALUE_PASS,
  },
  {
    file: "helpers/process-scan.ts",
    container: "hasArgument",
    construct: "process.platform === 'win32'",
    kind: "platform-dispatch",
    why: "Dispatch inside one answer. `hasArgument` answers \"is this argument in this process’s command line\" on every platform; Windows compares case-insensitively because two spellings of a Windows path are one argument there. Both branches answer the same question for every caller, and no caller loses an assertion because of which one ran.",
  },
  {
    file: "helpers/process-scan.ts",
    container: "psEntryFor",
    construct: "new Error(`process scan: could not run \\`ps\\` on ${process.platform}: ${String(outcome.error?.message)}`)",
    kind: "diagnostic",
    why: "The host name appears in the text of an error that is being thrown, so the failure says which platform could not run `ps`. It is inside the message, not in any condition; nothing branches on it.",
  },
  {
    file: "helpers/process-scan.ts",
    container: "psEntries",
    construct: "new Error( `process scan: \\`ps -A -ww -o pid=,command=\\` failed on ${process.platform}: ${String(outcome.error?.message)}`, )",
    kind: "diagnostic",
    why: "The same diagnostic in the list form: the host name is interpolated into the message of an error that is already being thrown, and decides nothing.",
  },
  {
    file: "helpers/process-scan.ts",
    container: "processEntry",
    construct: "process.platform === 'linux'",
    kind: "platform-dispatch",
    why: "Source selection for one answer: `/proc` on Linux, `ps` on the other POSIX platforms, Win32_Process on Windows. `processEntry` returns the same `ProcessEntry | null` contract from all three, and every platform that cannot answer throws rather than reporting \"no such process\", so a missing scanner can never read as a passing assertion.",
  },
  {
    file: "helpers/process-scan.ts",
    container: "processEntry",
    construct: "process.platform !== 'win32'",
    kind: "platform-dispatch",
    why: "The second leg of the same three-way source selection in `processEntry`: everything POSIX that is not Linux reads `ps`. Same contract, same failure behaviour; no assertion is removed on any platform.",
  },
  {
    file: "helpers/process-scan.ts",
    container: "listProcesses",
    construct: "process.platform === 'linux'",
    kind: "platform-dispatch",
    why: "The list form of the same three-way source selection. `listProcesses` returns the same `ProcessEntry[]` contract everywhere and throws where the scanner could not be run, so an empty list is never a silent answer.",
  },
  {
    file: "helpers/process-scan.ts",
    container: "listProcesses",
    construct: "process.platform !== 'win32'",
    kind: "platform-dispatch",
    why: "The second leg of the same selection in `listProcesses`: everything POSIX that is not Linux reads `ps`.",
  },
  {
    file: "helpers/runtime-root.ts",
    container: "runtimeRootParent",
    construct: "platform: NodeJS.Platform = process.platform",
    kind: "platform-dispatch",
    why: "The default argument of a function that is pure over the platform it is given. `runtimeRootParent` picks `/tmp` on POSIX, where a `sun_path` is 103 bytes and `os.tmpdir()` already overflows it on the macOS runner, and `os.tmpdir()` on win32, where the endpoint is a named pipe and path length is irrelevant. Both answers are a usable runtime root; no assertion depends on which was chosen.",
  },
  {
    file: "helpers/runtime-root.ts",
    container: "createRuntimeRoot",
    construct: "process.platform !== 'win32'",
    kind: "platform-dispatch",
    why: "A guard on a check that only means something where an endpoint is a filesystem path. On win32 the endpoint is a named pipe in the `\\\\.\\pipe` namespace and the runtime root contributes nothing to its length, so there is no limit to compare against. This removes no assertion from any test: it is a precondition that refuses to hand out a root that would bind silently and leave no endpoint behind, and on win32 that failure mode does not exist.",
  },
  {
    file: "mcp-public-entry-points.test.ts",
    container: "scanRepository",
    construct: "violations.push(`${relative(REPO_ROOT, path).split(sep).join('/')}: ${specifier}`)",
    kind: "path-shape",
    why: "The shape of a path on this host, not its identity. A repository-relative path is split on the host separator and rejoined with `/` so the violation message reads the same everywhere. Nothing compares `sep` with anything, and the assertion this text feeds is the same on every platform. `sep` is banned because `sep === '\\\\'` is a platform test; this is the other use of it.",
  },
  {
    file: "mcp-security-leakage-scan.test.ts",
    container: "createLeakWorld",
    construct: "platform: process.platform",
    kind: "value-pass",
    why: IPC_ENDPOINT_VALUE_PASS,
  },
  {
    file: "platform-capabilities.ts",
    container: "platformHasCapability",
    construct: "platformProvidesCapability(id, process.platform)",
    kind: "registry-source",
    why: "The registry’s own read: the one place the host platform is asked for, and the value every declared narrowing is routed through. It is handed straight to `platformProvidesCapability`, which is pure over the platform it is given, so the answer is entirely determined by the reviewed `absentOn` list of the entry being asked about.",
  },
];

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/** The narrowing function, by name, as it must appear at every call site. */
const NARROWING_FUNCTION = 'platformHasCapability';

/** The host-blind probe. Named here so a renamed import of it is reported too. */
const PROBE_FUNCTION = 'platformProvidesCapability';

/** Host-identity members of `node:os`. `tmpdir`/`homedir` are paths, not identity. */
const OS_HOST_MEMBERS: ReadonlySet<string> = new Set([
  'platform',
  'type',
  'release',
  'version',
  'arch',
  'machine',
  'endianness',
  'EOL',
  'devNull',
]);

/** Members of `node:path` whose value differs by host. */
const PATH_HOST_MEMBERS: ReadonlySet<string> = new Set(['sep', 'delimiter']);

/** The `platform` member, for `process` however it was obtained. */
const PROCESS_HOST_MEMBERS: ReadonlySet<string> = new Set(['platform']);

/** Environment variables that name the host operating system, upper-cased. */
const HOST_ENVIRONMENT_KEYS: ReadonlySet<string> = new Set([
  'OS',
  'OSTYPE',
  'WINDIR',
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'HOMEDRIVE',
  'HOMEPATH',
  'MSYSTEM',
]);

interface PolicedRoot {
  readonly label: string;
  readonly members: ReadonlySet<string>;
  /** Whether `env` on this root is the process environment. */
  readonly carriesEnvironment: boolean;
}

const PROCESS_ROOT: PolicedRoot = { label: 'process', members: PROCESS_HOST_MEMBERS, carriesEnvironment: true };

const POLICED_MODULES: ReadonlyMap<string, PolicedRoot> = new Map([
  ['node:os', { label: 'os', members: OS_HOST_MEMBERS, carriesEnvironment: false }],
  ['os', { label: 'os', members: OS_HOST_MEMBERS, carriesEnvironment: false }],
  ['node:path', { label: 'path', members: PATH_HOST_MEMBERS, carriesEnvironment: false }],
  ['path', { label: 'path', members: PATH_HOST_MEMBERS, carriesEnvironment: false }],
  ['node:process', PROCESS_ROOT],
  ['process', PROCESS_ROOT],
]);

/** Call names whose string first argument names the container for a callback. */
const TEST_LIKE_CALLS: ReadonlySet<string> = new Set([
  'test',
  'it',
  'describe',
  'suite',
  'before',
  'after',
  'beforeEach',
  'afterEach',
]);

/** The property a reviewed whole-test platform condition is written under. */
const REVIEWED_EXCLUSION_PROPERTY = 'skip';

/**
 * Parent kinds a pinned construct grows through. A read is pinned to the
 * outermost expression it still decides — the whole condition, the whole
 * message, the whole call it is an argument of — and stops at a statement, a
 * function boundary, or an object/array literal, which is what keeps a pin from
 * swallowing an unrelated sibling.
 */
const CLIMBABLE_PARENT_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.BinaryExpression,
  ts.SyntaxKind.PrefixUnaryExpression,
  ts.SyntaxKind.PostfixUnaryExpression,
  ts.SyntaxKind.ParenthesizedExpression,
  ts.SyntaxKind.PropertyAccessExpression,
  ts.SyntaxKind.ElementAccessExpression,
  ts.SyntaxKind.CallExpression,
  ts.SyntaxKind.NewExpression,
  ts.SyntaxKind.TaggedTemplateExpression,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.TemplateExpression,
  ts.SyntaxKind.TemplateSpan,
  ts.SyntaxKind.NonNullExpression,
  ts.SyntaxKind.AsExpression,
  ts.SyntaxKind.SatisfiesExpression,
  ts.SyntaxKind.TypeAssertionExpression,
  ts.SyntaxKind.AwaitExpression,
  ts.SyntaxKind.TypeOfExpression,
  ts.SyntaxKind.VoidExpression,
  ts.SyntaxKind.SpreadElement,
]);

/** Parent kinds that name the construct rather than being part of it. */
const NAMING_PARENT_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.Parameter,
  ts.SyntaxKind.PropertyDeclaration,
]);

export interface HostPlatformMention {
  /** Path relative to `tests/`. */
  readonly file: string;
  /** 1-based line number, so a report points at something openable. */
  readonly line: number;
  /** Which banned interface this read goes through, e.g. `process.platform`. */
  readonly api: string;
  readonly container: string;
  readonly construct: string;
  /** Why it is reported: undeclared, unreachable, or laundered. */
  readonly note: string;
}

export interface PlatformSourceScan {
  /** Reads that no declaration covers. An empty array means the file is clean. */
  readonly undeclared: readonly HostPlatformMention[];
  /** Keys of the declared sites this file actually matched, in reachable code. */
  readonly matchedSites: readonly string[];
  /** Capability ids narrowed on by a readable call. */
  readonly narrowedIds: readonly string[];
  /** Capability call sites that cannot be read, with the reason. */
  readonly unreadableCalls: readonly string[];
}

function collapse(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function skipParentheses(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

/** Whether an expression is a literal whose truth is known without running it. */
function literalTruth(expression: ts.Expression): boolean | undefined {
  const node = skipParentheses(expression);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isNumericLiteral(node)) return node.text !== '0';
  if (ts.isStringLiteral(node)) return node.text.length > 0;
  return undefined;
}

/**
 * Whether this node sits somewhere that can run at all, as far as a literal
 * condition can tell. General unreachability is not detected; see the header.
 */
function isReachable(node: ts.Node): boolean {
  let child: ts.Node = node;
  let parent: ts.Node | undefined = node.parent;
  while (parent !== undefined) {
    if (ts.isIfStatement(parent)) {
      const truth = literalTruth(parent.expression);
      if (truth === false && parent.thenStatement === child) return false;
      if (truth === true && parent.elseStatement === child) return false;
    } else if (ts.isWhileStatement(parent)) {
      if (literalTruth(parent.expression) === false && parent.statement === child) return false;
    } else if (ts.isBinaryExpression(parent) && parent.right === child) {
      const operator = parent.operatorToken.kind;
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken && literalTruth(parent.left) === false) return false;
      if (operator === ts.SyntaxKind.BarBarToken && literalTruth(parent.left) === true) return false;
    } else if (ts.isConditionalExpression(parent)) {
      const truth = literalTruth(parent.condition);
      if (truth === true && parent.whenFalse === child) return false;
      if (truth === false && parent.whenTrue === child) return false;
    }
    child = parent;
    parent = parent.parent;
  }
  return true;
}

/** The construct a read decides, pinned as source text with whitespace collapsed. */
function pinnedConstruct(node: ts.Node): string {
  let current: ts.Node = node;
  while (current.parent !== undefined && CLIMBABLE_PARENT_KINDS.has(current.parent.kind)) {
    current = current.parent;
  }
  if (current.parent !== undefined && NAMING_PARENT_KINDS.has(current.parent.kind)) current = current.parent;
  return collapse(current.getText());
}

function namedFunctionContext(fn: ts.ArrowFunction | ts.FunctionExpression): string | undefined {
  const parent = fn.parent;
  if (parent === undefined) return undefined;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && TEST_LIKE_CALLS.has(parent.expression.text)) {
    const first = parent.arguments[0];
    if (first !== undefined && ts.isStringLiteralLike(first)) {
      return `${parent.expression.text}(${JSON.stringify(first.text)})`;
    }
  }
  return undefined;
}

/** The nearest enclosing named container, for a report a reader can navigate. */
function containerOf(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name !== undefined) {
      return current.name.getText();
    }
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const named = namedFunctionContext(current);
      if (named !== undefined) return named;
    }
    if (ts.isClassDeclaration(current) && current.name !== undefined) return current.name.text;
    current = current.parent;
  }
  return '<module>';
}

/**
 * Whether this read is the reviewed whole-test platform condition of a test
 * that `REVIEWED_CONDITIONAL_SKIPS` already declares.
 *
 * The exemption is the condition expression itself, not the line it is written
 * on: the read has to sit inside the reviewed property's initializer, the
 * initializer text has to be the reviewed condition exactly, and the test name
 * has to be the reviewed one. A second, unrelated platform read anywhere else
 * on that line is a different construct and is still reported.
 */
function isReviewedWholeTestCondition(file: string, node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined && !ts.isPropertyAssignment(current)) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current) || ts.isStatement(current)) return false;
    current = current.parent;
  }
  if (current === undefined || !ts.isPropertyAssignment(current)) return false;
  if (current.name.getText() !== REVIEWED_EXCLUSION_PROPERTY) return false;
  const object = current.parent;
  if (!ts.isObjectLiteralExpression(object)) return false;
  const call = object.parent;
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== 'test') return false;
  if (!call.arguments.includes(object)) return false;
  const name = call.arguments[0];
  if (name === undefined || !ts.isStringLiteralLike(name)) return false;
  const condition = collapse(current.initializer.getText());
  return REVIEWED_CONDITIONAL_SKIPS.some(
    (entry) => entry.file === file && entry.test === name.text && collapse(entry.condition) === condition,
  );
}

/** Whether an identifier stands for a value here rather than naming something. */
function isReferencePosition(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (parent === undefined) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) return false;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
  if (ts.isParameter(parent) && parent.name === node) return false;
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return false;
  if (ts.isFunctionExpression(parent) && parent.name === node) return false;
  if (ts.isClassDeclaration(parent) && parent.name === node) return false;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return false;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return false;
  if (ts.isPropertySignature(parent) || ts.isMethodSignature(parent)) return false;
  if (ts.isEnumMember(parent) && parent.name === node) return false;
  if (ts.isTypeParameterDeclaration(parent)) return false;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return false;
  if (ts.isExportSpecifier(parent) || ts.isImportEqualsDeclaration(parent)) return false;
  if (ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) return false;
  return true;
}

/** Whether a call's answer is used for anything at all. */
function isAnswerConsumed(call: ts.Node): boolean {
  const parent = call.parent;
  if (parent === undefined) return false;
  if (ts.isExpressionStatement(parent)) return false;
  if (ts.isVoidExpression(parent)) return false;
  if (ts.isAwaitExpression(parent) || ts.isParenthesizedExpression(parent)) return isAnswerConsumed(parent);
  return true;
}

/**
 * Every host-platform read and every capability call in one source file.
 *
 * `file` is the path relative to `tests/` and is what declarations are matched
 * against; `source` is the file's text. The scan parses, so what it reports is
 * syntax, not text: a mention inside a comment, a string, or a regular
 * expression is not a read, and the layout of a real read does not matter.
 */
export function scanPlatformUse(file: string, source: string): PlatformSourceScan {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const undeclared: HostPlatformMention[] = [];
  const matchedSites: string[] = [];
  const narrowedIds: string[] = [];
  const unreadableCalls: string[] = [];

  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const report = (node: ts.Node, api: string, note: string): void => {
    undeclared.push({ file, line: lineOf(node), api, container: containerOf(node), construct: pinnedConstruct(node), note });
  };

  const record = (node: ts.Node, api: string): void => {
    if (isReviewedWholeTestCondition(file, node)) return;
    const container = containerOf(node);
    const construct = pinnedConstruct(node);
    const declaration = DECLARED_HOST_PLATFORM_SITES.find(
      (site) => site.file === file && site.container === container && site.construct === construct,
    );
    if (declaration === undefined) {
      report(node, api, 'no declaration in DECLARED_HOST_PLATFORM_SITES covers this construct');
      return;
    }
    if (!isReachable(node)) {
      report(node, api, 'declared, but the construct sits in code that can never run');
      return;
    }
    matchedSites.push(declaredSiteKey(declaration));
  };

  // Which local names stand for a policed module root, and which stand for a
  // policed member of one. The global `process` is a root without an import.
  const roots = new Map<string, PolicedRoot>([['process', PROCESS_ROOT]]);
  const members = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (clause === undefined || clause.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier.text;
    if (specifier.endsWith('platform-capabilities.ts') && clause.namedBindings !== undefined) {
      const bindings = clause.namedBindings;
      if (ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (imported !== NARROWING_FUNCTION && imported !== PROBE_FUNCTION) continue;
          if (element.propertyName !== undefined && element.name.text !== imported) {
            unreadableCalls.push(
              `${file}:${String(lineOf(element))}: ${imported} is imported as ${element.name.text}, so its call ` +
                'sites cannot be read by name',
            );
          }
        }
      }
    }
    const policed = POLICED_MODULES.get(specifier);
    if (policed === undefined) continue;
    if (clause.name !== undefined) roots.set(clause.name.text, policed);
    const bindings = clause.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) roots.set(bindings.name.text, policed);
    else {
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue;
        const imported = (element.propertyName ?? element.name).text;
        if (policed.members.has(imported)) members.set(element.name.text, `${policed.label}.${imported}`);
      }
    }
  }

  const inspectEnvironment = (env: ts.Node, label: string): void => {
    const parent = env.parent;
    if (parent === undefined) return;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === env) {
      if (HOST_ENVIRONMENT_KEYS.has(parent.name.text.toUpperCase())) record(parent, `${label}.${parent.name.text}`);
      return;
    }
    if (ts.isElementAccessExpression(parent) && parent.expression === env) {
      const key = parent.argumentExpression;
      if (ts.isStringLiteralLike(key) && HOST_ENVIRONMENT_KEYS.has(key.text.toUpperCase())) {
        record(parent, `${label}[${JSON.stringify(key.text)}]`);
      }
      return;
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === env && ts.isObjectBindingPattern(parent.name)) {
      for (const element of parent.name.elements) {
        const bound = (element.propertyName ?? element.name).getText();
        if (HOST_ENVIRONMENT_KEYS.has(bound.toUpperCase())) record(element, `${label}.${bound}`);
      }
      return;
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.InKeyword &&
      parent.right === env &&
      ts.isStringLiteralLike(parent.left) &&
      HOST_ENVIRONMENT_KEYS.has(parent.left.text.toUpperCase())
    ) {
      record(parent, `${parent.left.text} in ${label}`);
    }
  };

  const inspectRootReference = (node: ts.Identifier, root: PolicedRoot): void => {
    const parent = node.parent;
    if (parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      const member = parent.name.text;
      if (root.members.has(member)) record(parent, `${root.label}.${member}`);
      else if (root.carriesEnvironment && member === 'env') inspectEnvironment(parent, `${root.label}.env`);
      return;
    }
    if (parent !== undefined && ts.isElementAccessExpression(parent) && parent.expression === node) {
      const key = parent.argumentExpression;
      if (!ts.isStringLiteralLike(key)) {
        record(parent, `${root.label}[<computed>]`);
        return;
      }
      if (root.members.has(key.text)) record(parent, `${root.label}[${JSON.stringify(key.text)}]`);
      else if (root.carriesEnvironment && key.text === 'env') inspectEnvironment(parent, `${root.label}.env`);
      return;
    }
    record(node, `${root.label} used as a value`);
  };

  const inspectCapabilityCall = (call: ts.CallExpression): void => {
    const callee = call.expression;
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : undefined;
    if (name !== NARROWING_FUNCTION) return;
    const where = `${file}:${String(lineOf(call))}`;
    const first = call.arguments[0];
    if (call.arguments.length !== 1 || first === undefined || !ts.isStringLiteral(first)) {
      unreadableCalls.push(
        `${where}: ${collapse(call.getText()).slice(0, 120)} — a narrowing has to be ${NARROWING_FUNCTION} with ` +
          'exactly one argument, the capability id written as a string literal',
      );
      return;
    }
    if (!isReachable(call)) {
      unreadableCalls.push(`${where}: ${first.text} is narrowed on in code that can never run`);
      return;
    }
    if (!isAnswerConsumed(call)) {
      unreadableCalls.push(`${where}: the answer for ${first.text} is discarded, so it narrows nothing`);
      return;
    }
    narrowedIds.push(first.text);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isReferencePosition(node)) {
      const root = roots.get(node.text);
      if (root !== undefined) inspectRootReference(node, root);
      else {
        const member = members.get(node.text);
        if (member !== undefined) record(node, member);
      }
    }
    if (ts.isCallExpression(node)) inspectCapabilityCall(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  return { undeclared, matchedSites, narrowedIds, unreadableCalls };
}

/**
 * Every source the guard covers: each `.ts` file directly in `tests/` and each
 * one in `tests/helpers/`, as paths relative to `testsDirectory`.
 *
 * Helpers are in because a narrowing hidden in one of them is invisible from
 * the test that calls it, and helpers are exactly where this repository puts
 * its platform dispatch. This file is in as well: its own host read is what
 * every declared narrowing runs through, and it is declared like any other.
 */
export function scannedSourcesUnder(testsDirectory: string): string[] {
  const top = readdirSync(testsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => entry.name);
  const helpers = readdirSync(join(testsDirectory, 'helpers'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => `helpers/${entry.name}`);
  return [...top, ...helpers].sort();
}
