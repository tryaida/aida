// `aida brief` (build-plan.md M31, decision 33): manages `app-brief.md` — `sources` lists the
// app's own prose worth reading, `init` writes the skeleton, `check` validates it, `show` prints
// it or one section.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ResolvedConfig } from "../config/index.js";
import {
  BRIEF_SECTIONS,
  briefPath,
  briefTemplate,
  checkBrief,
  findBriefSources,
  findSection,
  formatBriefSources,
  parseBrief,
  sectionText,
} from "../brief/index.js";
import { buildAppDomain, fail, loadOptionalConfig, resolveAppRepo, workspaceRoot } from "./domain.js";

interface BriefFileOptions {
  configPath?: string;
  /** Explicit brief path; overrides the config's. */
  brief?: string;
  json: boolean;
}

/** `--brief`, else the config's `brief` (default `app-brief.md` beside it). */
function resolveBriefFile(opts: BriefFileOptions, config: ResolvedConfig | undefined): string | undefined {
  if (opts.brief) return resolve(opts.brief);
  if (config) return briefPath(config);
  return undefined;
}

async function setup(command: string, opts: BriefFileOptions): Promise<{ config?: ResolvedConfig; file?: string; code?: number }> {
  const { config, code } = await loadOptionalConfig(opts.configPath, command, opts.json);
  if (code) return { code };
  const file = resolveBriefFile(opts, config);
  if (!file) return { code: fail(command, "pass --config (the brief sits beside it) or --brief <path>", opts.json) };
  return { config, file };
}

export async function runBriefSources(opts: { configPath?: string; repo?: string; json: boolean }): Promise<number> {
  const { config, code } = await loadOptionalConfig(opts.configPath, "brief sources", opts.json);
  if (code) return code;
  const appRepo = resolveAppRepo(opts.repo, config);
  if (!existsSync(appRepo)) return fail("brief sources", `app repo not found: ${appRepo}`, opts.json);
  // An app inside a workspace monorepo: its README and docs app sit at the workspace root.
  const repo = (!opts.repo && workspaceRoot(appRepo)) || appRepo;
  const result = findBriefSources(repo);
  if (opts.json) console.log(JSON.stringify({ ok: true, ...result }));
  else console.log(formatBriefSources(result));
  return 0;
}

export async function runBriefCheck(opts: BriefFileOptions): Promise<number> {
  const { file, code } = await setup("brief check", opts);
  if (code !== undefined || !file) return code ?? 1;
  if (!existsSync(file)) return fail("brief check", `no brief at ${file} (aida brief init writes one)`, opts.json, { path: file });
  const result = checkBrief(readFileSync(file, "utf8"));
  if (opts.json) {
    console.log(JSON.stringify({ path: file, ...result }));
  } else {
    const filled = result.sections.filter((s) => s.filled).length;
    console.log(`${result.ok ? "ok" : "not ready"}: ${file} — ${filled}/${BRIEF_SECTIONS.length} sections filled, ${result.chars} characters`);
    for (const e of result.errors) console.log(`  error: ${e.section ? `[${e.section}] ` : ""}${e.message}`);
    for (const w of result.warnings) console.log(`  warning: ${w.section ? `[${w.section}] ` : ""}${w.message}`);
  }
  return result.ok ? 0 : 1;
}

export async function runBriefShow(opts: BriefFileOptions & { sections?: string[] }): Promise<number> {
  const { file, code } = await setup("brief show", opts);
  if (code !== undefined || !file) return code ?? 1;
  if (!existsSync(file)) return fail("brief show", `no brief at ${file} (aida brief init writes one)`, opts.json, { path: file });
  const text = readFileSync(file, "utf8");
  const brief = parseBrief(text);
  const wanted = opts.sections ?? [];
  if (wanted.length === 0) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, path: file, frontmatter: brief.frontmatter ?? null, sections: brief.sections.map((s) => ({ name: s.name, text: sectionText(s) })) }));
    } else process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    return 0;
  }
  const found = wanted.map((q) => ({ query: q, section: findSection(brief, q) }));
  const missing = found.filter((f) => !f.section).map((f) => f.query);
  if (missing.length > 0) {
    return fail("brief show", `no section matching ${missing.map((m) => `"${m}"`).join(", ")} (sections: ${brief.sections.map((s) => s.name).join(", ")})`, opts.json);
  }
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, path: file, sections: found.map((f) => ({ name: f.section!.name, text: sectionText(f.section) })) }));
  } else {
    console.log(found.map((f) => `## ${f.section!.name}\n\n${sectionText(f.section)}`).join("\n\n"));
  }
  return 0;
}

export async function runBriefInit(opts: BriefFileOptions & { repo?: string; force?: boolean }): Promise<number> {
  const { config, file, code } = await setup("brief init", opts);
  if (code !== undefined || !file) return code ?? 1;
  if (existsSync(file) && !opts.force) {
    return fail("brief init", `${file} already exists; pass --force to replace it`, opts.json, { path: file });
  }
  const repo = resolveAppRepo(opts.repo, config);
  const domain = existsSync(repo) ? buildAppDomain(repo, {}, !opts.repo) : undefined;
  const roles = config?.roles
    ? Object.entries(config.roles).map(([role, v]) => ({ role, name: typeof v === "string" ? v : v.name }))
    : (config?.readers ?? []).map((r) => ({ role: r, name: r.replace(/[-_]/g, " ") }));
  const text = briefTemplate({
    app: config?.chat?.appName ?? config?.brand?.name,
    updated: new Date().toISOString().slice(0, 10),
    roles,
    domain: domain?.ok ? domain.model : undefined,
  });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
  const domainNote = domain?.ok ? `${domain.model.entities.length} entities from ${domain.model.source.kind}` : "no schema found";
  if (opts.json) console.log(JSON.stringify({ ok: true, path: file, domain: domain?.ok ? { source: domain.model.source, entities: domain.model.entities.length } : null }));
  else console.log(`wrote ${file} (${domainNote}); fill every section, then run aida brief check`);
  return 0;
}
