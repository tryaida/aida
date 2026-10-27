// Assembles `aida build`'s run report (`<buildDir>/report.json` + terse text) and checks it
// against `config.budget` (docs/scope.md "Caching and budgets": "stops at the per-run budget
// cap"). See build-plan.md M6.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { ResolvedConfig } from "../config/index.js";
import { reportUsage } from "../usage/index.js";
import type { BuildFailure, BuildReport, BuildStageName, ModelsUsageSection, StageResult, WalkthroughBuildResult } from "./types.js";

/**
 * `since`, usually a run's start time, restricts the ledger to entries from this run — the
 * ledger file accumulates across every build in a build dir (docs/scope.md "Caching and
 * budgets": "stops at the per-run budget cap"). Omit to report the whole ledger (e.g. `aida
 * usage report`, which looks at everything on purpose).
 */
export function buildModelsSection(buildDir: string, since?: string): ModelsUsageSection {
  const usage = reportUsage(buildDir, since);
  return {
    totals: usage.totals.map((t) => ({ ...t })),
    totalCostUsd: usage.totalCostUsd,
    totalTokens: usage.totalTokens,
  };
}

/** `voiceCostUsd` (this run's voice-synthesis spend) counts toward the USD budget alongside
 * model cost — a paid voice provider is spend just like a model call. */
export function checkBudget(config: ResolvedConfig, models: ModelsUsageSection, voiceCostUsd = 0): BuildReport["budget"] {
  const budget = config.budget;
  if (!budget || (budget.usd === undefined && budget.tokens === undefined)) return undefined;
  const reasons: string[] = [];
  const totalCostUsd = models.totalCostUsd + voiceCostUsd;
  if (budget.usd !== undefined && totalCostUsd > budget.usd) {
    reasons.push(`cost $${totalCostUsd.toFixed(4)} (models $${models.totalCostUsd.toFixed(4)} + voice $${voiceCostUsd.toFixed(4)}) exceeds budget $${budget.usd.toFixed(2)}`);
  }
  if (budget.tokens !== undefined && models.totalTokens > budget.tokens) {
    reasons.push(`${models.totalTokens} tokens exceeds budget ${budget.tokens}`);
  }
  return { usd: budget.usd, tokens: budget.tokens, exceeded: reasons.length > 0, reasons };
}

export function assembleReport(
  config: ResolvedConfig,
  draft: boolean,
  walkthroughs: WalkthroughBuildResult[],
  index: (StageResult & { searchIndexFile?: string; llmsTxtFile?: string; pageCount?: number }) | undefined,
  /** This run's start time (ISO) — restricts `models` to entries recorded during this run only. */
  runStartedAt?: string,
  /** Set when the run stopped early (capture refused, a crash): the report fails with it. */
  error?: string,
): BuildReport {
  const models = buildModelsSection(config.buildDir, runStartedAt);
  const voice = walkthroughs.reduce(
    (sum, w) => ({
      charsBilled: sum.charsBilled + (w.voice?.charsBilled ?? 0),
      costUsd: sum.costUsd + (w.voice?.costUsd ?? 0),
    }),
    { charsBilled: 0, costUsd: 0 },
  );
  const budget = checkBudget(config, models, voice.costUsd);
  const ok = !error && walkthroughs.every((w) => w.ok) && (!index || index.status !== "failed") && !(budget?.exceeded);

  return {
    generatedAt: new Date().toISOString(),
    configPath: config.configDir,
    draft,
    walkthroughs,
    index,
    models,
    voice,
    budget,
    ok,
    ...(error ? { error } : {}),
  };
}

export function writeReport(buildDir: string, report: BuildReport): string {
  const file = join(buildDir, "report.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

function stageLine(name: BuildStageName, s: StageResult | undefined): string {
  if (!s) return `    ${name}: (not run)`;
  const tag = s.status === "ok" ? "ok" : s.status === "skipped" ? "skip" : s.status === "not-selected" ? "n/a" : "FAIL";
  const detail = s.detail ? ` — ${s.detail}` : "";
  return `    ${name}: ${tag} (${s.ms}ms)${detail}`;
}

/** `add-session: qa captions:line-length (3 problems) — .build/add-session/qa.json`, then the first problem. */
function failureLines(walkthrough: string, f: BuildFailure): string[] {
  const files = f.files.map((file) => relative(process.cwd(), file) || file).join(", ");
  const head = `    ${walkthrough}: ${f.stage} ${f.check} (${f.count} problem${f.count === 1 ? "" : "s"})${files ? ` — ${files}` : ""}`;
  const lines = f.problems[0] ? [head, `      ${f.problems[0]}`] : [head];
  // Decision 30: say when a capture failure looks like the app or the setup, not the walkthrough.
  if (f.category === "app") lines.push(`      possible app bug (not a docs problem): ${f.reason ?? ""}`);
  else if (f.category === "environment") lines.push(`      looks like a setup problem, not the walkthrough: ${f.reason ?? ""}`);
  return lines;
}

/** Terse text report, for CLI default output (agents/humans get `--json` for the full report.json). */
export function formatReport(report: BuildReport): string {
  const lines: string[] = [`aida build — ${report.ok ? "OK" : "FAILED"} (${report.draft ? "draft" : "full"})`];
  if (report.error) lines.push(`  stopped: ${report.error.split("\n")[0]}`);
  for (const w of report.walkthroughs) {
    lines.push(`  ${w.walkthrough}: ${w.ok ? "ok" : "FAILED"}`);
    for (const stage of ["capture", "voice", "render", "pages", "qa"] as BuildStageName[]) {
      lines.push(stageLine(stage, w.stages[stage]));
    }
    for (const f of w.failures ?? []) lines.push(...failureLines(w.walkthrough, f));
  }
  if (report.index) {
    lines.push(`  index: ${stageLine("index", report.index).trim()}`);
  }
  if (report.models.totals.length > 0) {
    lines.push("  models:");
    for (const t of report.models.totals) {
      lines.push(`    ${t.model} (${t.tier}): ${t.calls} call(s), ${t.input + t.output} tok, $${t.costUsd.toFixed(4)}`);
    }
    lines.push(`    total: $${report.models.totalCostUsd.toFixed(4)}, ${report.models.totalTokens} tok`);
  }
  if (report.voice.charsBilled > 0 || report.voice.costUsd > 0) {
    lines.push(`  voice: ${report.voice.charsBilled} chars billed, $${report.voice.costUsd.toFixed(4)}`);
  }
  if (report.budget) {
    lines.push(
      report.budget.exceeded
        ? `  BUDGET EXCEEDED: ${report.budget.reasons.join("; ")}`
        : "  budget: within limits",
    );
  }
  return lines.join("\n");
}
