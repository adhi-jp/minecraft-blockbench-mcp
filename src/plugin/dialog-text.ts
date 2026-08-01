// Pure dialog text sanitization for the browser-targeted plugin. This module
// avoids Node builtins and Blockbench globals so it compiles for the plugin.

export const SCOPE_REASON_MAX_LENGTH = 300;

const CONTROL_OR_WHITESPACE_RE = /[\u0000-\u001F\u0080-\u009F\s]+/g;

export function sanitizeDialogText(input: string, maxLength: number): string {
  const collapsed = input.replace(CONTROL_OR_WHITESPACE_RE, ' ').trim();
  const escaped = collapsed
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
  return escaped.length > maxLength ? `${escaped.slice(0, maxLength)}…` : escaped;
}
