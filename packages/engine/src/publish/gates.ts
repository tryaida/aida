// Gates `aida publish` refuses to deploy past (docs/scope.md "Preview, then publish", "Safety
// and trust"; build-plan.md M13):
//   1. the last `aida build` report.json must exist and be `ok`
//   2. every built page must be publishable (frontmatter `passed: true`)
//   3. a production publish needs a person's prior OK — recorded approval, an interactive
//      confirm, or `--approve --by person`; an agent (detected via env) can never self-approve.
import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { readApproval, writeApproval, type PublishApproval } from "./approval.js";

export interface BuildReportGate {
  ok: boolean;
  reasons: string[];
  report?: { ok: boolean; walkthroughs: Array<{ walkthrough: string; ok: boolean }> };
}

/** Gate 1: the build report at `<buildDir>/report.json` must exist and be `ok`. */
export function checkBuildReport(buildDir: string): BuildReportGate {
  const file = join(buildDir, "report.json");
  if (!existsSync(file)) {
    return { ok: false, reasons: [`no build report at ${file} — run \`aida build\` first`] };
  }
  let report: { ok: boolean; walkthroughs: Array<{ walkthrough: string; ok: boolean }> };
  try {
    report = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { ok: false, reasons: [`could not read ${file}: ${(err as Error).message}`] };
  }
  if (!report.ok) {
    const failed = (report.walkthroughs ?? []).filter((w) => !w.ok).map((w) => w.walkthrough);
    return {
      ok: false,
      reasons: [`last \`aida build\` did not pass${failed.length ? ` (failed: ${failed.join(", ")})` : ""}`],
      report,
    };
  }
  return { ok: true, reasons: [], report };
}

export interface PagesGate {
  ok: boolean;
  reasons: string[];
  checked: number;
}

/** Gate 2: every page under `<helpRoot>/content/docs` that carries engine frontmatter must be
 * `passed: true` (pages/content.ts's `buildFrontmatterBlock`). Hand-authored pages with no
 * `passed` field (no `walkthrough:` key) are left alone — only generated pages are checked. */
export function checkPagesPublishable(helpRoot: string): PagesGate {
  const docsDir = join(helpRoot, "content", "docs");
  if (!existsSync(docsDir)) return { ok: true, reasons: [], checked: 0 };

  const reasons: string[] = [];
  let checked = 0;
  const walk = (dir: string): void => {
    for (const entry of readDirSafe(dir)) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".mdx")) {
        const text = readFileSync(full, "utf8");
        if (!/^walkthrough:/m.test(text)) continue; // hand-authored page, not engine output
        checked += 1;
        if (/^passed:\s*false/m.test(text)) {
          reasons.push(`${full.slice(helpRoot.length + 1)} is not publishable (passed: false)`);
        }
      }
    }
  };
  walk(docsDir);
  return { ok: reasons.length === 0, reasons, checked };
}

function readDirSafe(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Detects a coding-agent environment (Claude Code, Codex) by its own env vars — used to refuse
 * the first production publish's approval gate outright (an agent can never self-approve, with
 * or without `--approve`/TTY); never to block anything else a person's own terminal does. */
export function isAgentEnv(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.CLAUDECODE || env.CODEX || env.CODEX_SANDBOX || env.CLAUDE_CODE_ENTRYPOINT);
}

export interface ApprovalGateOptions {
  prod: boolean;
  host: string;
  /** `--approve` flag. */
  approve?: boolean;
  /** `--by <who>` accompanying `--approve`. */
  approveBy?: string;
  isTTY: boolean;
  env?: Record<string, string | undefined>;
  /** Injected for tests; defaults to an interactive `readline` prompt. */
  confirm?: () => Promise<boolean>;
}

export interface ApprovalGateResult {
  ok: boolean;
  reasons: string[];
  warning?: string;
  approval?: PublishApproval;
  /** Set when this call recorded a brand-new approval (so the caller can report it). */
  recorded?: boolean;
}

/** Gate 3, production only (docs/scope.md "First publish. Always approved by a person."). A
 * preview publish (`prod: false`) always passes this gate — only production needs the OK.
 *
 * An agent can never self-approve — not with `--approve --by person`, not interactively, TTY or
 * no TTY. The only valid approval paths are: a person confirming interactively on their own TTY,
 * a person running `--approve --by person` themselves from a non-agent environment, or an
 * approval a person already recorded earlier (checked first, above). */
export async function checkApproval(helpRoot: string, opts: ApprovalGateOptions): Promise<ApprovalGateResult> {
  if (!opts.prod) return { ok: true, reasons: [] };

  const existing = readApproval(helpRoot);
  if (existing) return { ok: true, reasons: [], approval: existing };

  const env = opts.env ?? process.env;
  const agent = isAgentEnv(env);
  const askPersonCommand = `aida publish --to ${opts.host} --prod --approve --by person`;

  if (opts.approve && opts.approveBy !== "person") {
    return {
      ok: false,
      reasons: ['--approve requires --by person — an agent must not self-approve the first production publish'],
    };
  }

  // Refuse unconditionally in an agent environment, regardless of `--approve`/`--by` or TTY —
  // a coding agent must never be the one recording that a person signed off.
  if (agent) {
    return {
      ok: false,
      reasons: [
        `an agent environment (CLAUDECODE/CODEX) must not approve the first production publish — ask the person to run \`${askPersonCommand}\` themselves, from their own terminal.`,
      ],
    };
  }

  if (opts.approve) {
    const approval: PublishApproval = { by: "person", at: new Date().toISOString(), host: opts.host };
    writeApproval(helpRoot, approval);
    return { ok: true, reasons: [], approval, recorded: true };
  }

  if (!opts.isTTY) {
    return {
      ok: false,
      reasons: [
        `no prior approval and no TTY to confirm interactively — run \`${askPersonCommand}\` once a person has signed off, or re-run interactively on a TTY.`,
      ],
    };
  }

  if (opts.confirm) {
    const confirmed = await opts.confirm();
    if (!confirmed) return { ok: false, reasons: ["publish not approved"] };
    const approval: PublishApproval = { by: "person", at: new Date().toISOString(), host: opts.host };
    writeApproval(helpRoot, approval);
    return { ok: true, reasons: [], approval, recorded: true };
  }

  return { ok: false, reasons: ["no prior approval and no confirm handler available"] };
}
