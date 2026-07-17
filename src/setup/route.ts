// Subcommand routing for dist/adapter/cli.js. Dependency-free on purpose: the
// server entry consults it on every start, so a failure anywhere in the setup
// machinery must not be able to break bare MCP startup.
export type Subcommand = 'setup' | 'doctor';

/** Only the exact strings `setup`/`doctor` at argv[2] dispatch; anything else
 * (flags, model paths, flag-then-positional shapes) keeps starting the server. */
export function routeCli(argv2: string | undefined): Subcommand | null {
  return argv2 === 'setup' || argv2 === 'doctor' ? argv2 : null;
}
