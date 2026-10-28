// `aida domain` (build-plan.md M31): prints the app's domain model, read statically from its
// database schema — entities, key columns, links and states — for the Understand step.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadConfig, type ResolvedConfig } from "../config/index.js";
import { buildDomain, findEntity, formatDomain, formatEntity, type DomainSourceKind } from "../domain/index.js";
import { resolveAppDir } from "../safety/database.js";

export interface RunDomainOptions {
  configPath?: string;
  /** App repo to read (default: `impact.appRepo`, then the app's own directory, then the config's). */
  repo?: string;
  entity?: string;
  source?: string;
  json: boolean;
}

const SOURCES: DomainSourceKind[] = ["drizzle", "prisma", "sql"];

/** The app repo a command reads: `--repo`, else the config's `impact.appRepo`, else the app's own
 * directory (`resolveAppDir`), else the config file's directory, else the working directory. */
export function resolveAppRepo(repo: string | undefined, config: ResolvedConfig | undefined): string {
  if (repo) return resolve(repo);
  if (!config) return process.cwd();
  return config.impact?.appRepo ?? resolveAppDir(config)?.dir ?? config.configDir;
}

/** Loads the config when a path is given; prints the failure and returns `undefined` + a code
 * otherwise. */
export async function loadOptionalConfig(configPath: string | undefined, command: string, json: boolean): Promise<{ config?: ResolvedConfig; code?: number }> {
  if (!configPath) return {};
  try {
    return { config: await loadConfig(configPath) };
  } catch (err) {
    fail(command, (err as Error).message.split("\n")[0], json);
    return { code: 1 };
  }
}

export function fail(command: string, message: string, json: boolean, extra: Record<string, unknown> = {}): number {
  if (json) console.log(JSON.stringify({ ok: false, error: message, ...extra }));
  else console.error(`${command} failed: ${message}`);
  return 1;
}

export async function runDomain(opts: RunDomainOptions): Promise<number> {
  const { config, code } = await loadOptionalConfig(opts.configPath, "domain", opts.json);
  if (code) return code;
  if (opts.source && !SOURCES.includes(opts.source as DomainSourceKind)) {
    return fail("domain", `--source must be one of ${SOURCES.join(", ")}`, opts.json);
  }
  const repo = resolveAppRepo(opts.repo, config);
  if (!existsSync(repo)) return fail("domain", `app repo not found: ${repo}`, opts.json);

  const result = buildAppDomain(repo, { source: opts.source as DomainSourceKind | undefined }, !opts.repo);
  if (!result.ok) return fail("domain", result.error, opts.json, { repo });
  const { model } = result;

  if (opts.entity) {
    const entity = findEntity(model, opts.entity);
    if (!entity) return fail("domain", `no entity "${opts.entity}" (aida domain lists them)`, opts.json);
    if (opts.json) {
      const enums = Object.fromEntries(entity.columns.filter((c) => c.enum).map((c) => [c.enum!, model.enums[c.enum!] ?? []]));
      console.log(JSON.stringify({ ok: true, repo, source: model.source, entity, enums }));
    } else console.log(formatEntity(model, entity));
    return 0;
  }

  if (opts.json) console.log(JSON.stringify({ ok: true, repo, ...model }));
  else console.log(formatDomain(model));
  return 0;
}

/** `buildDomain` for the app's repo. When the repo wasn't named explicitly and has no schema, the
 * workspace monorepo root around it is read instead: there the schema often lives in a shared
 * package (packages/db), not the app's own folder. */
export function buildAppDomain(repo: string, opts: Parameters<typeof buildDomain>[1] = {}, tryWorkspace = true): ReturnType<typeof buildDomain> {
  const result = buildDomain(repo, opts);
  const workspace = !result.ok && tryWorkspace ? workspaceRoot(repo) : undefined;
  if (!workspace) return result;
  const fromWorkspace = buildDomain(workspace, opts);
  return fromWorkspace.ok ? fromWorkspace : result;
}

/** The workspace monorepo root above `dir` (a pnpm-workspace.yaml, or a package.json with
 * `workspaces`), stopping at the git root. Undefined when `dir` isn't inside one. */
export function workspaceRoot(dir: string): string | undefined {
  for (let d = dirname(resolve(dir)); d !== dirname(d); d = dirname(d)) {
    if (existsSync(join(d, "pnpm-workspace.yaml"))) return d;
    const pkg = join(d, "package.json");
    if (existsSync(pkg)) {
      try {
        if ((JSON.parse(readFileSync(pkg, "utf8")) as { workspaces?: unknown }).workspaces) return d;
      } catch {
        // not a readable package.json: keep looking
      }
    }
    if (existsSync(join(d, ".git"))) return undefined;
  }
  return undefined;
}
