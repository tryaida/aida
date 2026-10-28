// Builds the one PR comment `aida ci` keeps up to date (decisions #23). Short on purpose: a
// summary line, possible app bugs with their evidence (decision 30: for a person, never a repair
// command), broken walkthroughs with the repair command, one table per changed walkthrough, stale
// pages, a footer. The hidden marker lets `github.ts` find and PATCH the same comment on every
// push instead of posting a new one each time.
import type { CiResult, CiWalkthroughResult, NewRouteResult } from "./types.js";
import { claudeDraftCommentFor, claudeRepairCommentFor } from "./tiers.js";

export const COMMENT_MARKER = "<!-- aida-ci-comment -->";

const ZWSP = "\u200b";

/**
 * Text that came from the app or a walkthrough (a failure reason, a page error, an on-screen
 * name), made safe to put in the PR comment as plain words: one line, markdown that could make a
 * link, image, HTML or table cell shown literally, and `@name`, `#123` and bare `https://` links
 * broken with an invisible space so they never notify anyone, reference an issue or link off.
 */
export function commentText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*_[\]<>|~]/g, (c) => `\\${c}`)
    .replace(/([@#])(?=[\p{L}\p{N}_-])/gu, `$1${ZWSP}`)
    .replace(/:\/\//g, `:${ZWSP}//`)
    .replace(/\bwww\./gi, (w) => `${w.slice(0, 3)}${ZWSP}.`);
}

export interface CommentImageUrls {
  /** Resolves a `ChangedStep`'s absolute `before`/`after`/`diff` path to a URL usable in the
   * comment (a `raw.githubusercontent.com` URL at the preview commit sha, or a local file:// /
   * relative path in `--dry-run`). */
  urlFor(path: string): string;
}

export interface BuildCommentOptions {
  prNumber?: number;
  /** Shows the optional `@claude` comment shortcut alongside each local repair/draft command —
   * set when the repo has the Claude Code GitHub Action installed (`aida init --ci --claude`,
   * or `config.ci.claudeAction`). Decisions #22: CI itself never calls a model either way. */
  claudeActionInstalled?: boolean;
}

function statusLabel(status: CiWalkthroughResult["status"]): string {
  switch (status) {
    case "unchanged":
      return "no visible change";
    case "changed":
      return "changed";
    case "new":
      return "new walkthrough — no baseline yet";
    case "failed":
      return "broken";
  }
}

/** One possible app bug: the reason and evidence, no repair command (decision 30). */
function appBugSection(result: CiWalkthroughResult): string {
  const lines = [`### \`${result.walkthrough}\` — possible app bug`];
  if (result.failure) {
    lines.push("");
    lines.push(`> ${commentText(result.failure.reason ?? result.failure.summary)}`);
    lines.push("");
    lines.push(`- failed at: ${commentText(result.failure.summary)}`);
    if (result.failure.evidence) lines.push(`- evidence: ${commentText(result.failure.evidence)}`);
  }
  lines.push("");
  lines.push("Please check this in the app. The walkthrough is left as it is: docs aren't changed to work around an app bug.");
  return lines.join("\n");
}

function walkthroughSection(result: CiWalkthroughResult, images: CommentImageUrls, opts: BuildCommentOptions): string {
  const lines: string[] = [];
  lines.push(`### \`${result.walkthrough}\` — ${statusLabel(result.status)} (${result.tier})`);

  if (result.tier === "broken" && result.failure) {
    lines.push("");
    lines.push(`> ${commentText(result.failure.summary)}`);
    // Only say who it looks like when it isn't the walkthrough itself (sign-in, setup, unreachable app).
    if (result.failure.category === "environment" && result.failure.reason) {
      lines.push("");
      lines.push(`Looks like a setup problem, not the walkthrough: ${commentText(result.failure.reason)}.`);
    }
    if (result.failure.category === "undetermined") {
      lines.push("");
      lines.push(`Couldn't tell whether this is the walkthrough or the app${result.failure.reason ? `: ${commentText(result.failure.reason)}` : ""}. A person should look; the walkthrough isn't repaired around it.`);
      if (result.failure.evidence) lines.push(`- evidence: ${commentText(result.failure.evidence)}`);
    }
    if (!result.failure.repairCommand) return lines.join("\n");
    lines.push("");
    lines.push("Run locally in Claude Code:");
    lines.push("```");
    lines.push(result.failure.repairCommand);
    lines.push("```");
    if (opts.claudeActionInstalled) {
      lines.push("");
      lines.push(`Or comment this on the PR: \`${claudeRepairCommentFor(result.walkthrough)}\``);
    }
    return lines.join("\n");
  }

  // Cosmetic: no action needed — it refreshes and publishes on merge.
  lines.push("");
  lines.push("Cosmetic — will refresh on merge, nobody needs to do anything.");

  if (result.status === "changed" && result.changedSteps.length > 0) {
    lines.push("");
    lines.push("| step | before | after | diff | change |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const step of result.changedSteps) {
      const before = step.before ? `![before](${images.urlFor(step.before)})` : "_(none — new step)_";
      const after = `![after](${images.urlFor(step.after)})`;
      const diff = `![diff](${images.urlFor(step.diff)})`;
      lines.push(`| ${step.step} | ${before} | ${after} | ${diff} | ${(step.changeRatio * 100).toFixed(1)}% |`);
    }
  }

  return lines.join("\n");
}

function newRouteSection(route: NewRouteResult, opts: BuildCommentOptions): string {
  const lines: string[] = [];
  lines.push(`### \`${route.path}\` — new, no walkthrough yet`);
  lines.push("");
  lines.push(`\`${route.file}\``);
  lines.push("");
  lines.push("Draft a walkthrough locally in Claude Code (labels the PR \`docs:new\`):");
  lines.push("```");
  lines.push(route.draftCommand);
  lines.push("```");
  if (opts.claudeActionInstalled) {
    lines.push("");
    lines.push(`Or comment this on the PR: \`${claudeDraftCommentFor(route)}\``);
  }
  return lines.join("\n");
}

/** Builds the full comment body. `prNumber`/`appUrl` are shown in the footer only — this never
 * calls out to GitHub or a model. */
export function buildCommentMarkdown(result: CiResult, images: CommentImageUrls, opts: BuildCommentOptions = {}): string {
  const changed = result.results.filter((r) => r.status === "changed");
  const broken = result.results.filter((r) => r.tier === "broken");
  const appBugs = result.results.filter((r) => r.tier === "app");
  const added = result.results.filter((r) => r.status === "new");
  const unchanged = result.results.filter((r) => r.status === "unchanged");
  const newRoutes = result.newRoutes ?? [];

  const lines: string[] = [COMMENT_MARKER];
  lines.push(`## aida CI`);
  const summaryParts = [
    `${result.affected.length} walkthrough(s) affected`,
    `${changed.length} changed`,
    `${broken.length} broken`,
    ...(appBugs.length > 0 ? [`${appBugs.length} possible app bug(s)`] : []),
    `${added.length} new (no baseline)`,
    `${unchanged.length} unchanged`,
  ];
  if (newRoutes.length > 0) summaryParts.push(`${newRoutes.length} new route(s) with no walkthrough`);
  if (result.all) summaryParts.push(`(all affected — ${result.allReason ?? "diff couldn't be mapped precisely"})`);
  lines.push(summaryParts.join(" · "));
  lines.push("");

  if (appBugs.length > 0) {
    lines.push("## Possible app bugs (not docs problems)");
    lines.push("");
    for (const r of appBugs) {
      lines.push(appBugSection(r));
      lines.push("");
    }
    lines.push("## Docs");
    lines.push("");
  }

  for (const r of [...broken, ...changed, ...added]) {
    lines.push(walkthroughSection(r, images, opts));
    lines.push("");
  }

  for (const route of newRoutes) {
    lines.push(newRouteSection(route, opts));
    lines.push("");
  }

  const drifted = result.results.filter((r) => r.outlineDrift);
  if (drifted.length > 0) {
    lines.push(`**Outline drift: ${drifted.length} card${drifted.length === 1 ? "" : "s"}** (names on the outline card that differ from the screen; check \`outline.yaml\`)`);
    lines.push("");
    for (const r of drifted) {
      const card = r.outlineDrift!.card;
      // Card ids are kebab-case (outline schema); anything else is shown as plain words.
      const name = /^[a-z0-9-]+$/.test(card) ? `\`${card}\`` : commentText(card);
      lines.push(`- ${name}: ${r.outlineDrift!.differences.map(commentText).join("; ")}`);
    }
    lines.push("");
  }

  if (result.stalePages.length > 0) {
    lines.push(`**Stale pages** (published, source walkthrough no longer exists): ${result.stalePages.map((p) => `\`${p}\``).join(", ")}`);
    lines.push("");
  }

  lines.push(`---`);
  lines.push(`_base \`${result.base.slice(0, 12)}\` → head \`${result.head.slice(0, 12)}\`${opts.prNumber ? ` · PR #${opts.prNumber}` : ""} · updated on every push, no model used._`);

  return lines.join("\n");
}
