// How the Studio tells people to run aida: its CLI from the aida checkout, as the README's
// "Run aida" says. Never `npx aida`: the help app's engine tarball has no `bin`, so npx would
// fetch the unrelated npm package called "aida" (decisions #29); the engine's own package,
// `aida-docs`, isn't published yet. The Studio can't know where the
// checkout is, hence the <aida> placeholder.
export const AIDA_CLI = "node <aida>/packages/engine/dist/cli.js";

/** e.g. "node <aida>/packages/engine/dist/cli.js build". */
export function aidaCli(args: string): string {
  return `${AIDA_CLI} ${args}`;
}
