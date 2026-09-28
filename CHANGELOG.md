# Changelog

All notable changes to `@adhisang/minecraft-blockbench-mcp` are documented in this file.

## [Unreleased]

### Added

- **New `close_project` tool.** Closes the active project tab without ever showing a dialog: a tab created or opened by `create_project`, `open_model`, `create_geckolib_project`, or `open_geckolib_model` in the current plugin session closes without a save prompt (discarding unsaved changes); any other tab closes only when it is saved, and an unsaved one is refused with `E_INVALID_PARAMS`, closing nothing.
- **`open_model` and `open_geckolib_model` reload file-linked textures on every open** and return `path` plus `textures` (each with `id`, `name`, `path`, and an `error` when it failed to load); `open_model` also returns `warnings` describing any adjustment it made while opening the file.
- **`open_model` resolves more real-world Java block/item models.** It accepts sprite-object texture values, resolves multi-hop `#texture` variable chains, and opens a model that has a parent but no elements without Blockbench's own child-model dialog (keeping the parent for export).
- **`open_model` can inline the parent chain.** New opt-in `resolve_parents` (with optional `asset_roots`) reads each parent model only from inside the confirmed scoped directory — first under the opened model's own assets directory, then each `asset_roots` entry in order — and merges it into the opened model: textures child-first, the nearest ancestor's elements when the child has none, display settings per slot child-first, and `ambientocclusion` and `gui_light` from the nearest model that sets them. `builtin/*` and flat item parents (`item/generated`, `item/handheld`) are kept as the parent instead of being inlined, and when no model in the chain has elements the parent is kept too, with a warning. Textures still resolve against the opened model's own assets directory, not `asset_roots`.
- **`capture_screenshot` and `capture_geckolib_animation_frame` can write directly to a file.** New `output_path` (inside the confirmed scoped directory) and `overwrite` parameters; results also carry `project` (`uuid`, `name`) and `counts` (`cubes`, `groups`, `textures`) identity.

### Changed

- Java project tabs opened via `open_model` are now named after the opened file.
- `force` is no longer needed on `create_project`, `open_model`, `create_geckolib_project`, or `open_geckolib_model`: other open tabs, saved or not, are left untouched. The parameter is still accepted for compatibility but has no effect.

### Fixed

- `open_model` on Windows now resolves the model's textures; Blockbench previously received the model path with `/` separators and found none of them.
- On case-insensitive filesystems (Windows, default macOS), `write_files` and the capture tools' `output_path` now reject a path that reaches a symbolic link inside the scoped directory through a differently cased name (for example `renders/` for a link named `Renders`).

### Breaking changes

- **`capture_screenshot` and `capture_geckolib_animation_frame` no longer return a `data_url` text field by default.** Without `output_path`, results now return the PNG as MCP image content instead. With `output_path`, results return `path` and `bytes` in place of `data_url`.

## [0.2.0] - 2026-08-28

### Added

- **MCP protocol revision `2026-07-28`.** The adapter also continues to
  support `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, and
  `2024-10-07`, settled per connection so clients on different revisions can
  use the same installed adapter.
- **Multi-client support.** A per-user broker process lets multiple AI
  clients configured with the same config file share one Blockbench
  connection. By default, which broker a client joins depends on the config
  file alone, not on the rest of that client's environment, so different AI
  tools (for example Claude Code and Codex CLI) can share it.

### Breaking changes

- **POSIX default connectivity mode is now brokered, not direct.** On Linux, WSL,
  and macOS, the adapter defaults to routing MCP traffic through a per-user
  detached broker process instead of binding its own WebSocket listener
  directly. Windows is unaffected (still direct by default). Use `--direct` or
  `BLOCKBENCH_MCP_DIRECT=1` to keep the previous behavior on POSIX.
- **The adapter ↔ plugin protocol version is now 6** (previously 5), adding
  the broker control commands and their error codes. This is the internal
  handshake between the adapter and the Blockbench desktop plugin, not the MCP
  protocol revision the adapter speaks to AI clients. A 0.1.0 plugin
  connecting to this adapter is closed with `protocol_mismatch` (`health`
  shows `plugin_connected: false`); update and reload the Blockbench plugin
  (`dist/plugin/minecraft_blockbench_mcp.js`) together with the adapter.
- **The `health` tool now rejects unrecognized argument keys** instead of
  silently discarding them. A call passing an undeclared key fails with
  `Input validation error: Invalid arguments for tool health: Unrecognized key: "<key>"`.
- **Public tool input schemas moved from JSON Schema draft-07 to the 2020-12
  dialect.** Concretely: the advertised `$schema` is now
  `https://json-schema.org/draft/2020-12/schema`; fixed-length tuples are
  advertised with `prefixItems` for each position, plus a single `items`
  schema for the element type and the unchanged `minItems`/`maxItems` length
  bound, so hosts that read only `items` (such as Codex and OpenAI function
  calling) still see a number array; discriminated unions are advertised under
  `oneOf` instead of `anyOf`
  (numeric-literal unions moved the other way, from a bare `enum` to `anyOf` of
  `const` branches — this is not a blanket "every union changed direction"
  claim). No runtime validation behavior changed as a result of the dialect
  move itself.
- **An unknown tool name now returns a JSON-RPC `-32602` protocol error**
  (`Tool <name> not found`) instead of a successful result carrying
  `isError: true`.

### Fixed

- The Blockbench plugin's declared `min_version` is now `5.1.4`, matching the
  actual minimum required by `UVSizeUtil.adjustProjectResolution` (used by
  `set_texture_resolution`). Blockbench 5.1.0-5.1.3 previously loaded without
  warning and crashed on that call; they are now correctly blocked by
  Blockbench's own compatibility check instead. `README.md`'s development
  prerequisite was updated to match.
- The adapter's broker endpoint path is now length-checked before use. On
  POSIX, if the resolved Unix domain socket path would exceed the platform's
  usable `sun_path` length, startup now fails loudly with the resolved path,
  its measured length, and the limit, instead of silently producing a broker
  that reports itself as listening while binding nothing reachable. If this
  affects you, use `--direct`, `BLOCKBENCH_MCP_DIRECT=1`, or set
  `BLOCKBENCH_MCP_RUNTIME_DIR` to a short absolute path in every client that
  uses that config file.
- A narrow crash window during broker startup — a crash between creating the
  startup lock file and finishing its write — could previously leave a
  malformed lock file that blocked every future startup attempt indefinitely.
  Startup-lock publication is now atomic, and a malformed lock is now
  recovered from immediately rather than left stuck.

### Known limitations

- **AC-21 (scope isolation) remains unverified.** The deterministic half of
  this invariant — that a different client cannot use a prior client's
  confirmed scoped directory before the existing revocation/confirmation
  invariant is re-established, after a broker crash or plugin reconnect — is
  covered by `tests/adapter-scope-isolation.test.ts` and passes. The live
  half — the same invariant against a real Blockbench desktop session, a real
  scoped filesystem directory, and a human answering the confirmation dialog —
  has not been run on any platform as of this release. This is an acceptance
  of missing evidence, not evidence that the product fails the criterion. See
  `docs/reference/acceptance-criteria.md` for the full criterion text and the
  procedure to close it (`npm run smoke:scope-isolation-live`).
