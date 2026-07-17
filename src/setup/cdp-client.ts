// In-process Chrome-DevTools-Protocol driver for locally reachable Blockbench
// instances (Linux and native-Windows targets). The Windows-from-WSL path uses
// the generated PowerShell driver instead, because NAT-mode WSL cannot reach a
// Windows loopback listener.
export interface CdpVersion {
  ok: boolean;
  versionBody: string;
  error?: string;
}

export interface CdpEvaluation {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Polls /json/version until the CDP endpoint answers or the deadline passes. */
export async function fetchCdpVersion(cdpPort: number, timeoutMs = 60_000): Promise<CdpVersion> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'unreachable';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) return { ok: true, versionBody: await response.text() };
      lastError = `http ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    // The timer must stay referenced: while waiting for Blockbench to open its
    // CDP port there may be no other live handle, and an unref'd timer would
    // let the process exit mid-poll.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { ok: false, versionBody: '', error: `CDP endpoint did not answer: ${lastError}` };
}

/** One connect + Runtime.evaluate attempt against the current page target. */
async function evaluateOnce(cdpPort: number, expression: string, perAttemptMs: number): Promise<CdpEvaluation> {
  let targets: Array<{ type: string; webSocketDebuggerUrl?: string }>;
  try {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(5_000) });
    targets = (await response.json()) as typeof targets;
  } catch (error) {
    return { ok: false, error: `could not list CDP targets: ${error instanceof Error ? error.message : String(error)}` };
  }
  const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl !== undefined);
  if (page === undefined) return { ok: false, error: 'no page target exposed by the CDP endpoint' };

  const socket = new WebSocket(page.webSocketDebuggerUrl!);
  try {
    await new Promise<void>((resolve, reject) => {
      const connectTimer = setTimeout(() => reject(new Error('CDP WebSocket connect timed out')), 10_000);
      socket.onopen = () => {
        clearTimeout(connectTimer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(connectTimer);
        reject(new Error('CDP WebSocket failed to connect'));
      };
    });
    return await new Promise<CdpEvaluation>((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, error: 'CDP evaluate timed out' }), perAttemptMs);
      socket.onclose = () => {
        clearTimeout(timer);
        resolve({ ok: false, error: 'CDP execution context closed (page still loading)' });
      };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as {
            id?: number;
            result?: { result?: { value?: unknown } };
            error?: { message?: string };
          };
          if (message.id !== 1) return;
          clearTimeout(timer);
          if (message.error !== undefined) {
            resolve({ ok: false, error: message.error.message ?? 'CDP error' });
          } else {
            resolve({ ok: true, result: message.result?.result?.value });
          }
        } catch {
          // Ignore unparseable frames; the id filter keeps us waiting.
        }
      };
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
  } finally {
    socket.close();
  }
}

/**
 * Runs Runtime.evaluate on the page target, retrying until the deadline. A
 * just-launched Blockbench can accept a CDP connection while its renderer is
 * still navigating; an evaluate then runs in a context that is torn down before
 * it replies. Retrying re-acquires the fresh page target once the app settles.
 */
export async function evaluateOnPage(cdpPort: number, expression: string, timeoutMs = 150_000): Promise<CdpEvaluation> {
  const deadline = Date.now() + timeoutMs;
  let last: CdpEvaluation = { ok: false, error: 'CDP evaluate never ran' };
  while (Date.now() < deadline) {
    const perAttemptMs = Math.min(30_000, Math.max(2_000, deadline - Date.now()));
    last = await evaluateOnce(cdpPort, expression, perAttemptMs);
    if (last.ok) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return last;
}
