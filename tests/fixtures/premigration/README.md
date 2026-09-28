# Frozen wire baseline of the stdio MCP executable

This directory is a recording of everything `dist/adapter/cli.js` puts on the
wire, captured before any dependency change. It exists so the same inputs can be
replayed against a rebuilt executable later and compared message by message.

`tests/premigration-wire-baseline.test.ts` replays it. Nothing here is written or
edited by hand: every file is produced by
`node scripts/capture-premigration-baseline.mjs`, except this README.

**The tool catalogue is no longer frozen.** The `tools` array of a recorded
`tools/list` response (tool names, order, descriptions, input schemas,
`execution` metadata) stays in the recordings but is not compared with the
current build. It guarded the MCP `2026-07-28` migration; since then the tools
keep evolving, and holding each addition or rewording to this recording would
need a migration-ledger entry every time. Everything around the catalogue, and
every other recorded message, is still compared in full. The derived
`tool-order.json` and `tool-input-schemas.json` views were removed with it.
None of the three recorded `tools/list` responses is hash-compared against the
current build any more; only the member order surrounding the catalogue, and
every non-catalog member, is checked.

## Provenance

| Item | Value |
| --- | --- |
| Repository commit | `93a203ee825161c747bb50a5df8258f43119f65f` |
| Package version | `0.1.0` |
| `@modelcontextprotocol/sdk` (installed) | `1.29.0` (declared `^1.29.0`) |
| `zod` (installed) | `3.25.76` (declared `^3.25.0`) |
| `ws` (declared) | `^8.18.0` |
| Node.js | `v24.13.0` |
| Platform | `linux` (WSL2) |
| Recording date | 2026-08-22 |
| Adapter mode | direct, pinned with `--direct` |
| Environment | `isolated-empty-config-home` (see below) |

The same values are stored machine-readably in the `provenance` object of
`corpus-index.json`. The recording date is only
in this README on purpose: no generated file carries a timestamp, so
re-recording an unchanged build produces byte-identical files.

### Why direct mode is pinned

`resolveAdapterMode` in `src/adapter/config.ts` defaults to brokered plugin
connectivity on every platform except Windows. Brokered startup elects or spawns
a shared per-user broker process, whose port, PID, socket path, and lifetime vary
between runs and leak across recordings. Passing `--direct` keeps each recording
to a single short-lived process. Brokered-mode wire behaviour is not recorded
here.

### The `isolated-empty-config-home` environment

Mirrors the isolation used by `scripts/verify-package.mjs` so that no
machine-local `setup` state can reach a recording:

- `BLOCKBENCH_MCP_SECRET`, `BLOCKBENCH_MCP_CONFIG`, `BLOCKBENCH_MCP_DIRECT`, and
  `BLOCKBENCH_MCP_BROKER` are removed from the environment.
- `XDG_CONFIG_HOME`, `HOME`, `APPDATA`, and `USERPROFILE` all point at a fresh
  empty temporary directory, removed after the process exits.
- Working directory is the repository root.

Because no shared secret is configured, `WsBridge.start()` reports
`E_SECRET_MISSING` and never binds a TCP port. That is what makes the recording
reproducible: there is no listener, so no port conflict and no
`E_PORT_IN_USE`/`E_LISTENER_FAILED` variation, and every recorded session is a
Blockbench-disconnected session.

## Normalization rules

Only values that genuinely vary between machines and runs are rewritten. Every
rule is listed here; there are no others.

| Rule | Replacement | Applied to |
| --- | --- | --- |
| The temporary config home given to the process | `<config-home>` | stdout lines, stderr lines |
| The repository root absolute path | `<repo-root>` | stdout lines, stderr lines |
| The absolute path of the Node.js executable | `<node-exec-path>` | stdout lines, stderr lines |
| A trailing carriage return on a line | removed | stdout lines, stderr lines |

**Measured: none of these rules currently fires on stdout.** Every scenario file
records `stdout.normalizationRewroteStdout: false`, and the replay test asserts
that value still holds. If a future build starts putting a machine path on
stdout, that assertion fails instead of silently normalizing it away.

Deliberately **not** normalized, because each is part of the contract rather than
machine state:

- tool order, tool names, descriptions, and per-tool `execution` metadata
- every advertised `inputSchema`, including `$ref` self-references
- error codes (`-32601`, `-32602`, `-32603`) and error message text
- `E_*` envelope codes, envelope summaries, and the two-space pretty-printed
  JSON envelope formatting
- `isError`
- the advertised capability object and `serverInfo`
- protocol version echoes
- `port: 39731`, which is the `DEFAULT_WS_PORT` constant from
  `src/shared/protocol.ts`, not a machine-assigned port
- JSON-RPC request ids and their ordering

### JSON property order

Property order **was measured to be stable**: two consecutive recordings of the
same build produce byte-identical files, and `tools/list` is byte-identical
across runs and across all five negotiated protocol revisions.

Rather than rely on that, each recorded message is stored twice over: the parsed
`message` is the parity oracle and is compared semantically, while `rawSha256`
is the SHA-256 of the raw stdout line. A property-order change therefore fails
one clearly named test ("the JSON property order emitted on the wire still
matches the recording") without failing the semantic parity assertions, so the
two kinds of change can be told apart.

### Shutdown log tolerance

The replay compares recorded stderr line by line, with one tolerance: a line
beginning `[minecraft-blockbench-mcp] Shutting down` is required to match only
if the replay produced it, because the process can exit while that line is still
buffered in the pipe. Every line written before shutdown must match exactly.

## What is in here

`corpus-index.json` lists every file and the behaviour class it covers; the
replay test fails if a listed file disappears or a class loses coverage.

### Session recordings — `scenarios/*.json`

Each file records one child-process session: the exact stdin lines, how many
stdout messages each line produced, every response, the termination signal, the
exit status, and the stderr lines. `steps[].send` (or `steps[].sendRawLine` for
input that is not valid JSON) is the frozen input replayed later, with its
original request ids and ordering preserved.

| Scenario | What it pins down |
| --- | --- |
| `initialize-2025-11-25`, `initialize-2025-06-18`, `initialize-2025-03-26`, `initialize-2024-11-05`, `initialize-2024-10-07` | Each supported legacy MCP revision is accepted, echoed back unchanged, and answered with the same capability object (`tools.listChanged: true`) and the same `serverInfo`. `notifications/initialized` produces no response. |
| `initialize-unsupported-version` | An unsupported revision is answered with a **successful** result naming the latest supported revision, not a JSON-RPC error. |
| `initialize-missing-params` | `initialize` with no `params` returns JSON-RPC `-32603` carrying the validation issue list, and the connection stays usable. |
| `method-inventory` | Which standard MCP methods this server answers (`initialize`, `ping`, `tools/list`, `tools/call`) and which the dependency reports absent with `-32601` (`prompts/*`, `resources/*`, `completion/complete`, `logging/setLevel`, `roots/list`, `sampling/createMessage`, `elicitation/create`, `tasks/list`). This is the negative evidence that no prompt, resource, completion, logging, or task surface is served. |
| `tools-list-inventory` | The complete `tools/list` response: 32 tools, their order, descriptions, every input schema, and the `execution` metadata the recorded build emits on every revision including the oldest. |
| `tools-list-before-initialize` | `tools/list` is answered on a connection that never sent `initialize`, and returns the same inventory. |
| `tool-call-health-success` | A successful tool result: the pretty-printed envelope, its summary sentence, `ok: true`, and no `isError` member. |
| `tool-arguments-omitted` | Omitting the `arguments` member entirely is rejected by the dependency validation layer for both a no-parameter tool (`health`) and a tool with required parameters (`read_file`). |
| `tool-arguments-invalid-dependency-layer` | A wrong value type and an unrecognized extra key are both rejected against the advertised schema before the handler runs. |
| `tool-arguments-invalid-handler-layer` | The dual-layer validation contract: `set_cube_uv` and `validate_geckolib_file` are built from a schema with a top-level refinement, whose innermost object is what gets advertised, so arguments that satisfy the advertised schema still reach the handler and are rejected there with an `E_INVALID_PARAMS` envelope. |
| `unknown-method-and-unknown-tool` | The two failure shapes differ and both are frozen: an unknown method is a JSON-RPC `-32601` error response, while an unknown tool name is a **successful** response carrying an `isError: true` text result. |
| `plugin-absent-health-and-relay` | With Blockbench not running, `health` still succeeds and reports `plugin_connected: false` plus the `E_SECRET_MISSING` setup error, while relayed commands fail with an `E_PLUGIN_NOT_CONNECTED` envelope and `isError: true`. |
| `malformed-and-unframed-input` | A line that is not JSON, a JSON-RPC batch array, a frame missing `jsonrpc`, and an empty line are each dropped with no stdout output, and the connection keeps answering afterwards. |
| `stdout-framing` | A mixed session — results, an error response, an `isError` result, and a client notification — stays at exactly one newline-delimited JSON-RPC object per stdout line, with every adapter log line on stderr. The recorded stderr lines are the positive control proving logging happened and went elsewhere. |
| `cancellation-notifications` | `notifications/cancelled` for request ids `0`, `""`, `1`, and `"never-issued"` each produce no stdout and no error, and the connection keeps serving requests. |
| `shutdown-stdin-eof`, `shutdown-sigterm`, `shutdown-sigint` | Each termination path exits with code `0`, no signal, and no further stdout. |

Note on `execution: { "taskSupport": "forbidden" }`: the recorded build emits
this member on every tool in `tools/list` for **all five** negotiated revisions,
including revisions that predate it. It is recorded exactly as observed rather
than filtered, so any later decision to scope it to a specific revision shows up
as a visible, reviewable difference.

## Regenerating

```sh
npm run build                                    # dist/ must match the source under test
node scripts/capture-premigration-baseline.mjs   # rewrites every file except this README
```

## Confirming these fixtures can fail

Copy the directory somewhere disposable, change one load-bearing value in the
copy, and point the replay at it:

```sh
cp -r tests/fixtures/premigration /tmp/wire-check
# edit one recorded error code, envelope code, or isError flag in /tmp/wire-check
BLOCKBENCH_MCP_BASELINE_FIXTURE_DIR=/tmp/wire-check \
  node --test --import tsx tests/premigration-wire-baseline.test.ts
```

The affected assertions fail and name the scenario and the step.
Delete the copy and re-run without the variable to return to a clean pass. Never
edit the files in this directory to make a test pass.
