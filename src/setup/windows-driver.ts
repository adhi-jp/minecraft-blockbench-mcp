// Windows-side CDP driver for the Windows-from-WSL full-auto path. The
// PowerShell script text is a constant: ports, modes, and timeouts arrive as
// arguments and the payload expression arrives on stdin, so no runtime data —
// and never the secret — is interpolated into code.
export const WINDOWS_DRIVER_SCRIPT = `param([int]$Port, [string]$Mode, [int]$TimeoutSec = 60)
$ErrorActionPreference = 'Stop'
function Get-Body($url) { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 $url).Content }
function Out-Result($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4)) }
try {
  if ($Mode -eq 'version') {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ($true) {
      try { $v = Get-Body "http://127.0.0.1:$Port/json/version"; break }
      catch {
        if ((Get-Date) -gt $deadline) { throw 'cdp-timeout' }
        Start-Sleep -Milliseconds 500
      }
    }
    Out-Result @{ ok = $true; versionBody = $v }
    exit 0
  }
  [Console]::InputEncoding = [System.Text.Encoding]::UTF8
  $payload = [Console]::In.ReadToEnd()
  $list = Get-Body "http://127.0.0.1:$Port/json/list" | ConvertFrom-Json
  $page = $list | Where-Object { $_.type -eq 'page' -and $_.webSocketDebuggerUrl } | Select-Object -First 1
  if (-not $page) { throw 'no-page-target' }
  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  $ct = [System.Threading.CancellationToken]::None
  $ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, $ct).Wait()
  $msg = @{ id = 1; method = 'Runtime.evaluate'; params = @{ expression = $payload; awaitPromise = $true; returnByValue = $true } } | ConvertTo-Json -Compress -Depth 6
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($msg)
  $ws.SendAsync([System.ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).Wait()
  $buffer = New-Object byte[] 262144
  $deadline = (Get-Date).AddSeconds([Math]::Max($TimeoutSec, 150))
  while ($true) {
    if ((Get-Date) -gt $deadline) { throw 'evaluate-timeout' }
    $sb = New-Object System.Text.StringBuilder
    do {
      $seg = [System.ArraySegment[byte]]::new($buffer)
      $res = $ws.ReceiveAsync($seg, $ct).Result
      [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buffer, 0, $res.Count))
    } until ($res.EndOfMessage)
    $text = $sb.ToString()
    if ($text -match '"id"\\s*:\\s*1') {
      Out-Result @{ ok = $true; response = $text }
      exit 0
    }
  }
} catch {
  Out-Result @{ ok = $false; error = $_.Exception.Message }
  exit 1
}
`;

export interface WindowsDriverResult {
  ok: boolean;
  versionBody?: string;
  response?: string;
  error?: string;
}

/** Parses the single JSON line the driver writes to stdout. */
export function parseDriverOutput(stdout: string): WindowsDriverResult {
  const line = stdout
    .split('\n')
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.startsWith('{'))
    .pop();
  if (line === undefined) return { ok: false, error: `driver produced no result line: ${stdout.slice(0, 200)}` };
  try {
    return JSON.parse(line) as WindowsDriverResult;
  } catch {
    return { ok: false, error: `driver output was not JSON: ${line.slice(0, 200)}` };
  }
}

/** Extracts the evaluated Runtime.evaluate value from the driver's raw CDP response. */
export function extractEvaluateValue(response: string): unknown {
  const parsed = JSON.parse(response) as { result?: { result?: { value?: unknown } }; error?: { message?: string } };
  if (parsed.error !== undefined) throw new Error(parsed.error.message ?? 'CDP error');
  return parsed.result?.result?.value;
}
