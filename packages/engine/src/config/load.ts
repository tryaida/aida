import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Script, constants } from "node:vm";
import type {
  DatabaseAdapter,
  DatabaseAdapterRef,
  AidaConfig,
  ResolvedConfig,
  SignInAdapter,
  SignInAdapterRef,
} from "./types.js";
import { resolveCaptureSettings } from "./types.js";
import { resolveStates } from "../states/hooks.js";
import { pinAidaToRunningEngine, runningEngineFile } from "./pin-aida.js";

let tsxRegistered = false;

/**
 * True when this process's own ESM loader chain already includes tsx — i.e. we were started as
 * `tsx <script>` / `npx tsx <script>` (tsx's CLI adds `--import tsx/dist/loader.mjs` to
 * `process.execArgv`). In that case tsx already intercepts `.ts` imports, so a `.ts` config file
 * can just be imported directly; registering tsx *again* (via `node:module`'s `register`, which
 * needs `--import`, or otherwise) throws "tsx must be loaded with --import instead of --loader"
 * because tsx's own loader is already active as a `--loader`-style hook from inside the running
 * process, not from a fresh `--import` flag.
 */
export function runningUnderTsx(): boolean {
  if (typeof process === "undefined") return false;
  // tsx's own CLI (and `npx tsx <script>`) launches Node with its ESM loader pre-registered via
  // `--import tsx/dist/loader.mjs` in process.execArgv. No env var or globalThis marker is set —
  // this is the one reliable signal.
  return process.execArgv.some((arg) => /tsx[\\/]dist[\\/]loader\.mjs/.test(arg));
}

/**
 * Registers tsx's ESM loader (once) if `file` needs it and it isn't already active — shared by
 * the config-file import below and `importAdapter()`, so a `.ts`/`.mts`/`.cts` *adapter*
 * referenced by an otherwise-plain `.mjs` config also gets tsx support. Before this, adapters
 * were imported with a plain dynamic `import()` regardless of the main config's extension, so
 * `node dist/cli.js inspect|capture` against a `.mjs` config whose `signIn`/`database` adapter is
 * a `.ts` file failed with `ERR_UNKNOWN_FILE_EXTENSION ".ts"` the moment the adapter resolved —
 * only a `.ts` *config* ever got tsx registered (build-plan.md M14 log).
 */
export async function ensureTsxForFile(file: string): Promise<void> {
  if (!/\.(ts|mts|cts)$/.test(file)) return;
  if (tsxRegistered || runningUnderTsx()) return;
  const { register } = await import("tsx/esm/api");
  register();
  tsxRegistered = true;
}

/**
 * Makes `aida` in a config, adapter or state hook resolve to this running engine, never to a
 * `node_modules/aida` next to the config (see pin-aida.ts). From source that's
 * `src/index.ts`, so tsx is registered too when this process isn't already running under it.
 */
async function pinConfigImports(): Promise<void> {
  pinAidaToRunningEngine();
  await ensureTsxForFile(runningEngineFile("aida")!);
}

/**
 * Node's own `import()`, so a config or adapter always goes through Node's resolver and the hook
 * above. Under vitest a plain `import()` in this file is rewritten to Vite's module runner, which
 * resolves bare names itself from node_modules (and so found the impostor), and `new Function`
 * has no import callback there; a vm script with Node's default loader does. Only under vitest:
 * that vm option prints an experimental-feature warning.
 */
let vmImport: ((specifier: string) => Promise<unknown>) | undefined;
function nativeImport(specifier: string): Promise<unknown> {
  if (!process.env.VITEST) return import(specifier);
  vmImport ??= new Script("(specifier) => import(specifier)", {
    importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  }).runInThisContext() as (specifier: string) => Promise<unknown>;
  return vmImport(specifier);
}

/**
 * Imports an `aida.config.ts`/`.mjs`/`.js` file and resolves it into a
 * `ResolvedConfig`: adapters loaded, paths made absolute. `.mjs`/`.js` use a plain dynamic
 * `import()`. `.ts` either imports directly (when tsx's own loader is already active in this
 * process — see `runningUnderTsx`) or registers tsx via its supported `tsx/esm/api` `register()`
 * function (not `node:module`'s `register`, which requires tsx to have been loaded with
 * `--import` from the start — see the error above).
 */
export async function loadConfig(configPath: string): Promise<ResolvedConfig> {
  const file = resolve(configPath);
  if (!existsSync(file)) {
    throw new Error(`no config file at ${file}`);
  }
  await pinConfigImports();
  await ensureTsxForFile(file);

  const mod = (await nativeImport(`${pathToFileURL(file).href}?t=${Date.now()}`)) as {
    default?: AidaConfig | { __esModule: true; default: AidaConfig };
    config?: AidaConfig;
  };
  let raw: unknown = mod.default ?? mod.config;
  // tsx's own CJS/ESM interop can double-wrap a `.ts` config's default export as
  // `{ __esModule: true, default: {...} }` when the config file isn't inside a package that
  // declares `"type": "module"` (tsx then compiles it to CJS, and Node's loader re-wraps it as
  // an ESM default) — seen via the `tsx/esm/api` register() path above, not the direct-tsx path.
  // Unwrap once more in that case.
  if (raw && typeof raw === "object" && (raw as { __esModule?: boolean }).__esModule === true && "default" in raw) {
    raw = (raw as { default: unknown }).default;
  }
  const config = raw as AidaConfig | undefined;
  if (!config) {
    throw new Error(`${file} has no default export (use defineConfig({...}) and export default)`);
  }

  const configDir = dirname(file);
  return resolveConfig(config, configDir);
}

async function resolveConfig(config: AidaConfig, configDir: string): Promise<ResolvedConfig> {
  if (!config.app?.baseUrl) throw new Error("config.app.baseUrl is required");
  if (!config.walkthroughsDir) throw new Error("config.walkthroughsDir is required");

  const signIn = config.signIn ? await resolveSignIn(config.signIn, configDir) : undefined;
  const database = config.database ? await resolveDatabase(config.database, configDir) : undefined;
  // Hook module paths are checked to exist here but imported lazily, at the hook's first run
  // (states/hooks.ts): loading a config for `order`/`validate` never runs a hook module's code.
  const states = config.states ? await resolveStates(config.states, configDir) : undefined;

  return {
    ...config,
    configDir,
    app: config.app.dir ? { ...config.app, dir: absolute(configDir, config.app.dir) } : config.app,
    walkthroughsDir: absolute(configDir, config.walkthroughsDir),
    outDir: absolute(configDir, config.outDir ?? "help"),
    buildDir: absolute(configDir, config.buildDir ?? ".build"),
    helpApp: config.helpApp ? absolute(configDir, config.helpApp) : undefined,
    capture: resolveCaptureSettings(config.capture),
    impact: config.impact
      ? {
          ...config.impact,
          appRepo: config.impact.appRepo ? absolute(configDir, config.impact.appRepo) : undefined,
        }
      : undefined,
    signIn,
    database,
    states,
  };
}

function absolute(configDir: string, p: string): string {
  return isAbsolute(p) ? p : join(configDir, p);
}

async function resolveSignIn(ref: SignInAdapterRef, configDir: string): Promise<SignInAdapter> {
  if (typeof ref === "function") return ref;
  if (typeof ref === "string") return importAdapter<SignInAdapter>(ref, configDir, undefined);
  return importAdapter<SignInAdapter>(ref.modulePath, configDir, ref.export);
}

async function resolveDatabase(ref: DatabaseAdapterRef, configDir: string): Promise<DatabaseAdapter> {
  if (typeof ref === "string") return importAdapter<DatabaseAdapter>(ref, configDir, undefined);
  if ("modulePath" in ref) return importAdapter<DatabaseAdapter>(ref.modulePath, configDir, ref.export);
  return ref;
}

async function importAdapter<T>(modulePath: string, configDir: string, exportName: string | undefined): Promise<T> {
  const file = isAbsolute(modulePath) ? modulePath : join(configDir, modulePath);
  await ensureTsxForFile(file);
  // A bare `.ts`/`.mts`/`.cts` adapter path, imported right after tsx's loader was registered at
  // runtime via `ensureTsxForFile()` above (rather than tsx's own `--import`-started loader, the
  // `runningUnderTsx()` case), can mis-detect the file's module format on its first-ever import
  // and throw Node's `ERR_REQUIRE_CYCLE_MODULE` — the same cache-busting query `loadConfig()`
  // already puts on a `.ts` config's own import avoids it here too.
  const needsCacheBust = /\.(ts|mts|cts)$/.test(file) && !runningUnderTsx();
  const href = pathToFileURL(file).href + (needsCacheBust ? `?t=${Date.now()}` : "");
  await pinConfigImports();
  const mod = (await nativeImport(href)) as Record<string, unknown>;
  let value = exportName ? mod[exportName] : (mod.default ?? mod.signIn ?? mod.database ?? mod.adapter);
  // Mirror loadConfig()'s own unwrap: tsx's runtime-registered loader can double-wrap a `.ts`
  // adapter's default export the same way it does a `.ts` config's (see the comment on
  // `loadConfig` above) when the adapter file isn't inside a package declaring `"type":
  // "module"`.
  if (value && typeof value === "object" && (value as { __esModule?: boolean }).__esModule === true && "default" in value) {
    value = (value as { default: unknown }).default;
  }
  if (!value) {
    throw new Error(`${file} has no usable export (expected a default export or a named adapter export)`);
  }
  return value as T;
}
