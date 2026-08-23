// A portable replacement for reading `/proc/<pid>/cmdline` in the test harness.
//
// Two test files observe broker processes directly rather than through their
// after-effects: `broker-e2e.test.ts` checks that a pid it is about to kill
// really is a broker, and `broker-session-in-use-endpoint-preservation.test.ts`
// counts the `__broker` processes spawned for one config file. `/proc` is a
// Linux interface, so on macOS and Windows those reads threw — and a throw
// inside an `after` hook stranded the very processes the hook existed to kill,
// which is how one failed read turned into a whole file that never finished.
//
// Degrading to "found no processes" off Linux was not an option. The caller
// asserts `deepEqual(await brokerPidsForConfig(config), [])`, so a lookup that
// answers `[]` because it cannot look would make that assertion hold on every
// platform while proving nothing. Each platform therefore gets a real
// enumeration, and a mechanism that is unavailable or broken throws instead of
// reporting an empty world:
//
//   linux   `/proc/<pid>/cmdline`. Real NUL-separated argv, no subprocess.
//   darwin  `ps -A -ww -o pid=,command=`. The second `w` is load-bearing: macOS
//           `ps` otherwise truncates each line to the window width, and a
//           hosted runner has no tty to take a width from.
//   win32   one `Get-CimInstance Win32_Process` call through PowerShell, which
//           reports `ProcessId` and `CommandLine`. `wmic` is gone from current
//           Windows images. PowerShell startup is slow, so a scan reads the
//           whole table in a single call rather than one call per pid.
//
// `ps` and CIM both return one joined string where Linux returns real argv.
// Reconstructing the arguments from that string is what keeps the match honest:
// the callers ask "is `__broker` one of this process's arguments", not "does
// this text contain `__broker`", and a substring test would also match a
// process that merely mentions the word — an editor with the file open, or
// another test's argument that ends with the same characters.
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';

/** A live process, as much of it as this platform will report. */
export interface ProcessEntry {
  pid: number;
  /** The command line as one string; arguments are separated by single spaces. */
  commandLine: string;
  /** The arguments, exact where `argvIsExact`, reconstructed otherwise. */
  argv: string[];
  /**
   * Whether `argv` is the process's real argument vector rather than a guess.
   *
   * True on Linux (the kernel hands over NUL-separated argv) and on Windows
   * (`CommandLine` is the string Windows built from argv, and the parser below
   * is the inverse of that quoting). False for `ps`, which joins arguments with
   * spaces and cannot say which spaces were separators.
   */
  argvIsExact: boolean;
}

const SCAN_TIMEOUT_MS = 30_000;
const SCAN_MAX_BUFFER = 16 * 1024 * 1024;

interface CommandOutcome {
  ok: boolean;
  stdout: string;
  error: (Error & { code?: string | number }) | null;
}

async function runCommand(command: string, args: string[]): Promise<CommandOutcome> {
  return new Promise<CommandOutcome>((resolve) => {
    execFile(
      command,
      args,
      { encoding: 'utf8', maxBuffer: SCAN_MAX_BUFFER, timeout: SCAN_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        resolve({ ok: error === null, stdout: stdout ?? '', error: error as CommandOutcome['error'] });
      },
    );
  });
}

/** True when the command could not be started at all, as opposed to exiting non-zero. */
function isMissingCommand(error: CommandOutcome['error']): boolean {
  return error !== null && (error.code === 'ENOENT' || error.code === 'EACCES');
}

// ---------------------------------------------------------------------------
// Windows command-line parsing
// ---------------------------------------------------------------------------

/**
 * Split a Windows command line into arguments the way `CommandLineToArgvW`
 * does, which is the inverse of the quoting `child_process.spawn` applies when
 * it builds one. Backslashes are only special in front of a quote: `2n` of them
 * yield `n` backslashes and toggle quoting, `2n+1` yield `n` backslashes and a
 * literal quote.
 */
export function parseWindowsCommandLine(commandLine: string): string[] {
  const argv: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  let index = 0;
  while (index < commandLine.length) {
    const character = commandLine[index];
    if (character === '\\') {
      let backslashes = 0;
      while (commandLine[index] === '\\') {
        backslashes += 1;
        index += 1;
      }
      if (commandLine[index] === '"') {
        current += '\\'.repeat(backslashes >> 1);
        if (backslashes % 2 === 1) current += '"';
        else quoted = !quoted;
        started = true;
        index += 1;
      } else {
        current += '\\'.repeat(backslashes);
        started = true;
      }
      continue;
    }
    if (character === '"') {
      if (quoted && commandLine[index + 1] === '"') {
        // `""` inside a quoted run is one literal quote.
        current += '"';
        index += 2;
        continue;
      }
      quoted = !quoted;
      started = true;
      index += 1;
      continue;
    }
    if (!quoted && (character === ' ' || character === '\t')) {
      if (started) {
        argv.push(current);
        current = '';
        started = false;
      }
      index += 1;
      continue;
    }
    current += character;
    started = true;
    index += 1;
  }
  if (started) argv.push(current);
  return argv;
}

// ---------------------------------------------------------------------------
// Argument matching
// ---------------------------------------------------------------------------

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Whether `argument` is one whole argument of `entry`, not merely text inside
 * its command line.
 *
 * On Linux and Windows this is exact argument equality, which is what the
 * Linux-only original did. Windows compares case-insensitively because Windows
 * paths are: two spellings of one path are one argument there, and the config
 * paths these tests match on come from a `mkdtemp` name that no other process
 * can be carrying by accident.
 *
 * `ps` platforms lose the separator information, so an argument containing
 * whitespace cannot be recovered as a single token there. Those fall back to a
 * whitespace-delimited search of the joined line, which is the closest thing to
 * an argument match that survives the join — still anchored at both ends, so it
 * cannot fire on a longer argument that merely ends with the same characters.
 * Every argument these tests look for (`__broker`, a `mkdtemp` config path) is
 * whitespace-free, so in practice they take the exact path on every platform.
 */
export function hasArgument(entry: ProcessEntry, argument: string): boolean {
  if (process.platform === 'win32') {
    const wanted = argument.toLowerCase();
    return entry.argv.some((token) => token.toLowerCase() === wanted);
  }
  if (entry.argvIsExact || !/\s/u.test(argument)) return entry.argv.includes(argument);
  return new RegExp(`(?:^|\\s)${escapeRegExp(argument)}(?:\\s|$)`, 'u').test(entry.commandLine);
}

// ---------------------------------------------------------------------------
// Linux: /proc
// ---------------------------------------------------------------------------

function linuxEntry(pid: number, raw: string): ProcessEntry {
  const argv = raw.split('\0').filter((token) => token !== '');
  return { pid, commandLine: argv.join(' '), argv, argvIsExact: true };
}

async function linuxEntryFor(pid: number): Promise<ProcessEntry | null> {
  try {
    return linuxEntry(pid, await readFile(`/proc/${String(pid)}/cmdline`, 'utf8'));
  } catch {
    return null;
  }
}

async function linuxEntries(): Promise<ProcessEntry[]> {
  const entries: ProcessEntry[] = [];
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/u.test(name)) continue;
    let raw: string;
    try {
      raw = await readFile(`/proc/${name}/cmdline`, 'utf8');
    } catch {
      // The process exited between the directory listing and the read.
      continue;
    }
    entries.push(linuxEntry(Number(name), raw));
  }
  return entries;
}

// ---------------------------------------------------------------------------
// macOS and other BSDs: ps
// ---------------------------------------------------------------------------

function psEntry(pid: number, commandLine: string): ProcessEntry {
  const trimmed = commandLine.trim();
  return {
    pid,
    commandLine: trimmed,
    argv: trimmed === '' ? [] : trimmed.split(/\s+/u),
    argvIsExact: false,
  };
}

async function psEntryFor(pid: number): Promise<ProcessEntry | null> {
  const outcome = await runCommand('ps', ['-ww', '-o', 'command=', '-p', String(pid)]);
  if (!outcome.ok) {
    // `ps` exits non-zero for a pid that is gone, which is an answer. Not being
    // able to run `ps` at all is not, and must not read as "no such process".
    if (isMissingCommand(outcome.error)) {
      throw new Error(`process scan: could not run \`ps\` on ${process.platform}: ${String(outcome.error?.message)}`);
    }
    return null;
  }
  const line = outcome.stdout.split(/\r?\n/u).find((candidate) => candidate.trim() !== '');
  if (line === undefined) return null;
  return psEntry(pid, line);
}

async function psEntries(): Promise<ProcessEntry[]> {
  const outcome = await runCommand('ps', ['-A', '-ww', '-o', 'pid=,command=']);
  if (!outcome.ok) {
    throw new Error(
      `process scan: \`ps -A -ww -o pid=,command=\` failed on ${process.platform}: ${String(outcome.error?.message)}`,
    );
  }
  const entries: ProcessEntry[] = [];
  for (const line of outcome.stdout.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
    if (match === null) continue;
    entries.push(psEntry(Number(match[1]), match[2]));
  }
  if (entries.length === 0) {
    throw new Error('process scan: `ps` listed no processes at all, so its output was not understood');
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Windows: Get-CimInstance Win32_Process
// ---------------------------------------------------------------------------

const POWERSHELL_COMMANDS = ['powershell.exe', 'pwsh.exe', 'pwsh'];

/**
 * A PowerShell one-liner printing `<pid><TAB><command line>` per process.
 *
 * Any newline inside a command line is folded to a space so one process is
 * always one output line. `CommandLine` is null for processes this user cannot
 * query; those become an empty string and simply match nothing.
 */
function cimScript(pid: number | null): string {
  const filter = pid === null ? '' : ` -Filter 'ProcessId = ${String(pid)}'`;
  return [
    "$ErrorActionPreference = 'Stop'",
    // A BOM-less UTF-8: `[System.Text.Encoding]::UTF8` carries a preamble that
    // Windows PowerShell would emit ahead of the first line.
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    `Get-CimInstance -ClassName Win32_Process${filter} | ForEach-Object { ` +
      "[string]$_.ProcessId + [char]9 + (([string]$_.CommandLine) -replace '[\\r\\n]+', ' ') }",
  ].join('; ');
}

async function runPowerShell(script: string): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const failures: string[] = [];
  for (const command of POWERSHELL_COMMANDS) {
    const outcome = await runCommand(command, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]);
    if (outcome.ok) return outcome.stdout;
    if (!isMissingCommand(outcome.error)) {
      throw new Error(`process scan: ${command} failed to list processes: ${String(outcome.error?.message)}`);
    }
    failures.push(`${command}: ${String(outcome.error?.code)}`);
  }
  throw new Error(`process scan: no PowerShell available to list processes (${failures.join(', ')})`);
}

function win32Entries(stdout: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of stdout.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    const separator = line.indexOf('\t');
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim();
    if (!/^\d+$/u.test(field)) continue;
    const commandLine = line.slice(separator + 1).trim();
    entries.push({
      pid: Number(field),
      commandLine,
      argv: parseWindowsCommandLine(commandLine),
      argvIsExact: true,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

function assertPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) throw new TypeError(`not a process id: ${String(pid)}`);
}

/** One live process by pid, or null when nothing is running under that pid. */
export async function processEntry(pid: number): Promise<ProcessEntry | null> {
  assertPid(pid);
  if (process.platform === 'linux') return linuxEntryFor(pid);
  if (process.platform !== 'win32') return psEntryFor(pid);
  const entries = win32Entries(await runPowerShell(cimScript(pid)));
  return entries.find((entry) => entry.pid === pid) ?? null;
}

/**
 * The command line of a running process as one string, or null when the process
 * is gone. Arguments are separated by single spaces, so a caller can match
 * `/(?:^|\s)__broker(?:\s|$)/` against it on every platform.
 */
export async function processCommandLine(pid: number): Promise<string | null> {
  return (await processEntry(pid))?.commandLine ?? null;
}

/** Every live process this platform will report, in no particular order. */
export async function listProcesses(): Promise<ProcessEntry[]> {
  if (process.platform === 'linux') return linuxEntries();
  if (process.platform !== 'win32') return psEntries();
  const entries = win32Entries(await runPowerShell(cimScript(null)));
  if (entries.length === 0) {
    throw new Error('process scan: Win32_Process listed no processes at all, so its output was not understood');
  }
  return entries;
}

/** The pids of every live process matching `matches`, ascending. */
export async function findProcessPids(matches: (entry: ProcessEntry) => boolean): Promise<number[]> {
  return (await listProcesses())
    .filter((entry) => matches(entry))
    .map((entry) => entry.pid)
    .sort((a, b) => a - b);
}
