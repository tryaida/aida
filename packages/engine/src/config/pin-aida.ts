// Pins `import ... from "aida-docs"` (and `aida-docs/...` subpaths) in a config, adapter or state
// hook to the engine that is running, never to whatever `node_modules/aida-docs` next to the config
// holds. The engine isn't on the npm registry yet, and the old package name `aida` there belongs
// to an unrelated package (decisions #29). In CI the config is loaded while GITHUB_TOKEN is set:
// resolving a hoisted or freshly installed impostor there would run someone else's code with the
// workflow's token. So `aida` and `aida/...` (the engine's name before the rename) are refused
// with a message rather than resolved. Pinning also means the CLI loads a config without the help
// app's `npm install`.
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
import { AIDA_PACKAGE, LEGACY_AIDA_PACKAGE } from "../package-name.js";

/** The running engine's package root: this file is `src/config/pin-aida.ts` under tsx and
 * vitest, `dist/config/pin-aida.js` when built. */
export const RUNNING_ENGINE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNNING_FROM_SOURCE = import.meta.url.endsWith(".ts");

/** The message for an import of the engine's old package name, which is never resolved. */
function legacyImportError(specifier: string): Error {
  return new Error(
    `"${specifier}" uses AIDA's old package name, which on npm is an unrelated package; import from "${AIDA_PACKAGE}${specifier.slice(LEGACY_AIDA_PACKAGE.length)}" instead`,
  );
}

/**
 * The file in the running engine that `specifier` names, or undefined when it isn't `aida-docs`
 * or `aida-docs/...`. From source, `aida-docs` is `src/index.ts` and `aida-docs/dist/x.js` is
 * `src/x.ts` (when it exists), so a config sees the code that's running rather than an older
 * build. Throws for `aida` and `aida/...`, the engine's old name (see the top of this file).
 */
export function runningEngineFile(specifier: string, root: string = RUNNING_ENGINE_ROOT, fromSource: boolean = RUNNING_FROM_SOURCE): string | undefined {
  if (specifier === LEGACY_AIDA_PACKAGE || specifier.startsWith(`${LEGACY_AIDA_PACKAGE}/`)) throw legacyImportError(specifier);
  if (specifier === AIDA_PACKAGE) return join(root, fromSource ? "src/index.ts" : "dist/index.js");
  if (!specifier.startsWith(`${AIDA_PACKAGE}/`)) return undefined;
  const sub = specifier.slice(`${AIDA_PACKAGE}/`.length);
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
const NAME = ${JSON.stringify(AIDA_PACKAGE)};
const OLD_NAME = ${JSON.stringify(LEGACY_AIDA_PACKAGE)};
let root, fromSource;
export function initialize(data) { root = data.root; fromSource = data.fromSource; }
export function resolve(specifier, context, next) {
  if (specifier === OLD_NAME || specifier.startsWith(OLD_NAME + "/")) {
    throw new Error('"' + specifier + '" uses AIDA\\'s old package name, which on npm is an unrelated package; import from "' + NAME + specifier.slice(OLD_NAME.length) + '" instead');
  }
  if (specifier === NAME) return next(new URL(fromSource ? "src/index.ts" : "dist/index.js", root).href, context);
  if (!specifier.startsWith(NAME + "/")) return next(specifier, context);
  const url = new URL(specifier.slice((NAME + "/").length), root);
  if (!url.href.startsWith(root)) throw new Error('"' + specifier + '" points outside the aida engine');
  const m = /^dist\\/(.+)\\.js$/.exec(url.href.slice(root.length));
  if (fromSource && m) {
    const src = new URL("src/" + m[1] + ".ts", root);
    if (existsSync(fileURLToPath(src))) return next(src.href, context);
  }
  return next(url.href, context);
}
`;
