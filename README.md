# minecraft-blockbench-mcp

MCP integration for [Blockbench](https://www.blockbench.net/): a Claude Code-launched
**stdio MCP adapter** plus a **Blockbench desktop plugin**, connected over a
loopback WebSocket, so AI clients can create and edit Minecraft Java
block/item models (`java_block` format) and GeckoLib animated models
(`geckolib_model` format, via the third-party GeckoLib plugin) through
Blockbench itself.

```
Claude Code ──(stdio MCP)── adapter process ──(ws://127.0.0.1:39731)── Blockbench plugin
                            │ owns McpServer,                          │ executes/rejects every
                            │ schema validation,                       │ operation through
                            │ relay only                               │ Blockbench APIs
```

The adapter is only a compatibility shim: it never edits model files itself.
Every operation is executed (or rejected) by the plugin inside Blockbench,
with undo entries and viewport refreshes.

## Prerequisites

- Node.js >= 22
- Blockbench 5.1.x **desktop** (this repository expects its source checkout at
  `external/blockbench` for TypeScript types)
- One-time type generation for the plugin typecheck:

```sh
cd external/blockbench
npm run generate-types
```

## Build

```sh
npm install
npm run check   # typecheck adapter + plugin
npm run build   # emits dist/adapter/** and dist/plugin/minecraft_blockbench_mcp.js
npm test        # protocol, scope-safety, bridge, stdio E2E, plugin-session suites
```

## Setup

### 1. Choose a shared secret

The adapter refuses plugin connections until a secret is configured, and the
plugin refuses to connect until the same secret is entered in its settings.
Pick any random string (for example `openssl rand -hex 16`).

### 2. Register the adapter in Claude Code

```sh
claude mcp add blockbench -e BLOCKBENCH_MCP_SECRET=<your-secret> -- node /path/to/minecraft-blockbench-mcp/dist/adapter/cli.js
```

Configuration precedence: CLI arguments > environment variables > JSON config
file > defaults.

| Setting | CLI | Environment | Default |
| --- | --- | --- | --- |
| WebSocket port | `--port` | `BLOCKBENCH_MCP_PORT` | `39731` |
| Shared secret | `--secret` | `BLOCKBENCH_MCP_SECRET` | (unset — required) |
| Config file path | `--config` | `BLOCKBENCH_MCP_CONFIG` | (none) |
| Request timeout (ms) | `--request-timeout-ms` | `BLOCKBENCH_MCP_REQUEST_TIMEOUT_MS` | `30000` |

The optional config file is a JSON object with keys `port`, `secret`,
`requestTimeoutMs`, `heartbeatIntervalMs`, `heartbeatMissLimit`,
`handshakeTimeoutMs`, `maxMessageBytes`.

### 3. Load the plugin in Blockbench

1. Build (`npm run build`) — the plugin bundle is
   `dist/plugin/minecraft_blockbench_mcp.js`.
2. In Blockbench: **File → Plugins → Load Plugin from File** and select that
   file.
3. In **File → Preferences → Settings → General**, set **MCP Adapter Port**
   (default `39731`) and **MCP Shared Secret** to match the adapter.

When the connection succeeds, Blockbench shows “MCP adapter connected”. The
`health` tool then reports `plugin_connected: true`.

## Scoped file access

File reads/writes (including `export_model` and texture loading by path) are
restricted to one directory per session:

1. The AI client calls `propose_scoped_directory` with an absolute path.
2. Blockbench shows a confirmation dialog with the normalized path. Nothing is
   accessible until you click **Allow this session**.
3. Access lasts for the current session only: it expires when the plugin
   reloads or Blockbench restarts, and **Tools → Revoke MCP Scoped Directory**
   revokes it immediately mid-session.
4. Overwrites require an explicit per-file `overwrite: true` flag; multi-file
   writes preflight every destination and write nothing if any blocker exists.
   Symbolic links inside the scoped directory are rejected.

## Tools

`health` (adapter status; works with Blockbench closed) plus, relayed to the
plugin: `get_plugin_status`, `get_project_state`, `create_project`,
`open_model`, `create_cubes`, `update_cube`, `delete_cubes`, `create_group`,
`update_group`, `delete_group`, `assign_texture`, `set_display_transform`,
`export_model`, `read_file`, `write_files`, `capture_screenshot`,
`validate_project`, `propose_scoped_directory`.

GeckoLib tools (they require the third-party **GeckoLib Models & Animations**
plugin, see below): `create_geckolib_project`, `open_geckolib_model`,
`export_geckolib_model`, `export_geckolib_animations`,
`validate_geckolib_file`.

While Blockbench (or the plugin) is not running, operation tools return a
structured `E_PLUGIN_NOT_CONNECTED` error immediately — the adapter never
auto-launches Blockbench, waits, or retries in the background.

## GeckoLib models

The `geckolib_*` tools drive the third-party
[GeckoLib](https://wiki.geckolib.com/) Blockbench plugin ("GeckoLib Models &
Animations", plugin id `geckolib`; tested with 4.2.5). Install it once inside
Blockbench via **File → Plugins → Available**. Without it, every `geckolib_*`
tool fails per call with a structured `E_PLUGIN_DEPENDENCY_MISSING` error that
names the install remediation; the plugin re-checks the format registration on
every call, so installing or re-enabling GeckoLib takes effect immediately.

- `create_geckolib_project` needs `modid`, `model_type`
  (`Entity|Block|Item|Armor|Object`), and `identifier`; the identifier becomes
  `geometry.<identifier>` and the recommended export file names
  `<identifier>.geo.json` / `<identifier>.animation.json`.
- Geometry building reuses the format-neutral tools (`create_cubes`,
  `create_group`, `assign_texture`, ...) on the GeckoLib project.
- `export_geckolib_model` writes Bedrock-format geometry with
  `format_version 1.12.0` (GeckoLib 4 strict; also loads on GeckoLib 5);
  `export_geckolib_animations` writes the animation JSON with GeckoLib's
  keyframe encoding and `geckolib_format_version: 2`. Item display-settings
  JSON export is not supported.
- `validate_geckolib_file` checks an exported `.geo.json` (and optionally an
  animation JSON's bone references) against rules derived from GeckoLib
  runtime behavior — no official schema exists, so diagnostics carry stable
  `geckolib_*` check ids and the applied profile (`gl4`). `validate_project`
  additionally runs GeckoLib project checks (bone naming, modid/identifier,
  Armor bone template, texture size) when a `geckolib_model` project is open.
- Validation never blocks exports; export and validate are independent tools.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `health` reports `E_SECRET_MISSING` | Configure `--secret` / `BLOCKBENCH_MCP_SECRET` for the adapter. |
| `health` reports `E_PORT_IN_USE` | Another process (possibly an orphaned adapter) holds the port; change `--port` on both sides or free it. |
| Plugin shows “rejected the connection” | Port or secret mismatch between adapter and plugin settings. |
| Plugin loads but nothing happens | Open the Blockbench devtools console (`Ctrl+Shift+I`); Blockbench logs plugin load errors there without any UI notice. |
| File tools fail with `E_SCOPE_*` codes | The scoped directory is unconfirmed, expired (reload), or revoked — run `propose_scoped_directory` again. |

## Development notes

- `npm run dev` (in `external/blockbench`) launches Blockbench with a DevTools
  remote-debugging port, which is handy for driving smoke tests.
- The adapter ↔ plugin protocol (versioned, capability-flagged, partitioned
  into format-neutral and Java-format commands) lives in `src/shared/protocol.ts`;
  the path-containment rules live in `src/shared/scope.ts`.
- GeckoLib and other formats are future adapters: add a capability flag and a
  new command group instead of extending the Java group.
