import type { Page } from "playwright";
import type { Target } from "../walkthrough/index.js";
import { locateAll } from "./locate.js";
import type { FailureReport } from "./types.js";
import { capLine, PASSWORD_VALUES_SCRIPT, redactLine, redactSnapshotText, stripQueryAndHash } from "./redact.js";
import { classifyFailure, targetShownAfterReload } from "./diagnose.js";
import type { ActionProgress, StepWatch } from "./diagnose.js";

const SNAPSHOT_LINE_CAP = 60;
/** Top-level landmarks dropped first when a full-body fallback snapshot still won't fit the cap. */
const DROP_FIRST_ROLES = ["navigation", "banner", "contentinfo"];
const DIALOG_ROLES = ["dialog", "alertdialog"] as const;
const LANDMARK_ROLES = [...DIALOG_ROLES, "navigation", "banner", "contentinfo", "complementary", "region", "form", "main"];
const ROOT_ATTR = "data-aida-failure-root";
const ANCHOR_ATTR = "data-aida-failure-anchor";

/**
 * Builds the trimmed, agent-safe failure report: step id, action, first line
 * of the error, current URL, and an accessibility snapshot capped to ~60
 * lines, plus a screenshot path. Never full HTML or console logs.
 *
 * The snapshot used to always be `body`'s, flattened to the first ~60 lines —
 * on a real app with a long left-hand nav, that cap was spent entirely on
 * the nav and the actual form (the reason the step failed) never made it in.
 * Now it prefers, in order: the `main` landmark; else the nearest
 * landmark/dialog around the failing target's closest match or the focused
 * element; else `body` (still capped, but dropping nav/banner/contentinfo
 * first). An open dialog is always folded in too, since it's usually the
 * relevant part.
 *
 * With `diagnosis` (M28) it also says what changed during the step (see capture/diagnose.ts)
 * and classifies the failure as a walkthrough, app or environment problem (decision 30).
 */
export async function buildFailureReport(
  page: Page,
  step: string | undefined,
  action: string,
  error: Error,
  screenshotPath: string | null,
  failingTarget?: Target,
  diagnosis?: { watch: StepWatch; progress: ActionProgress },
): Promise<FailureReport> {
  const changes = diagnosis ? await diagnosis.watch.changes(diagnosis.progress) : undefined;
  const snapshot = await captureTrimmedSnapshot(page, failingTarget);
  const firstLine = redactLine(error.message ?? String(error));
  const { category, reason } = classifyFailure({ error: firstLine, phase: "step", changes });
  return {
    step,
    action,
    category,
    reason,
    error: firstLine,
    url: stripQueryAndHash(page.url()),
    ...(changes ? { changes } : {}),
    // Already redacted (before its lines were capped) by captureTrimmedSnapshot.
    snapshot,
    screenshotPath,
  };
}

/**
 * True when a failed step looks like "the save worked, then the wait missed": a 2xx write, a
 * wait (`waitFor`/`expect`) that timed out, and nothing still waiting. Only then is the
 * diagnosis-only reload worth doing (see `recheckAfterReload`).
 */
export function wantsReloadCheck(f: FailureReport): boolean {
  const c = f.changes;
  if (!c || c.reload) return false;
  const savedOk = c.writes.some((w) => w.status !== undefined && w.status >= 200 && w.status < 300);
  const waiting = c.writes.some((w) => w.status === undefined);
  const wait = c.failedAction?.do === "waitFor" || c.failedAction?.do === "expect";
  return savedOk && !waiting && wait && /timeout|exceeded/i.test(f.error) && f.category !== "environment";
}

/**
 * After a 2xx save and a missed wait, reloads the page once, for diagnosis only, and looks for the
 * wait's target: if it shows up, the save worked but the screen was stale (an app bug). Call it
 * only after the failure is fully recorded (screenshot, snapshot, manifest step): the reload
 * never becomes part of the walkthrough, and writes are blocked while it runs. Returns the report
 * with `changes.reload` set and the classification redone.
 */
export async function recheckAfterReload(page: Page, f: FailureReport, target: Target, timeoutMs: number): Promise<FailureReport> {
  if (!wantsReloadCheck(f)) return f;
  const targetShown = await targetShownAfterReload(page, target, timeoutMs);
  const changes = { ...f.changes!, reload: { targetShown } };
  const { category, reason } = classifyFailure({ error: f.error, phase: "step", changes });
  return { ...f, category, reason, changes };
}

/**
 * The report for a failure outside any step: signing in, the setup phase, or before the first
 * step (browser launch, the start page, a safety refusal). No snapshot or screenshot.
 */
export function runLevelFailure(
  error: unknown,
  opts: { phase?: "sign-in" | "setup" | "run"; step?: string; action?: string; url?: string } = {},
): FailureReport {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = redactLine(message);
  const phase = opts.phase ?? phaseOf(error) ?? "run";
  const { category, reason } = classifyFailure({ error: firstLine, phase });
  return {
    step: opts.step,
    action: opts.action ?? (phase === "run" ? "run" : phase),
    category,
    reason,
    error: firstLine,
    url: opts.url ? stripQueryAndHash(opts.url) : "",
    snapshot: "",
    screenshotPath: null,
  };
}

/** The phase `runCapture` tagged a thrown error with (`aidaPhase`), if any. */
function phaseOf(error: unknown): "sign-in" | "setup" | "run" | undefined {
  const phase = (error as { aidaPhase?: unknown } | null)?.aidaPhase;
  return phase === "sign-in" || phase === "setup" || phase === "run" ? phase : undefined;
}

const CATEGORY_LABEL: Record<FailureReport["category"], string> = {
  walkthrough: "walkthrough problem",
  app: "possible app bug (not a docs problem)",
  environment: "environment problem (not the walkthrough)",
};

/** `POST /api/x 200` for each write, or "none". */
function requestList(list: { method: string; path: string; status?: number; waitedSeconds?: number }[]): string {
  if (list.length === 0) return "none";
  return list
    .map((r) => {
      const waited = r.waitedSeconds !== undefined ? ` after ${r.waitedSeconds}s` : "";
      return `${r.method} ${r.path} ${r.status === undefined ? `(no answer yet${waited})` : r.status === 0 ? "(no response)" : r.status}`;
    })
    .join(", ");
}

/**
 * The one-line evidence for a failure, for a PR comment or a short summary: what the step did to
 * the app and how the screen ended up, e.g. "URL /registrations/new (unchanged); writes: POST
 * /api/registrations 200; screen unchanged; signed in as admin".
 */
export function failureEvidence(f: FailureReport): string | undefined {
  const c = f.changes;
  if (!c) return undefined;
  const parts = [c.urlBefore === c.urlAfter ? `URL ${pathOnly(c.urlAfter)} (unchanged)` : `URL ${pathOnly(c.urlBefore)} -> ${pathOnly(c.urlAfter)}`];
  parts.push(`writes: ${requestList(c.writes)}`);
  if (c.errorResponses.length > 0) parts.push(`error responses: ${requestList(c.errorResponses)}`);
  if (c.pageErrors.count > 0) parts.push(`page errors: ${c.pageErrors.count}`);
  if (c.blankPage) parts.push("page blank");
  if (c.screenChanged !== undefined) parts.push(c.screenChanged ? "screen changed" : "screen unchanged");
  if (c.reload) parts.push(c.reload.targetShown ? "shown after a reload" : "not shown after a reload either");
  if (c.signedInAs) parts.push(`signed in as ${c.signedInAs}`);
  return parts.join("; ");
}

/** Plain-text lines for `aida capture`/`aida inspect --after` (no leading indent). */
export function formatFailureLines(f: FailureReport): string[] {
  const lines = [
    `step: ${f.step ?? "(unknown)"}`,
    `action: ${f.action}`,
    `looks like: ${CATEGORY_LABEL[f.category]}: ${f.reason}`,
    `error: ${f.error}`,
    `url: ${f.url}`,
  ];
  const c = f.changes;
  if (c) {
    lines.push("what changed:");
    lines.push(`  url: ${c.urlBefore === c.urlAfter ? `${c.urlAfter} (unchanged)` : `${c.urlBefore} -> ${c.urlAfter}`}`);
    if (c.expectedPath) lines.push(`  page the walkthrough opened: ${c.expectedPath} (nothing clicked since)`);
    if (c.failedAction) {
      const last = c.lastOkAction ? `, last that worked: #${c.lastOkAction.index} ${c.lastOkAction.do}` : ", none before it worked";
      lines.push(`  failed action: #${c.failedAction.index} ${c.failedAction.do}${last}`);
    }
    lines.push(`  writes: ${requestList(c.writes)}`);
    lines.push(`  error responses: ${requestList(c.errorResponses)}`);
    lines.push(`  page errors: ${c.pageErrors.count}${c.pageErrors.first ? ` (first: ${c.pageErrors.first})` : ""}`);
    lines.push(`  console errors: ${c.consoleErrors.count}${c.consoleErrors.first ? ` (first: ${c.consoleErrors.first})` : ""}`);
    lines.push(`  page blank: ${c.blankPage ? "yes" : "no"}${c.screenChanged === undefined ? "" : `; screen changed after the last click: ${c.screenChanged ? "yes" : "no"}`}`);
    if (c.reload) lines.push(`  after a diagnosis-only reload, the target ${c.reload.targetShown ? "showed up" : "still didn't show"}`);
    if (c.signedInAs) lines.push(`  signed in as: ${c.signedInAs}`);
  }
  if (f.screenshotPath) lines.push(`screenshot: ${f.screenshotPath}`);
  if (f.snapshot) {
    lines.push("snapshot:");
    for (const line of f.snapshot.split("\n")) lines.push(`  ${line}`);
  }
  return lines;
}

function pathOnly(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

async function captureTrimmedSnapshot(page: Page, failingTarget?: Target): Promise<string> {
  try {
    let primary: string;
    const main = page.getByRole("main");
    if ((await main.count().catch(() => 0)) > 0) {
      primary = await main.first().ariaSnapshot();
    } else {
      const landmark = await nearestLandmarkOrDialog(page, failingTarget);
      if (landmark) {
        primary = landmark;
      } else {
        const body = await page.locator("body").ariaSnapshot();
        primary = body.split("\n").length > SNAPSHOT_LINE_CAP ? dropTopLevelLandmarks(body.split("\n"), DROP_FIRST_ROLES).join("\n") : body;
      }
    }

    // Always fold in an open dialog too — it's usually the relevant part — unless it's already
    // what we picked above.
    const dialogSnapshot = await openDialogSnapshot(page);
    const parts = dialogSnapshot && !primary.includes(dialogSnapshot) ? [dialogSnapshot, primary] : [primary];

    // Redact first, then cap: a cut-off JWT or email no longer matches its pattern.
    const passwords = (await page.evaluate(PASSWORD_VALUES_SCRIPT).catch(() => [])) as string[];
    return capLines(redactSnapshotText(parts.join("\n"), passwords));
  } catch (err) {
    return `(could not capture accessibility snapshot: ${redactLine((err as Error).message)})`;
  }
}

async function openDialogSnapshot(page: Page): Promise<string | null> {
  for (const role of DIALOG_ROLES) {
    const loc = page.getByRole(role).filter({ visible: true });
    if ((await loc.count().catch(() => 0)) > 0) return loc.first().ariaSnapshot().catch(() => null);
  }
  return null;
}

/**
 * Finds the nearest landmark/dialog ancestor of either a loose match for the
 * failing target, or (if that can't be resolved) the currently focused
 * element, and returns its aria snapshot. Returns null if neither exists —
 * the caller falls back to `body`.
 */
async function nearestLandmarkOrDialog(page: Page, failingTarget?: Target): Promise<string | null> {
  if (failingTarget) {
    try {
      const loose: Target = { ...failingTarget, exact: false };
      const loc = await locateAll(loose, page);
      if ((await loc.count().catch(() => 0)) > 0) {
        await loc
          .first()
          .evaluate((el, attr) => el.setAttribute(attr, "1"), ANCHOR_ATTR)
          .catch(() => {});
      }
    } catch {
      // the failing target itself can't be resolved at all — fall through to the focused element
    }
  }

  const assigned = await page.evaluate(
    ({ rootAttr, anchorAttr, roles }) => {
      const roleOf = (el: Element): string | null => {
        const explicit = el.getAttribute("role");
        if (explicit) return explicit;
        switch (el.tagName.toLowerCase()) {
          case "dialog":
            return "dialog";
          case "nav":
            return "navigation";
          case "header":
            return "banner";
          case "footer":
            return "contentinfo";
          case "aside":
            return "complementary";
          case "form":
            // A native <form> is only an ARIA landmark when it has an accessible name — the
            // common nameless <form> wrapping a single widget is not one, and treating it as
            // one would stop the walk-up one level too early (e.g. inside a dialog).
            return el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.getAttribute("title")
              ? "form"
              : null;
          case "main":
            return "main";
          default:
            return null;
        }
      };
      const nearestLandmark = (start: Element | null): Element | null => {
        for (let n = start; n; n = n.parentElement) {
          const r = roleOf(n);
          if (r && roles.includes(r)) return n;
        }
        return null;
      };

      const anchorEl = document.querySelector(`[${anchorAttr}]`);
      anchorEl?.removeAttribute(anchorAttr);
      const focusEl = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
      const start = anchorEl ?? focusEl;
      const landmark = start ? nearestLandmark(start) : null;
      if (!landmark) return false;
      landmark.setAttribute(rootAttr, "1");
      return true;
    },
    { rootAttr: ROOT_ATTR, anchorAttr: ANCHOR_ATTR, roles: LANDMARK_ROLES },
  );

  if (!assigned) return null;

  try {
    return await page.locator(`[${ROOT_ATTR}]`).first().ariaSnapshot();
  } finally {
    await page.evaluate((attr) => document.querySelector(`[${attr}]`)?.removeAttribute(attr), ROOT_ATTR).catch(() => {});
  }
}

/** Removes whole top-level landmark subtrees (header line + its indented children) by role name. */
function dropTopLevelLandmarks(lines: string[], roles: string[]): string[] {
  const result: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const isTopLevel = /^- /.test(line);
    if (isTopLevel) {
      const m = line.match(/^- (\w+)/);
      skipping = Boolean(m && roles.includes(m[1]));
      if (skipping) continue;
    } else if (skipping) {
      continue;
    }
    result.push(line);
  }
  return result;
}

function capLines(full: string): string {
  // A long table row or a data URL can make one line huge: cap each line, then the line count.
  const lines = full.split("\n").map((l) => capLine(l));
  if (lines.length <= SNAPSHOT_LINE_CAP) return lines.join("\n");
  return [...lines.slice(0, SNAPSHOT_LINE_CAP), `… (${lines.length - SNAPSHOT_LINE_CAP} more lines trimmed)`].join("\n");
}
