# Changelog

All notable changes to `@adhisang/minecraft-blockbench-mcp` are documented in this file.

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
