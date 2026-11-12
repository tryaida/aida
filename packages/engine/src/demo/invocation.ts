// How to run this aida again, in every command the demo prints (fixes, next steps, refusals): the
// person may have run it through npx or from a clone, where a bare `aida` isn't on PATH.
import { join } from "node:path";
import { ENGINE_ROOT } from "../package-root.js";

/** From a clone, its CLI by path; a global install, `aida`; otherwise (npx, a project's own
 * install) `npx aida-docs`, never `npx aida`, which is an unrelated package. */
export function aidaInvocation(engineRoot: string = ENGINE_ROOT, fromSource = import.meta.url.endsWith(".ts")): string {
  if (fromSource) return `npx tsx ${shellWord(join(engineRoot, "src", "cli.ts"))}`;
  if (/[\\/]lib[\\/]node_modules[\\/]aida-docs$/.test(engineRoot) && !/[\\/]_npx[\\/]/.test(engineRoot)) return "aida";
  return "npx aida-docs";
}

/** `word` as one shell word: quoted when it has spaces or shell characters. */
export function shellWord(word: string): string {
  if (/^[\w@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}
