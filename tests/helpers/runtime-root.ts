// A runtime root short enough that the endpoint the adapter derives inside it
// still fits in a UNIX socket path.
//
// `resolveRuntimeDirectory` + `ipcEndpointFor` turn `XDG_RUNTIME_DIR` into
// `<XDG_RUNTIME_DIR>/minecraft-blockbench-mcp/broker-<16 hex>.sock`, a fixed
// 54-character tail no test can shorten. macOS allows 103 usable characters in
// a `sun_path` (104 with the NUL), and the GitHub `macos-latest` runner's
// `os.tmpdir()` is already 48 of them:
//
//   /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T
//
// `mkdtemp` adds 6 more, so even a zero-length prefix with no extra segment
// lands at 48 + 1 + 6 + 54 = 109. Every runtime root taken from `os.tmpdir()`
// on macOS overflows before its prefix is counted, which is why shortening
// prefixes cannot fix this and the root has to leave `os.tmpdir()` entirely.
//
// The overflow is silent. On the macOS runner `net.Server.listen()` on a
// 143-character path resolved successfully and a later `stat()` of that path
// returned ENOENT: no bind error, just an endpoint that was never there. The
// guard in `createRuntimeRoot` is what turns that silence back into a failure.
//
// On POSIX the parent is `/tmp`, which puts a runtime root at 16-18 characters
// and the endpoint under 75. (`/tmp` is a symlink to `/private/tmp` on macOS,
// but the length that matters is the string handed to `bind()`, and that string
// is the `/tmp/...` one.) On win32 the endpoint is a named pipe in the `\\.\pipe`
// namespace, where the runtime directory contributes nothing to it and path
// length is irrelevant, so `os.tmpdir()` stays.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_UNIX_SOCKET_PATH_LENGTH } from '../../src/adapter/broker/endpoint.js';

/** `sun_path` holds 104 bytes including the terminating NUL. */
export { MAX_UNIX_SOCKET_PATH_LENGTH };

/**
 * The length of `/minecraft-blockbench-mcp/broker-<16 hex>.sock`, the tail the
 * adapter appends to `XDG_RUNTIME_DIR` to reach its POSIX endpoint.
 */
export const BROKER_ENDPOINT_TAIL_LENGTH = 54;

/**
 * How long the socket a broker binds under `runtimeRoot` will be. Only
 * meaningful on POSIX; a win32 endpoint does not live under the runtime root.
 */
export function brokerEndpointLength(runtimeRoot: string): number {
  return runtimeRoot.length + BROKER_ENDPOINT_TAIL_LENGTH;
}

/** Where runtime roots are created: short on POSIX, `os.tmpdir()` on win32. */
export function runtimeRootParent(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? tmpdir() : '/tmp';
}

/**
 * A fresh, unique, empty runtime root for one test world, to be handed to a
 * child as `XDG_RUNTIME_DIR`. `prefix` only has to keep leaked directories
 * identifiable; keep it short, since every character of it is a character the
 * socket path cannot use.
 *
 * The caller owns the directory and must pass it to `removeRuntimeRoot`. It
 * deliberately sits outside the test's own `mkdtemp` world, so removing that
 * world does not remove this.
 */
export async function createRuntimeRoot(prefix: string): Promise<string> {
  const runtimeRoot = await mkdtemp(join(runtimeRootParent(), prefix));
  if (process.platform !== 'win32') {
    const length = brokerEndpointLength(runtimeRoot);
    if (length > MAX_UNIX_SOCKET_PATH_LENGTH) {
      await rm(runtimeRoot, { recursive: true, force: true });
      throw new Error(
        `A broker endpoint under ${runtimeRoot} would be ${String(length)} characters, over the ` +
          `${String(MAX_UNIX_SOCKET_PATH_LENGTH)} a unix socket path allows. Binding it can succeed and still ` +
          'leave no endpoint behind, so this refuses to hand out a root that would fail that way.',
      );
    }
  }
  return runtimeRoot;
}

/** Remove a runtime root created by `createRuntimeRoot`. Never throws for an absent one. */
export async function removeRuntimeRoot(runtimeRoot: string): Promise<void> {
  await rm(runtimeRoot, { recursive: true, force: true });
}
