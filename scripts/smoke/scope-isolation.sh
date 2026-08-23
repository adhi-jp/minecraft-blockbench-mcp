#!/usr/bin/env bash
# AC-21 scope-isolation live smoke launcher for Linux and macOS.
#
# Runs scripts/smoke-scope-isolation.mjs against a real Blockbench + plugin
# runtime, after checking the preconditions a human would otherwise discover
# halfway through, and tells you where the receipt landed.
#
# Usage:
#   BLOCKBENCH_MCP_SECRET=<secret> scripts/smoke/scope-isolation.sh [--mode auto|direct|brokered] [--port <port>] [extra helper args...]
#
# Exit codes are the helper's own: 0 PASS, 1 FAIL, 2 INCONCLUSIVE.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
HELPER="${REPO_ROOT}/scripts/smoke-scope-isolation.mjs"

MODE="auto"
PORT="${BLOCKBENCH_MCP_PORT:-39731}"
OUT_PARENT=""
FORWARD=()

# Parse only what the preflight needs; everything is forwarded to the helper,
# which owns the real argument contract.
i=1
while [ "$i" -le "$#" ]; do
  arg="${!i}"
  case "$arg" in
    --mode)
      i=$((i + 1)); MODE="${!i:-}" ;;
    --mode=*)
      MODE="${arg#--mode=}" ;;
    --port)
      i=$((i + 1)); PORT="${!i:-}" ;;
    --port=*)
      PORT="${arg#--port=}" ;;
    --out)
      i=$((i + 1)); OUT_PARENT="${!i:-}" ;;
    --out=*)
      OUT_PARENT="${arg#--out=}" ;;
  esac
  i=$((i + 1))
done
FORWARD=("$@")

if [ -z "${OUT_PARENT}" ]; then
  OUT_PARENT="${TMPDIR:-/tmp}/minecraft-blockbench-mcp-smoke"
  FORWARD+=(--out "${OUT_PARENT}")
fi

say() { printf '%s\n' "$*"; }
fail_closed() {
  say ""
  say "VERDICT: INCONCLUSIVE (precondition not met)"
  say "  $*"
  say ""
  say "Nothing was run, so nothing was proven. This is not a pass."
  exit 2
}

say "=== AC-21 scope-isolation live smoke ==="
say "Repository: ${REPO_ROOT}"
say ""
say "--- Preflight ---"

command -v node >/dev/null 2>&1 || fail_closed "node is not on PATH. Install Node.js 22 or newer."
NODE_VERSION="$(node --version)"
NODE_MAJOR="$(printf '%s' "${NODE_VERSION}" | sed 's/^v\([0-9]*\).*/\1/')"
if [ -z "${NODE_MAJOR}" ] || [ "${NODE_MAJOR}" -lt 22 ]; then
  fail_closed "Node ${NODE_VERSION} is too old; this package requires Node 22 or newer."
fi
say "ok   node ${NODE_VERSION}"

[ -f "${HELPER}" ] || fail_closed "Missing helper: ${HELPER}"
say "ok   helper present"

if [ ! -f "${REPO_ROOT}/dist/adapter/cli.js" ]; then
  fail_closed "Missing dist/adapter/cli.js. Run 'npm run build' in ${REPO_ROOT} first."
fi
if [ ! -f "${REPO_ROOT}/dist/plugin/minecraft_blockbench_mcp.js" ]; then
  fail_closed "Missing dist/plugin/minecraft_blockbench_mcp.js. Run 'npm run build' in ${REPO_ROOT} first."
fi
say "ok   dist/ is built (adapter and plugin bundles present)"

SECRET_PRESENT=0
if [ -n "${BLOCKBENCH_MCP_SECRET:-}" ]; then SECRET_PRESENT=1; fi
for arg in "$@"; do
  case "$arg" in
    --secret|--secret=*) SECRET_PRESENT=1 ;;
  esac
done
if [ "${SECRET_PRESENT}" -eq 0 ]; then
  fail_closed "No shared secret. Export BLOCKBENCH_MCP_SECRET with the same value the Blockbench plugin uses."
fi
say "ok   shared secret is configured (value never printed or written to the receipt)"

case "${MODE}" in
  auto|direct|brokered) ;;
  *) fail_closed "--mode must be auto, direct, or brokered (got '${MODE}')." ;;
esac
if [ "${MODE}" = "auto" ]; then
  say "ok   mode: auto (the platform default on this host; POSIX defaults to brokered)"
else
  say "ok   mode: ${MODE} (explicit)"
fi

# 127.0.0.1:<port> has to be free: the adapter or broker binds it and the
# Blockbench plugin dials into it. A busy port means another adapter owns the
# plugin, and this run would be measuring that one.
if ! node --input-type=module -e '
import net from "node:net";
const port = Number(process.argv[1]);
const server = net.createServer();
server.once("error", () => process.exit(1));
server.listen(port, "127.0.0.1", () => server.close(() => process.exit(0)));
' "${PORT}" >/dev/null 2>&1; then
  fail_closed "127.0.0.1:${PORT} is already in use. Close the other MCP adapter or broker, or rerun with --port <free-port> and point the Blockbench plugin at the same port."
fi
say "ok   127.0.0.1:${PORT} is free"

# Best effort only: there is no portable, reliable way to prove Blockbench is
# running from here. The helper's own health precondition is the authoritative
# check and it fails closed, so this is a warning and never a gate.
if command -v pgrep >/dev/null 2>&1 && pgrep -i -f blockbench >/dev/null 2>&1; then
  say "ok   a Blockbench process appears to be running"
else
  say "warn could not see a Blockbench process. If Blockbench is not running with the MCP plugin"
  say "     connected, the run will stop with INCONCLUSIVE rather than pretending to pass."
fi

mkdir -p "${OUT_PARENT}"
say "ok   receipts directory: ${OUT_PARENT}"

cat <<'STEPS'

--- What you will have to do ---

This smoke needs a human twice. Read this before it starts, because it will
stop and wait for you.

  Phase 1  establish     You confirm a scoped directory in Blockbench.
                         Accept the MCP plugin dialog, and any native Blockbench
                         permission dialog that follows.
  Phase 2  disrupt       Nothing to do. The helper crashes the broker (brokered
                         mode) or restarts the adapter (direct mode) and waits
                         for the plugin to reconnect. This can take up to about
                         30 seconds.
                         DO NOT reload the plugin, restart Blockbench, or revoke
                         the directory by hand at any point. Doing so makes the
                         scenario undriveable and the verdict INCONCLUSIVE.
  Phase 3  assert        Nothing to do. A second client tries the same scoped
                         read without a fresh confirmation. It must be denied.
  Phase 4  re-establish  You confirm the same directory a second time.

Each confirmation has about a two-minute budget once the dialog appears.

STEPS

printf 'Press Enter to start the run, or Ctrl-C to abort. '
read -r _ || true

say ""
say "--- Running ---"
set +e
node "${HELPER}" ${FORWARD[@]+"${FORWARD[@]}"}
STATUS=$?
set -e

RECEIPT_DIR="$(ls -1dt "${OUT_PARENT}"/ac21-scope-isolation-smoke-* 2>/dev/null | head -n 1 || true)"

say ""
say "--- Result ---"
case "${STATUS}" in
  0) say "VERDICT: PASS         the AC-21 invariant held on this host, in the mode the receipt records." ;;
  1) say "VERDICT: FAIL         the second client used the first client's scoped directory. Keep the receipt." ;;
  2) say "VERDICT: INCONCLUSIVE the scenario could not be driven. This is NOT a pass; see verdict_reason." ;;
  *) say "VERDICT: INCONCLUSIVE the helper exited with an unexpected status ${STATUS}. Treat as not run." ;;
esac
if [ -n "${RECEIPT_DIR}" ]; then
  say ""
  say "Receipt:   ${RECEIPT_DIR}/smoke-report.json"
  say "Checklist: ${RECEIPT_DIR}/operator-checklist.md"
  say ""
  say "Send both files back. The receipt carries no secret and no absolute home path."
else
  say ""
  say "No receipt directory was found under ${OUT_PARENT}."
fi

exit "${STATUS}"
