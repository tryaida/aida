// Builds the generated blocks (see markers.ts) for one page: frontmatter, intro, "before you
// start", the numbered steps (with their screenshot), "good to know", and the last-checked line.
import type { Walkthrough, Step } from "../walkthrough/index.js";
import { personaRole } from "../walkthrough/persona.js";
import type { AidaConfig } from "../config/types.js";
import { FRONTMATTER_KEY, type GeneratedBlock } from "./markers.js";

/** config `roles`: role id -> what readers call it. See `AidaConfig.roles`. */
export type RoleNames = NonNullable<AidaConfig["roles"]>;

export interface StepStatus {
  /** manifest.steps[i].doc, when capture data exists for this step. */
  screenshot?: string;
  ok: boolean;
  /** Set when this step failed, or has no capture data at all (capture stopped before it ran). */
  problem?: string;
}

export interface FrontmatterLinks {
  video?: string;
  srt?: string;
  vtt?: string;
}

export interface PageFrontmatter {
  title: string;
  /** The walkthrough summary — shown under the title in the library's page cards. */
  description?: string;
  for?: string;
  walkthrough: string;
  /** Reader-facing library path, e.g. "How do I… / Payments" (walkthrough/placement.ts). */
  section?: string;
  /** Number of steps in the walkthrough. */
  steps?: number;
  lastChecked?: string;
  passed: boolean;
  links?: FrontmatterLinks;
}

function yamlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Escapes text pulled from a walkthrough (`title`, `summary`, `for`, `page_text`, `caption`,
 * `outro.recap`) before it goes raw into the generated `.mdx` body. MDX parses `{...}` as a JS
 * expression and `<...>` as JSX — a reader-written `{name}` or `a < b` otherwise either breaks
 * the next `next build` or, worse, gets evaluated as code. A backslash escape is MDX's own
 * mechanism for a literal `{`, `}` or `<` (an extension of CommonMark's backslash-escaping), so
 * intended Markdown — `**bold**`, `[text](url)` — keeps rendering exactly as before; none of
 * those syntaxes use the three characters this escapes.
 */
export function escapeMdxText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/[{}<]/g, "\\$&");
}

export function buildFrontmatterBlock(fm: PageFrontmatter): GeneratedBlock {
  const lines = ["---", `title: ${yamlString(fm.title)}`];
  if (fm.description) lines.push(`description: ${yamlString(fm.description)}`);
  lines.push("kind: walkthrough");
  if (fm.for) lines.push(`for: ${yamlString(fm.for)}`);
  lines.push(`walkthrough: ${yamlString(fm.walkthrough)}`);
  if (fm.section) lines.push(`section: ${yamlString(fm.section)}`);
  if (fm.steps !== undefined) lines.push(`steps: ${fm.steps}`);
  if (fm.lastChecked) lines.push(`lastChecked: ${yamlString(fm.lastChecked)}`);
  lines.push(`passed: ${fm.passed}`);
  if (fm.links?.video) lines.push(`video: ${yamlString(fm.links.video)}`);
  if (fm.links?.srt) lines.push(`srt: ${yamlString(fm.links.srt)}`);
  if (fm.links?.vtt) lines.push(`vtt: ${yamlString(fm.links.vtt)}`);
  lines.push("---");
  return { key: FRONTMATTER_KEY, content: lines.join("\n") };
}

function lowerFirst(s: string): string {
  return s.length > 0 ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

export function buildHeaderBlock(wf: Walkthrough): GeneratedBlock {
  const lines = [`# ${escapeMdxText(wf.title)}`, ""];
  const summary = wf.summary ? escapeMdxText(wf.summary.trim()) : "";
  const forSentence = wf.for ? `This guide is for ${escapeMdxText(lowerFirst(wf.for.trim()))}.` : "";
  const para = [summary, forSentence].filter(Boolean).join(" ");
  if (para) lines.push(para);
  return { key: "header", content: lines.join("\n").trimEnd() };
}

/**
 * Maps a raw persona role id (e.g. `office_staff`, an app-internal value never meant for
 * readers) to a reader-friendly name. Tried in order:
 *
 * 0. `config.roles` — the owner's own word for the role (`admin: "an organiser"`), used as written.
 * 1. The walkthrough's own `for` sentence — if the humanised id appears in it, reuse that exact
 *    wording/casing ("office staff" found inside "Show office staff and secretaries...").
 * 2. `config.readers` — if a configured reader name normalises to the same id, use it as written.
 * 3. A plain humanised form of the id itself (`office_staff` -> "office staff").
 *
 * Never returns the raw id verbatim (with its underscores/dashes) — that's the bug this fixes.
 */
export function readerNameForRole(
  roleId: string,
  wf: Pick<Walkthrough, "for">,
  readers?: string[],
  roles?: RoleNames,
): string {
  // Own keys only: a role id like `constructor` must not pick up Object.prototype's.
  const mapped = roles && Object.hasOwn(roles, roleId) ? roles[roleId] : undefined;
  const mappedName = typeof mapped === "string" ? mapped : mapped?.name;
  if (mappedName?.trim()) return mappedName.trim();

  const normalise = (s: string): string => s.replace(/[_-]+/g, " ").trim().toLowerCase();
  const target = normalise(roleId);

  if (wf.for) {
    const re = new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const m = re.exec(wf.for);
    if (m) return m[0];
  }

  for (const reader of readers ?? []) {
    if (normalise(reader) === target) return reader.replace(/[_-]+/g, " ").trim();
  }

  return target;
}

/**
 * Reader-facing "before you start" bullets only: who to sign in as (role id mapped to a reader
 * name — see `readerNameForRole`) and which show/record to be working in. Deliberately never
 * includes `start.notes` — that field carries internal capture/environment context (demo
 * database paths, "data is synthetic" asides for whoever re-runs the walkthrough), not anything a
 * reader of the published page needs or should see.
 */
export function buildBeforeYouStartBlock(wf: Walkthrough, readers?: string[], roles?: RoleNames): GeneratedBlock | undefined {
  const bullets: string[] = [];
  const start = wf.start;
  const roleId = personaRole(start);
  if (roleId) bullets.push(`Sign in as **${escapeMdxText(readerNameForRole(roleId, wf, readers, roles))}**.`);
  if (start?.show) bullets.push(`Make sure **${start.show}** is the current show.`);
  if (bullets.length === 0) return undefined;
  const lines = ["## Before you start", "", ...bullets.map((b) => `- ${b}`)];
  return { key: "before-you-start", content: lines.join("\n") };
}

export function buildStepsHeadingBlock(): GeneratedBlock {
  return { key: "steps-heading", content: "## Steps" };
}

/** Unique chapter names, in first-seen order. Empty when no step sets `chapter`. */
export function chaptersOf(steps: Step[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of steps) {
    if (!s.chapter || seen.has(s.chapter)) continue;
    seen.add(s.chapter);
    out.push(s.chapter);
  }
  return out;
}

export function buildChapterBlock(chapter: string, index: number): GeneratedBlock {
  return { key: `chapter-${index + 1}`, content: `### Part ${index + 1}: ${chapter}` };
}

export function screenshotFile(stepNumber: number): string {
  return `screenshots/step-${String(stepNumber).padStart(2, "0")}.png`;
}

/**
 * The marker/sidecar key for one step's block. Keyed by `step.id` (stable across reorders and
 * inserted steps) rather than position — a plain `step-${stepNumber}` key would re-attach a
 * human's edit to whatever step now sits at that position after a reorder or an insert. Falls
 * back to position only when the step has no id. See `build.ts` for the one-time migration of
 * pages built before this fix, which keyed every step by position.
 */
export function stepBlockKey(step: Step, stepNumber: number): string {
  return step.id ? `step-${step.id}` : `step-${stepNumber}`;
}

export function buildStepBlock(step: Step, stepNumber: number, status: StepStatus): GeneratedBlock {
  const rawTitle = step.title ?? step.id ?? `Step ${stepNumber}`;
  const title = escapeMdxText(rawTitle);
  const text = escapeMdxText(step.page_text?.trim() || step.caption?.trim() || "");
  const lines = [`#### ${stepNumber}. ${title}`, ""];
  if (!status.ok) {
    lines.push(`> **Not verified.** ${status.problem ?? "this step did not pass the last capture."}`, "");
  }
  if (text) lines.push(text, "");
  if (status.screenshot) {
    // The image alt text is rendered inside `![...]()`, not as free MDX body text, but still
    // goes through the same MDX parser — escape it too rather than special-case it as safe.
    lines.push(`![${title}](${status.screenshot})`);
  }
  return { key: stepBlockKey(step, stepNumber), content: lines.join("\n").trimEnd() };
}

export function buildGoodToKnowBlock(wf: Walkthrough): GeneratedBlock | undefined {
  const recap = wf.outro?.recap;
  if (!recap || recap.length === 0) return undefined;
  const lines = ["## Good to know", "", ...recap.map((r) => `- ${escapeMdxText(r)}`)];
  return { key: "good-to-know", content: lines.join("\n") };
}

export function buildLastCheckedBlock(lastChecked: string | undefined, passed: boolean): GeneratedBlock {
  const date = lastChecked ? lastChecked.slice(0, 10) : "not yet captured";
  const verb = passed ? "verified against the real app" : "NOT fully verified — see problems above";
  return {
    key: "last-checked",
    content: `---\n\n*Steps ${verb} on ${date}.*`,
  };
}
