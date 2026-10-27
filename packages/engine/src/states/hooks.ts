// Loads config `states` (decision 28): checks each name is kebab-case and turns every hook
// reference (a module path, `{ modulePath, export }` or the function itself) into a function.
// A module path is only checked to exist here; the module itself is imported the first time the
// hook runs (in the setup phase of a capture, after the safety checks), so commands that never
// run a hook (`order`, `validate`, `build --skip-capture`) never run a hook module's top-level code.
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { STATE_NAME_PATTERN } from "../walkthrough/schema.js";
import type { ResolvedStateConfig, StateCheckHook, StateConfig, StateHookRef, StateSetupHook } from "../config/types.js";
import { ensureTsxForFile, runningUnderTsx } from "../config/load.js";

const STATE_KEYS = new Set(["description", "as", "setup", "check"]);

/** Resolves config `states`, throwing one plain message for the first bad entry. */
export async function resolveStates(
  states: Record<string, StateConfig>,
  configDir: string,
): Promise<Record<string, ResolvedStateConfig>> {
  const out: Record<string, ResolvedStateConfig> = {};
  for (const [name, state] of Object.entries(states)) {
    if (!STATE_NAME_PATTERN.test(name)) {
      throw new Error(`config states: "${name}" isn't kebab-case (lowercase letters and digits joined by single hyphens, e.g. session-full)`);
    }
    if (!state || typeof state !== "object") throw new Error(`config states.${name} must be an object`);
    const unknown = Object.keys(state).filter((k) => !STATE_KEYS.has(k));
    if (unknown.length > 0) {
      throw new Error(`config states.${name} has unknown field(s) ${unknown.join(", ")} (allowed: ${[...STATE_KEYS].join(", ")})`);
    }
    out[name] = {
      ...(state.description !== undefined ? { description: state.description } : {}),
      ...(state.as !== undefined ? { as: state.as } : {}),
      ...(state.setup !== undefined ? { setup: await resolveHook<StateSetupHook>(state.setup, configDir, "setup", name) } : {}),
      ...(state.check !== undefined ? { check: await resolveHook<StateCheckHook>(state.check, configDir, "check", name) } : {}),
    };
  }
  return out;
}

async function resolveHook<T>(ref: StateHookRef<T>, configDir: string, kind: "setup" | "check", state: string): Promise<T> {
  if (typeof ref === "function") return ref;
  const spec = typeof ref === "string" ? { modulePath: ref } : (ref as { modulePath: string; export?: string });
  const { modulePath } = spec;
  const exportName = "export" in spec ? spec.export : undefined;
  if (typeof modulePath !== "string") throw new Error(`config states.${state}.${kind} must be a function or a module path`);
  const file = isAbsolute(modulePath) ? modulePath : join(configDir, modulePath);
  if (!existsSync(file)) throw new Error(`config states.${state}.${kind}: no module at ${file}`);
  let loaded: Promise<(...args: unknown[]) => unknown> | undefined;
  const lazy = (...args: unknown[]): Promise<unknown> => {
    loaded ??= importHook(file, exportName, kind, state);
    // A failed import is retried next time rather than cached.
    loaded.catch(() => (loaded = undefined));
    return loaded.then((fn) => fn(...args));
  };
  return lazy as T;
}

/** Imports a hook module and picks the hook: the named export, else `setup`/`check`, else default. */
async function importHook(file: string, exportName: string | undefined, kind: "setup" | "check", state: string): Promise<(...args: unknown[]) => unknown> {
  await ensureTsxForFile(file);
  // Same cache-busting as importAdapter in config/load.ts, for a runtime-registered tsx loader.
  const needsCacheBust = /\.(ts|mts|cts)$/.test(file) && !runningUnderTsx();
  const mod = (await import(pathToFileURL(file).href + (needsCacheBust ? `?t=${Date.now()}` : ""))) as Record<string, unknown>;
  let value = exportName ? mod[exportName] : (mod[kind] ?? mod.default);
  if (value && typeof value === "object" && (value as { __esModule?: boolean }).__esModule === true && "default" in value) {
    value = (value as { default: unknown }).default;
  }
  if (typeof value !== "function") {
    const wanted = exportName ? `an export named "${exportName}"` : `a "${kind}" export or a default export`;
    throw new Error(`config states.${state}.${kind}: ${file} has no usable hook (expected ${wanted} that is a function)`);
  }
  return value as (...args: unknown[]) => unknown;
}
