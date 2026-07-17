// Shared per-user config file location. Pure string logic with injected
// inputs and platform-faithful separators: this module is bundled into the
// browser-platform Blockbench plugin, so it must not import node builtins,
// and expected outputs must not depend on the host that runs the tests.
export const CONFIG_DIR_NAME = 'minecraft-blockbench-mcp';
export const CONFIG_FILE_NAME = 'config.json';

export interface ConfigPathInputs {
  platform: string;
  /** POSIX: $XDG_CONFIG_HOME override. */
  xdgConfigHome?: string | undefined;
  /** POSIX home directory. */
  home?: string | undefined;
  /** Windows %APPDATA%. */
  appData?: string | undefined;
  /** Windows %USERPROFILE%. */
  userProfile?: string | undefined;
}

function joinWith(separator: string, ...parts: string[]): string {
  return parts
    .map((part, index) => (index === 0 ? part.replace(/[\\/]+$/, '') : part.replace(/^[\\/]+|[\\/]+$/g, '')))
    .join(separator);
}

/**
 * Resolves the per-user config file path from environment-shaped inputs, or
 * null when no base directory is derivable. Windows paths use backslashes,
 * POSIX paths use slashes, regardless of the host running this code.
 */
export function resolveDefaultConfigPath(inputs: ConfigPathInputs): string | null {
  if (inputs.platform === 'win32') {
    const appData =
      inputs.appData !== undefined && inputs.appData !== ''
        ? inputs.appData
        : inputs.userProfile !== undefined && inputs.userProfile !== ''
          ? joinWith('\\', inputs.userProfile, 'AppData', 'Roaming')
          : null;
    return appData === null ? null : joinWith('\\', appData, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
  }
  if (inputs.platform === 'darwin') {
    if (inputs.home === undefined || inputs.home === '') return null;
    return joinWith('/', inputs.home, 'Library', 'Application Support', CONFIG_DIR_NAME, CONFIG_FILE_NAME);
  }
  const configHome =
    inputs.xdgConfigHome !== undefined && inputs.xdgConfigHome !== ''
      ? inputs.xdgConfigHome
      : inputs.home !== undefined && inputs.home !== ''
        ? joinWith('/', inputs.home, '.config')
        : null;
  return configHome === null ? null : joinWith('/', configHome, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

/** Returns the parent directory of a path, preserving its separator style. */
export function parentDirectory(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (cut < 0) return trimmed;
  // A path directly under the root keeps the root itself as its parent.
  if (cut === 0) return trimmed.slice(0, 1);
  return trimmed.slice(0, cut);
}

/**
 * Plugin-side derivation: Electron's userData directory lives directly inside
 * the platform config base (honoring XDG_CONFIG_HOME on Linux, %APPDATA% on
 * Windows, ~/Library/Application Support on macOS), so the config base is its
 * parent. A Blockbench launched with --userData resolves relative to that
 * custom profile instead — by design, which keeps disposable-profile
 * verification self-contained.
 */
export function defaultConfigPathFromUserData(userDataDirectory: string): string {
  const base = parentDirectory(userDataDirectory);
  const separator = base.includes('\\') ? '\\' : '/';
  return joinWith(separator, base, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}
