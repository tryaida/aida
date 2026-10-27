// Pins `import ... from "aida"` (and `aida/...` subpaths) in a config, adapter or state hook
// to the engine that is running, never to whatever `node_modules/aida` next to the config holds.
// The name `aida` on the npm registry belongs to an unrelated package (decisions #29), and in CI
// the config is loaded while GITHUB_TOKEN is set: resolving a hoisted or freshly installed
// impostor there would run someone else's code with the workflow's token. Pinning also means the
// CLI loads a config without the help app's `npm install`.
//
// The hook is registered once per process, before the first config import. `module.registerHooks`
// (Node 22.15+) runs in-thread and covers both `import` and `require()`; the require path matters
// because tsx compiles a `.ts` config to CommonJS when its folder has no `"type": "module"` (the
// help app's), and under the tsx CLI that require never reaches `module.register` hooks. Older Node
// gets `module.register` for imports plus a `Module._resolveFilename` wrapper for require().
import { existsSync } from "node:fs";
import module from "node:module";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The running engine's package root: this file is `src/config/pin-aida.ts` under tsx and
 * vitest, `dist/config/pin-aida.js` when built. */
export const RUNNING_ENGINE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNNING_FROM_SOURCE = import.meta.url.endsWith(".ts");

/**
 * The file in the running engine that `specifier` names, or undefined when it isn't `aida` or
 * `aida/...`. From source, `aida` is `src/index.ts` and `aida/dist/x.js` is `src/x.ts` (when
 * it exists), so a config sees the code that's running rather than an older build.
 */
export function runningEngineFile(specifier: string, root: string = RUNNING_ENGINE_ROOT, fromSource: boolean = RUNNING_FROM_SOURCE): string | undefined {
  if (specifier === "aida") return join(root, fromSource ? "src/index.ts" : "dist/index.js");
  if (!specifier.startsWith("aida/")) return undefined;
  const sub = specifier.slice("aida/".length);
  const file = join(root, sub);
  const rel = relative(root, file);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`"${specifier}" points outside the aida engine`);
  if (fromSource) {
    const m = /^dist\/(.+)\.js$/.exec(rel.split("\\").join("/"));
    const src = m ? join(root, "src", `${m[1]}.ts`) : undefined;
    if (src && existsSync(src)) return src;
  }
  return file;
}

let pinned = false;

type ResolveFn = (specifier: string, context: unknown) => unknown;
interface ModuleWithHooks {
  registerHooks?: (hooks: { resolve: (specifier: string, context: unknown, next: ResolveFn) => unknown }) => unknown;
  register?: (specifier: string, options: { data: unknown }) => void;
}

/** Registers the resolve hook once. Returns how it was pinned (for tests). */
export function pinAidaToRunningEngine(opts: { legacy?: boolean } = {}): "hooks" | "register" | "already" {
  if (pinned) return "already";
  pinned = true;
  const mod = module as unknown as ModuleWithHooks;
  if (mod.registerHooks && !opts.legacy) {
    mod.registerHooks({
      resolve(specifier, context, next) {
        const file = runningEngineFile(specifier);
        return next(file ? pathToFileURL(file).href : specifier, context);
      },
    });
    return "hooks";
  }
  // Older Node: an off-thread import hook (the mapping is precomputed, since the hook thread can't
  // load this TypeScript module) plus a require() wrapper.
  mod.register?.(`data:text/javascript,${encodeURIComponent(LEGACY_HOOK)}`, {
    data: { root: pathToFileURL(RUNNING_ENGINE_ROOT + "/").href, fromSource: RUNNING_FROM_SOURCE },
  });
  const Module = module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const original = Module._resolveFilename;
  Module._resolveFilename = function (request: string, ...rest: unknown[]) {
    return original.call(this, runningEngineFile(request) ?? request, ...rest);
  };
  return "register";
}

const LEGACY_HOOK = `
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
let root, fromSource;
export function initialize(data) { root = data.root; fromSource = data.fromSource; }
export function resolve(specifier, context, next) {
  if (specifier === "aida") return next(new URL(fromSource ? "src/index.ts" : "dist/index.js", root).href, context);
  if (!specifier.startsWith("aida/")) return next(specifier, context);
  const url = new URL(specifier.slice("aida/".length), root);
  if (!url.href.startsWith(root)) throw new Error('"' + specifier + '" points outside the aida engine');
  const m = /^dist\\/(.+)\\.js$/.exec(url.href.slice(root.length));
  if (fromSource && m) {
    const src = new URL("src/" + m[1] + ".ts", root);
    if (existsSync(fileURLToPath(src))) return next(src.href, context);
  }
  return next(url.href, context);
}
`;
