// Shared plumbing for plugin command handlers: plugin-side re-validation,
// project/format guards, and third-party GeckoLib plugin detection.
import { z } from 'zod';

import { COMMAND_SPECS, type CommandName } from '../../shared/protocol.js';
import { CommandError, type PluginSession } from '../session.js';

type ParamsOf<K extends CommandName> = z.infer<(typeof COMMAND_SPECS)[K]['params']>;

/** Register a handler with plugin-side structural re-validation. The adapter
 * validates too, but the plugin is the trust boundary for its own state. */
export function register<K extends CommandName>(
  session: PluginSession,
  command: K,
  handler: (params: ParamsOf<K>) => Promise<unknown> | unknown,
): void {
  session.registerHandler(command, (rawParams) => {
    const parsed = COMMAND_SPECS[command].params.safeParse(rawParams ?? {});
    if (!parsed.success) {
      throw new CommandError('E_INVALID_PARAMS', 'Parameters failed plugin-side validation.', parsed.error.issues);
    }
    return handler(parsed.data as ParamsOf<K>);
  });
}

export function requireProject(hint = 'Use create_project or open_model first.'): void {
  if (!Project) {
    throw new CommandError('E_NOT_FOUND', `No project is open. ${hint}`);
  }
}

/** Project tabs that MCP create/open commands made during this plugin load.
 * close_project closes these without a save prompt; the user's own tabs are
 * never in the set. A WeakSet lets closed projects be collected. */
const mcpProjects = new WeakSet<object>();

/** Record the active project as one MCP created or opened. */
export function trackMcpProject(): void {
  if (Project) mcpProjects.add(Project);
}

export function isMcpProject(project: object): boolean {
  return mcpProjects.has(project);
}

export function projectCounts(): { cubes: number; groups: number; textures: number } {
  return { cubes: Cube.all.length, groups: Group.all.length, textures: Texture.all.length };
}

/** True when the third-party GeckoLib plugin's format is registered right now.
 * Checked per call (never cached from the handshake) because the GeckoLib
 * plugin can be installed, loaded, or disabled independently of this one. */
export function geckolibFormatRegistered(): boolean {
  const formats = (globalThis as Record<string, unknown>).Formats as Record<string, unknown> | undefined;
  return formats !== undefined && formats.geckolib_model !== undefined;
}

/** Version of the installed GeckoLib plugin, when detectable. */
export function detectGeckolibPluginVersion(): string | undefined {
  const plugins = (globalThis as Record<string, unknown>).Plugins as
    | { all?: Array<{ id?: string; version?: string; installed?: boolean }> }
    | undefined;
  const entry = plugins?.all?.find((candidate) => candidate.id === 'geckolib' && candidate.installed === true);
  return typeof entry?.version === 'string' ? entry.version : undefined;
}

export function requireGeckolibPlugin(): void {
  if (!geckolibFormatRegistered()) {
    throw new CommandError(
      'E_PLUGIN_DEPENDENCY_MISSING',
      'The GeckoLib Blockbench plugin is not installed or not loaded, so the geckolib_model format is unavailable.',
      {
        plugin_id: 'geckolib',
        remediation:
          'Install "GeckoLib Models & Animations" once via File > Plugins > Available in Blockbench, then retry.',
      },
    );
  }
}

export function requireGeckolibFormat(): void {
  requireProject('Use create_geckolib_project or open_geckolib_model first.');
  if (Format?.id !== 'geckolib_model') {
    throw new CommandError(
      'E_FORMAT_UNSUPPORTED',
      `The current project format is "${Format?.id ?? 'unknown'}"; this command needs the geckolib_model format.`,
    );
  }
}

/** Upper bound for the post-open texture reload wait, shared by all textures
 * of one open. Local files normally settle in milliseconds. */
export const TEXTURE_SETTLE_TIMEOUT_MS = 5_000;

export interface OpenedTextureReport {
  id: string;
  name: string;
  path: string | null;
  error?: string;
}

/** The texture surface the reload relies on (Blockbench 5.1.4 Texture). */
interface ReloadableTexture {
  id?: unknown;
  name?: unknown;
  path?: unknown;
  internal?: boolean;
  error?: unknown;
  img: {
    addEventListener(type: 'load' | 'error', listener: () => void): void;
    removeEventListener(type: 'load' | 'error', listener: () => void): void;
  };
  reloadTexture(): void;
}

type SettleOutcome = 'load' | 'error' | 'timed out';

/**
 * Reload every file-linked texture of the current project from disk and wait
 * until each one's image fired its first `load` or `error` event, or until the
 * shared timeout passes. Blockbench caches a linked texture's image URL per
 * path until its version counter changes, so a texture rewritten between two
 * opens would otherwise show the old bytes; `reloadTexture()` bumps that
 * counter. The first event itself is the outcome: Blockbench's own error
 * handler may start a fallback load that resets `texture.error`. Listeners
 * are added before the reload and never replace the texture's own
 * `onload`/`onerror` handlers. Internal (embedded) textures and textures
 * without a path are reported without reloading, and an internal texture
 * reports no path because its pixels do not come from one.
 */
export async function reloadProjectTextures(
  timeoutMs: number = TEXTURE_SETTLE_TIMEOUT_MS,
): Promise<OpenedTextureReport[]> {
  const textures = Texture.all as unknown as ReloadableTexture[];
  const reloadable = textures.filter(
    (texture) => texture.internal !== true && typeof texture.path === 'string' && texture.path !== '',
  );
  const unsettled = new Set<ReloadableTexture>(reloadable);
  const listeners = new Map<ReloadableTexture, { load: () => void; error: () => void }>();
  const outcomes = new Map<ReloadableTexture, SettleOutcome>();
  let resolveAll: () => void = () => {};
  const allSettled = new Promise<void>((resolve) => {
    resolveAll = resolve;
  });

  const settle = (texture: ReloadableTexture, outcome: SettleOutcome): void => {
    if (!unsettled.has(texture)) return;
    unsettled.delete(texture);
    outcomes.set(texture, outcome);
    const own = listeners.get(texture);
    if (own !== undefined) {
      texture.img.removeEventListener('load', own.load);
      texture.img.removeEventListener('error', own.error);
    }
    if (unsettled.size === 0) resolveAll();
  };

  if (reloadable.length > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      for (const texture of reloadable) {
        const own = { load: () => settle(texture, 'load'), error: () => settle(texture, 'error') };
        listeners.set(texture, own);
        texture.img.addEventListener('load', own.load);
        texture.img.addEventListener('error', own.error);
        texture.reloadTexture();
      }
      await Promise.race([
        allSettled,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      for (const texture of [...unsettled]) settle(texture, 'timed out');
    }
  }

  return textures.map((texture) => {
    const report: OpenedTextureReport = {
      id: String(texture.id ?? ''),
      name: String(texture.name ?? ''),
      path:
        texture.internal !== true && typeof texture.path === 'string' && texture.path !== '' ? texture.path : null,
    };
    const outcome = outcomes.get(texture);
    if (outcome === 'timed out') {
      report.error = 'timed out';
    } else if (outcome === 'error' || (outcome === undefined && texture.error)) {
      report.error = 'failed to load';
    }
    return report;
  });
}
