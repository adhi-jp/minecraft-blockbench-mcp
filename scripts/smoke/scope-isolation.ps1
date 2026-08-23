# AC-21 scope-isolation live smoke launcher for Windows PowerShell.
#
# Runs scripts\smoke-scope-isolation.mjs against a real Blockbench + plugin
# runtime, after checking the preconditions a human would otherwise discover
# halfway through, and tells you where the receipt landed.
#
# Works on Windows PowerShell 5.1 and on PowerShell 7: no null-coalescing, no
# ternary, no PowerShell-7-only automatic variables, and the port probe uses
# .NET rather than a shell-quoted Node one-liner.
#
# Usage (from the repository root):
#   $env:BLOCKBENCH_MCP_SECRET = '<secret>'
#   powershell -ExecutionPolicy Bypass -File scripts\smoke\scope-isolation.ps1 [--mode auto|direct|brokered] [--port <port>]
#
# Exit codes are the helper's own: 0 PASS, 1 FAIL, 2 INCONCLUSIVE.

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
$Helper = Join-Path (Join-Path $RepoRoot 'scripts') 'smoke-scope-isolation.mjs'

function Say([string] $Text) { Write-Host $Text }

function Fail-Closed([string] $Reason) {
    Say ''
    Say 'VERDICT: INCONCLUSIVE (precondition not met)'
    Say ("  " + $Reason)
    Say ''
    Say 'Nothing was run, so nothing was proven. This is not a pass.'
    exit 2
}

# Parse only what the preflight needs; everything is forwarded to the helper,
# which owns the real argument contract.
$Mode = 'auto'
$Port = 39731
if ($env:BLOCKBENCH_MCP_PORT) { $Port = [int] $env:BLOCKBENCH_MCP_PORT }
$OutParent = ''
$Forward = @()
$SecretOnCommandLine = $false

for ($i = 0; $i -lt $args.Count; $i++) {
    $arg = [string] $args[$i]
    $Forward += $arg
    if ($arg -eq '--mode' -and ($i + 1) -lt $args.Count) { $Mode = [string] $args[$i + 1] }
    elseif ($arg -like '--mode=*') { $Mode = $arg.Substring(7) }
    elseif ($arg -eq '--port' -and ($i + 1) -lt $args.Count) { $Port = [int] $args[$i + 1] }
    elseif ($arg -like '--port=*') { $Port = [int] $arg.Substring(7) }
    elseif ($arg -eq '--out' -and ($i + 1) -lt $args.Count) { $OutParent = [string] $args[$i + 1] }
    elseif ($arg -like '--out=*') { $OutParent = $arg.Substring(6) }
    elseif ($arg -eq '--secret' -or $arg -like '--secret=*') { $SecretOnCommandLine = $true }
}

if ([string]::IsNullOrEmpty($OutParent)) {
    $OutParent = Join-Path $env:TEMP 'minecraft-blockbench-mcp-smoke'
    $Forward += '--out'
    $Forward += $OutParent
}

Say '=== AC-21 scope-isolation live smoke ==='
Say ("Repository: " + $RepoRoot)
Say ''
Say '--- Preflight ---'

$NodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $NodeCommand) { Fail-Closed 'node is not on PATH. Install Node.js 22 or newer.' }
$NodeVersion = (& node --version)
$NodeMajor = 0
if ($NodeVersion -match '^v(\d+)') { $NodeMajor = [int] $Matches[1] }
if ($NodeMajor -lt 22) { Fail-Closed ("Node " + $NodeVersion + " is too old; this package requires Node 22 or newer.") }
Say ("ok   node " + $NodeVersion + " (PowerShell " + $PSVersionTable.PSVersion.ToString() + ")")

if (-not (Test-Path -LiteralPath $Helper)) { Fail-Closed ("Missing helper: " + $Helper) }
Say 'ok   helper present'

$AdapterCli = Join-Path (Join-Path (Join-Path $RepoRoot 'dist') 'adapter') 'cli.js'
$PluginBundle = Join-Path (Join-Path (Join-Path $RepoRoot 'dist') 'plugin') 'minecraft_blockbench_mcp.js'
if (-not (Test-Path -LiteralPath $AdapterCli)) { Fail-Closed ("Missing dist\adapter\cli.js. Run 'npm run build' in " + $RepoRoot + " first.") }
if (-not (Test-Path -LiteralPath $PluginBundle)) { Fail-Closed ("Missing dist\plugin\minecraft_blockbench_mcp.js. Run 'npm run build' in " + $RepoRoot + " first.") }
Say 'ok   dist\ is built (adapter and plugin bundles present)'

if (-not $SecretOnCommandLine -and [string]::IsNullOrEmpty($env:BLOCKBENCH_MCP_SECRET)) {
    Fail-Closed 'No shared secret. Set $env:BLOCKBENCH_MCP_SECRET to the same value the Blockbench plugin uses.'
}
Say 'ok   shared secret is configured (value never printed or written to the receipt)'

if (@('auto', 'direct', 'brokered') -notcontains $Mode) {
    Fail-Closed ("--mode must be auto, direct, or brokered (got '" + $Mode + "').")
}
if ($Mode -eq 'auto') {
    Say 'ok   mode: auto (the platform default on this host; Windows defaults to direct)'
} else {
    Say ("ok   mode: " + $Mode + " (explicit; --mode brokered is how Windows is driven through the broker)")
}

# 127.0.0.1:<port> has to be free: the adapter or broker binds it and the
# Blockbench plugin dials into it. A busy port means another adapter owns the
# plugin, and this run would be measuring that one.
$PortFree = $false
$Listener = $null
try {
    $Listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
    $Listener.Start()
    $PortFree = $true
} catch {
    $PortFree = $false
} finally {
    if ($null -ne $Listener -and $PortFree) { $Listener.Stop() }
}
if (-not $PortFree) {
    Fail-Closed ("127.0.0.1:" + $Port + " is already in use. Close the other MCP adapter or broker, or rerun with --port <free-port> and point the Blockbench plugin at the same port.")
}
Say ("ok   127.0.0.1:" + $Port + " is free")

# Best effort only: the helper's own health precondition is the authoritative
# check that Blockbench is reachable, and it fails closed, so this never gates.
$BlockbenchProcess = Get-Process -Name 'Blockbench' -ErrorAction SilentlyContinue
if ($null -ne $BlockbenchProcess) {
    Say 'ok   a Blockbench process appears to be running'
} else {
    Say 'warn could not see a Blockbench process. If Blockbench is not running with the MCP plugin'
    Say '     connected, the run will stop with INCONCLUSIVE rather than pretending to pass.'
}

if (-not (Test-Path -LiteralPath $OutParent)) { New-Item -ItemType Directory -Path $OutParent -Force | Out-Null }
Say ("ok   receipts directory: " + $OutParent)

Say ''
Say '--- What you will have to do ---'
Say ''
Say 'This smoke needs a human twice. Read this before it starts, because it will'
Say 'stop and wait for you.'
Say ''
Say '  Phase 1  establish     You confirm a scoped directory in Blockbench.'
Say '                         Accept the MCP plugin dialog, and any native Blockbench'
Say '                         permission dialog that follows.'
Say '  Phase 2  disrupt       Nothing to do. The helper crashes the broker (brokered'
Say '                         mode) or restarts the adapter (direct mode) and waits'
Say '                         for the plugin to reconnect. This can take up to about'
Say '                         30 seconds.'
Say '                         DO NOT reload the plugin, restart Blockbench, or revoke'
Say '                         the directory by hand at any point. Doing so makes the'
Say '                         scenario undriveable and the verdict INCONCLUSIVE.'
Say '  Phase 3  assert        Nothing to do. A second client tries the same scoped'
Say '                         read without a fresh confirmation. It must be denied.'
Say '  Phase 4  re-establish  You confirm the same directory a second time.'
Say ''
Say 'Each confirmation has about a two-minute budget once the dialog appears.'
Say ''
Read-Host -Prompt 'Press Enter to start the run, or Ctrl-C to abort' | Out-Null

Say ''
Say '--- Running ---'
& node $Helper @Forward
$Status = $LASTEXITCODE

$ReceiptDir = $null
if (Test-Path -LiteralPath $OutParent) {
    $Candidate = Get-ChildItem -LiteralPath $OutParent -Directory -Filter 'ac21-scope-isolation-smoke-*' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($null -ne $Candidate) { $ReceiptDir = $Candidate.FullName }
}

Say ''
Say '--- Result ---'
if ($Status -eq 0) {
    Say 'VERDICT: PASS         the AC-21 invariant held on this host, in the mode the receipt records.'
} elseif ($Status -eq 1) {
    Say "VERDICT: FAIL         the second client used the first client's scoped directory. Keep the receipt."
} elseif ($Status -eq 2) {
    Say 'VERDICT: INCONCLUSIVE the scenario could not be driven. This is NOT a pass; see verdict_reason.'
} else {
    Say ("VERDICT: INCONCLUSIVE the helper exited with an unexpected status " + $Status + ". Treat as not run.")
}

if ($null -ne $ReceiptDir) {
    Say ''
    Say ("Receipt:   " + (Join-Path $ReceiptDir 'smoke-report.json'))
    Say ("Checklist: " + (Join-Path $ReceiptDir 'operator-checklist.md'))
    Say ''
    Say 'Send both files back. The receipt carries no secret and no absolute home path.'
} else {
    Say ''
    Say ("No receipt directory was found under " + $OutParent + ".")
}

exit $Status
