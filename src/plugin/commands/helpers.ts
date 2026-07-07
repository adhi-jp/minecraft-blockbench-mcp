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
