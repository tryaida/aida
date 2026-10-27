// `aida build [walkthrough...]`: the one-command build (docs/scope.md "Pipeline",
// build-plan.md M6 gate). Runs capture -> voice -> render -> pages per walkthrough, then index,
// then qa; writes `<buildDir>/report.json`; exits 2 when the run exceeds `config.budget`.
import { loadConfig } from "../config/index.js";
import type { BuildStageName } from "../build/index.js";
import { ALL_STAGES, assembleReport, formatReport, runPipeline, writeReport } from "../build/index.js";
import type { WalkthroughBuildResult } from "../build/types.js";

export interface RunBuildOptions {
  configPath: string;
  walkthroughIds: string[];
  draft?: boolean;
  only?: string;
  skipCapture?: boolean;
  noReset?: boolean;
  withDeps?: boolean;
}

function parseOnly(only: string | undefined): BuildStageName[] | undefined {
  if (!only) return undefined;
  const requested = only.split(",").map((s) => s.trim());
  const valid = new Set(ALL_STAGES as string[]);
  for (const r of requested) {
    if (!valid.has(r)) throw new Error(`unknown build stage "${r}" — valid: ${ALL_STAGES.join(", ")}`);
  }
  return requested as BuildStageName[];
}

export async function runBuild(opts: RunBuildOptions, json: boolean): Promise<number> {
  const config = await loadConfig(opts.configPath);

  // Every way out of a build from here writes report.json: an older `ok: true` report must never
  // be left to pass `aida publish`'s first gate (publish/gates.ts) after a run that stopped.
  const runStartedAt = new Date().toISOString();
  const failedReport = (error: string, walkthroughs: WalkthroughBuildResult[] = []): string =>
    writeReport(config.buildDir, assembleReport(config, Boolean(opts.draft), walkthroughs, undefined, runStartedAt, error));

  let pipeline: Awaited<ReturnType<typeof runPipeline>>;
  try {
    pipeline = await runPipeline(config, {
      configPath: opts.configPath,
      walkthroughIds: opts.walkthroughIds,
      draft: opts.draft,
      only: parseOnly(opts.only),
      skipCapture: opts.skipCapture,
      noReset: opts.noReset,
      withDeps: opts.withDeps,
      json,
    });
  } catch (err) {
    failedReport(`aida build stopped: ${((err as Error).message ?? String(err)).split("\n")[0]}`);
    throw err;
  }

  // The capture safety gate (src/safety) stopped the whole run before any browser opened. The
  // report still lists each walkthrough's text problems, which are checked first.
  if (pipeline.refused) {
    const err = pipeline.refused;
    const reportFile = failedReport(err.message, pipeline.walkthroughs);
    if (json) console.log(JSON.stringify({ ok: false, error: err.message, database: err.check, reportFile, walkthroughs: pipeline.walkthroughs }));
    else {
      console.error(err.message);
      for (const w of pipeline.walkthroughs) for (const f of w.failures ?? []) console.error(`  ${w.walkthrough}: ${f.check}: ${f.problems[0] ?? ""}`);
      console.error(`report: ${reportFile}`);
    }
    return 1;
  }
  const { walkthroughs, index, indexStage } = pipeline;

  const report = assembleReport(
    config,
    Boolean(opts.draft),
    walkthroughs,
    index ? { ...index, ...indexStage } : indexStage,
    pipeline.runStartedAt,
  );
  const reportFile = writeReport(config.buildDir, report);

  if (json) {
    console.log(JSON.stringify({ ...report, reportFile }));
  } else {
    console.log(formatReport(report));
    console.log(`report: ${reportFile}`);
  }

  if (report.budget?.exceeded) return 2;
  return report.ok ? 0 : 1;
}
