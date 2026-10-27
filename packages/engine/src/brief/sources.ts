// `aida brief sources`: the app's own prose worth reading before writing the brief — README,
// docs, package description, the root layout's metadata, the landing page, seed data, end-to-end
// test titles, the PR template and recent commit subjects — ranked and capped so the list stays
// around 60 lines. Paths, sizes and headings only: never file contents.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { walkFiles } from "../domain/walk.js";

export type BriefSourceKind = "readme" | "package" | "metadata" | "landing" | "docs" | "notes" | "seed" | "tests" | "pr-template";

export interface BriefSource {
  kind: BriefSourceKind;
  path: string;
  bytes: number;
  /** Top headings (Markdown H1/H2, or the landing page's h1–h3). */
  headings?: string[];
  /** A short value worth showing as is: package description, metadata title/description, test count. */
  note?: string;
  score: number;
}

export interface BriefSourcesResult {
  repo: string;
  sources: BriefSource[];
  /** Matching files left out by the caps. */
  omitted: number;
  /** Recent commit subjects, newest first (merges skipped). */
  commits: string[];
}

const MAX_HEADINGS = 3;
const MAX_COMMITS = 50;
const CAPS: Record<BriefSourceKind, number> = { readme: 2, package: 1, metadata: 2, landing: 4, docs: 15, notes: 10, seed: 6, tests: 6, "pr-template": 2 };
const BASE: Record<BriefSourceKind, number> = { readme: 100, package: 95, metadata: 90, landing: 85, docs: 60, notes: 50, seed: 45, tests: 40, "pr-template": 30 };

// Matched against a file name's words (`TIMEZONE_QUICK_START.md` -> `-timezone-quick-start-`), so
// "product" never matches "production" and "fix" never matches "prefix".
const HELPFUL = /-(overview|guides?|users?|getting-started|quick-start|intro|introduction|faqs?|help|manual|features?|how-to|howto|concepts?|glossary|domain|business|process(es)?|about|product|roles?|permissions?|quick-reference|website|marketing|landing|content|copy|pricing|tutorials?|handbook|walkthroughs?)-/;
// Notes for the people who build and run the app, not its users: ranked below every product doc.
const OPS = /-(migrat\w*|runbooks?|deploy\w*|security|bugs?|bugfix\w*|fix|fixes|fixed|hotfix\w*|implement\w*|summary|summaries|todos?|tasks|changelog|changes|release-notes|update-notes|improvements?|refactor\w*|complete|audit\w*|incidents?|postmortems?|backups?|cleanup|handoff|optimi[sz]ation\w*|performance|architecture|setup|install\w*|contributing|license|code-of-conduct|agents|claude|status|plan|cookbook|loading|debug\w*|troubleshoot\w*|infra\w*)-/;
const OPS_DIR = /(^|\/)(ops|runbooks?|migrations?|deploy\w*|incidents?|postmortems?|security|adrs?|decisions|internal|dev|development|engineering|infra\w*|archive)\//i;
const PRODUCT_DIR = /(^|\/)(users?|guides?|help|marketing|product|tutorials?|faqs?|handbook|features)\//i;

/** A file name's words, lowercased, dash-joined and dash-wrapped: `PermissionsImplementation.md`
 * -> `-permissions-implementation-`. */
function nameWords(name: string): string {
  const stem = name.replace(/\.[^.]+$/, "");
  const words = stem
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  return `-${words.join("-")}-`;
}

function size(repo: string, rel: string): number {
  try {
    return statSync(join(repo, rel)).size;
  } catch {
    return 0;
  }
}

function read(repo: string, rel: string, max = 200_000): string {
  try {
    return readFileSync(join(repo, rel), "utf8").slice(0, max);
  } catch {
    return "";
  }
}

function clip(s: string, max = 70): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** First H1/H2 headings of a Markdown file, outside code fences. */
export function markdownHeadings(text: string, max = MAX_HEADINGS): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const h = !fenced ? /^#{1,2}\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (h) out.push(clip(h[1].replace(/[*_`]/g, "")));
    if (out.length >= max) break;
  }
  return out;
}

/** Text of h1–h3 elements in a JSX/TSX page, expressions and tags removed. */
export function jsxHeadings(text: string, max = 4): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/g)) {
    const t = m[2].replace(/\{[^}]*\}/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (t) out.push(clip(t));
    if (out.length >= max) break;
  }
  return out;
}

/** Product and user docs (guides, help, FAQs, marketing copy) first; notes for the people who
 * build and run the app (migrations, runbooks, deploys, fix and implementation summaries,
 * changelogs, to-dos) last, whatever else their name says. */
export function scoreDoc(rel: string, base: number): number {
  const name = posix.basename(rel);
  const words = nameWords(name);
  // Net of both: a user guide that mentions an ops word ("security settings guide", under
  // docs/guides/) keeps its product boost and lands between product docs and pure ops notes.
  let score = base;
  if (HELPFUL.test(words)) score += 20;
  if (PRODUCT_DIR.test(rel)) score += 15;
  if (name.startsWith(".")) score -= 40;
  if (OPS.test(words)) score -= 40;
  if (OPS_DIR.test(rel)) score -= 30;
  return score;
}

function gitSubjects(repo: string): string[] {
  try {
    const out = execFileSync("git", ["-C", repo, "log", "--no-merges", "--format=%s", "-n", String(MAX_COMMITS), "--", "."], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
    return out.split("\n").map((s) => clip(s, 100)).filter(Boolean);
  } catch {
    return [];
  }
}

export function findBriefSources(repo: string): BriefSourcesResult {
  const all: BriefSource[] = [];
  const add = (kind: BriefSourceKind, rel: string, extra: Partial<BriefSource> = {}) =>
    all.push({ kind, path: rel, bytes: size(repo, rel), score: extra.score ?? BASE[kind], ...extra });

  const top = walkFiles(repo, () => true, { maxDepth: 0, limit: 500 });
  for (const rel of top) {
    if (/^readme(\.(md|mdx|txt|rst))?$/i.test(rel)) add("readme", rel, { headings: markdownHeadings(read(repo, rel)) });
    else if (/\.mdx?$/i.test(rel)) add("notes", rel, { headings: markdownHeadings(read(repo, rel)), score: scoreDoc(rel, BASE.notes) });
  }

  if (existsSync(join(repo, "package.json"))) {
    try {
      const pkg = JSON.parse(read(repo, "package.json")) as { name?: string; description?: string };
      if (pkg.description?.trim()) add("package", "package.json", { note: clip(`${pkg.name ? `${pkg.name}: ` : ""}${pkg.description}`, 160) });
    } catch {
      // not JSON: skip
    }
  }

  // Next.js-style app folders, at the root or one level into a workspace (apps/web).
  const appFiles = walkFiles(
    repo,
    (rel) => /^(?:(?:apps|packages)\/[^/]+\/)?(?:src\/)?(?:app\/(?:\([^/)]+\)\/)?(?:layout|page)|pages\/index)\.(tsx|jsx|ts|js|mdx)$/.test(rel),
    { maxDepth: 5, limit: 50 },
  );
  for (const rel of appFiles.filter((f) => /\/layout\.|^(src\/)?app\/layout\./.test(f) && !/\([^)]+\)\/layout/.test(f))) {
    const text = read(repo, rel);
    const meta = /export\s+const\s+metadata[\s\S]{0,2000}/.exec(text)?.[0] ?? "";
    const title = /title\s*:\s*(?:\{[^}]*?default\s*:\s*)?["'`]([^"'`]+)["'`]/.exec(meta)?.[1];
    const description = /description\s*:\s*["'`]([^"'`]+)["'`]/.exec(meta)?.[1];
    if (title || description) add("metadata", rel, { note: clip([title, description].filter(Boolean).join(" — "), 200) });
  }
  for (const rel of appFiles.filter((f) => /(?:page|index)\.[a-z]+$/.test(f))) {
    add("landing", rel, { headings: jsxHeadings(read(repo, rel)), score: BASE.landing + (/\((marketing|home|landing|public|site)\)/.test(rel) ? 5 : 0) });
  }

  for (const rel of walkFiles(join(repo, "docs"), (f) => /\.mdx?$/i.test(f), { maxDepth: 3, limit: 400 })) {
    const path = `docs/${rel}`;
    add("docs", path, { headings: markdownHeadings(read(repo, path)), score: scoreDoc(path, BASE.docs) });
  }

  const deep = walkFiles(
    repo,
    (rel) =>
      (/(^|\/)seeds?([-_.][^/]*)?\.(ts|js|mjs|cjs|sql|json)$/i.test(rel) || /(^|\/)(seeds?|fixtures)\/[^/]+\.(ts|js|sql|json|ya?ml)$/i.test(rel) ||
        /\.(spec|e2e)\.(ts|js|mjs)$/.test(rel) || /(^|\/)(e2e|playwright)\/.+\.(ts|js)$/.test(rel) ||
        /^(\.github|docs)\/(pull_request_template\.md|PULL_REQUEST_TEMPLATE\/[^/]+\.md)$/i.test(rel)),
    { maxDepth: 5, limit: 1000, skipHidden: true },
  );
  for (const rel of deep) {
    if (/pull_request_template/i.test(rel)) add("pr-template", rel, { headings: markdownHeadings(read(repo, rel)) });
    else if (/\.(spec|e2e)\.|(^|\/)(e2e|playwright)\//.test(rel)) {
      const text = read(repo, rel);
      const titles = [...text.matchAll(/\b(?:test|it)(?:\.(?:only|skip|fixme))?\s*\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => clip(m[1], 50));
      if (titles.length === 0) continue;
      add("tests", rel, { note: `${titles.length} test${titles.length === 1 ? "" : "s"}`, headings: titles.slice(0, MAX_HEADINGS), score: BASE.tests + Math.min(titles.length, 10) });
    } else add("seed", rel);
  }

  // Rank within each kind, cap it, then order the whole list by score.
  const kept: BriefSource[] = [];
  let omitted = 0;
  for (const kind of Object.keys(CAPS) as BriefSourceKind[]) {
    const ofKind = all.filter((s) => s.kind === kind).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    kept.push(...ofKind.slice(0, CAPS[kind]));
    omitted += Math.max(0, ofKind.length - CAPS[kind]);
  }
  kept.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return { repo, sources: kept, omitted, commits: gitSubjects(repo) };
}

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

const TEXT_COMMITS = 12;

export function formatBriefSources(result: BriefSourcesResult): string {
  const lines = [`${result.sources.length} sources in ${result.repo}${result.omitted ? ` (${result.omitted} more left out by the caps)` : ""}, best first:`];
  for (const s of result.sources) {
    const detail = [s.note, s.headings?.length ? s.headings.join(" · ") : undefined].filter(Boolean).join(" — ");
    lines.push(`  [${s.kind}] ${s.path} ${formatBytes(s.bytes)}${detail ? ` — ${detail}` : ""}`);
  }
  if (result.commits.length > 0) {
    lines.push(`recent commits (${result.commits.length}${result.commits.length > TEXT_COMMITS ? `, first ${TEXT_COMMITS}; --json for all` : ""}):`);
    for (const c of result.commits.slice(0, TEXT_COMMITS)) lines.push(`  - ${c}`);
  }
  return lines.join("\n");
}
