// The demo's help app depends on `aida-docs`, but `aida init`'s template names it
// `file:../engine`, which only resolves inside the AIDA repo, and the demo skips the engine pack
// `aida init` would point it at (nothing needs the help app's packages until --site). So the demo
// points it at an engine that installs from the demo folder: the running engine's own version
// from the registry, or, run from a source checkout, the checkout itself.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ENGINE_ROOT } from "../package-root.js";
import { setAidaDependency } from "../init/install.js";

/** The `aida-docs` spec for the demo's help app. An engine inside a `node_modules` folder was
 * installed from the registry: its exact version. Anywhere else it's a checkout: `file:` to it. */
export function demoAidaSpec(engineRoot: string = ENGINE_ROOT): string {
  if (/[\\/]node_modules[\\/]/.test(engineRoot)) {
    const version = (JSON.parse(readFileSync(join(engineRoot, "package.json"), "utf8")) as { version?: string }).version;
    if (version) return version;
  }
  return `file:${engineRoot}`;
}

/** True for a `file:` spec whose target isn't there (the template's `file:../engine`). */
function brokenFileSpec(spec: string, helpDir: string): boolean {
  if (!spec.startsWith("file:")) return false;
  const target = spec.slice("file:".length);
  return !existsSync(isAbsolute(target) ? target : resolve(helpDir, target));
}

/**
 * Points the help app's `aida-docs` at `spec` when it's missing or a `file:` path that isn't
 * there. A spec that installs (the engine `--site` packs into help/vendor, or one the person set)
 * is left as it is. True when package.json changed.
 */
export function fixDemoAidaDependency(helpDir: string, spec: string = demoAidaSpec()): boolean {
  const pkg = JSON.parse(readFileSync(join(helpDir, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  const current = pkg.dependencies?.["aida-docs"];
  if (current !== undefined && !brokenFileSpec(current, helpDir)) return false;
  return setAidaDependency(helpDir, spec);
}
