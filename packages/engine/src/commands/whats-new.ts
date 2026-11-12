// `aida whats-new [--since <ref>] [--from-github]` (build-plan.md M21 step 4), and with `--video`
// the release's "what changed" video on the same page (decision 45; M48).
import { join, dirname, resolve } from "node:path";
import { loadConfig, resolveCaptureSettings, type ResolvedConfig } from "../config/index.js";
import { createNodeCommandRunner, type CommandRunner } from "../publish/index.js";
import { buildWhatsNew } from "../whats-new/index.js";
import { buildReleaseVideo, type CardNarrator, type ReleaseVideoResult } from "../whats-new/release-video.js";
import { refLooksSafe, resolveCommit } from "../whats-new/changes.js";
import { readManifest } from "../versions/index.js";
import { computeAffected } from "../impact/index.js";
import { getProvider, narrate } from "../voice/index.js";
import { DEFAULT_CACHE_DIR } from "../voice/cache.js";
import { voiceFitForConfig } from "../voice/fit.js";
import { DEFAULT_LANG } from "../config/types.js";

export interface RunWhatsNewOptions {
  configPath: string;
  since?: string;
  fromGithub?: boolean;
  appRepo?: string;
  /** Also build the release video (M48). */
  video?: boolean;
  /** Git ref the video measures changes from; default `since`, then the last frozen version's. */
  base?: string;
  /** Version name for the video's opening card; default the date of the app repo's latest commit. */
  release?: string;
  maxGuides?: number;
  maxSteps?: number;
  /** Cut the draft segments (`aida build --draft`). */
  draft?: boolean;
}

/** The cards' spoken lines through `config.voice`, as `aida voice` narrates a walkthrough. */
export function configCardNarrator(config: ResolvedConfig): CardNarrator {
  return async (lines) => {
    const providerName = config.voice?.provider ?? "kokoro";
    const fit = voiceFitForConfig(config, providerName);
    const report = await narrate(lines, getProvider(providerName), {
      model: config.voice?.model,
      voice: config.voice?.voiceId ?? fit?.voice,
      speed: config.voice?.speed ?? fit?.speed,
      pronunciation: config.voice?.pronunciation,
      cacheDir: join(config.configDir, DEFAULT_CACHE_DIR),
    });
    return Object.fromEntries(report.results.map((r) => [r.id, { audioPath: r.audioPath, durationMs: r.durationMs }]));
  };
}

/** "11 November 2026": the app repo's latest commit date, so the same repo state always gives
 * the same card (and an unchanged video stays unchanged); today's date when git can't say. */
async function latestChangeDate(runner: CommandRunner, appRepo: string, lang: string): Promise<string> {
  let date = new Date();
  const out = await runner("git", ["log", "-1", "--format=%cI", "HEAD"], { cwd: appRepo }).catch(() => undefined);
  if (out && out.code === 0 && !Number.isNaN(Date.parse(out.stdout.trim()))) date = new Date(out.stdout.trim());
  try {
    return new Intl.DateTimeFormat(lang, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function lastFrozenRef(helpApp: string): string | undefined {
  const manifest = readManifest(join(helpApp, "public"));
  return manifest?.versions[manifest.versions.length - 1]?.gitRef;
}

const RULE_WORDS: Record<string, string> = { screenshots: "screenshots changed", new: "new guide", impact: "impact map" };

/** The video's part of the default (non-JSON) output: a few lines. */
function videoSummary(v: ReleaseVideoResult): string[] {
  const lines = [`${v.ok ? "" : "video not published: "}${v.message}`];
  if (v.urls && (v.status === "written" || v.status === "unchanged")) lines[0] += ` -> ${v.urls.src}`;
  for (const g of v.guides) lines.push(`  ${g.id}: steps ${g.steps.join(", ")} (${RULE_WORDS[g.rule]}: ${g.reason})`);
  for (const l of v.leftOut) lines.push(`  left out: ${l.id}${l.steps.length > 0 ? ` steps ${l.steps.join(", ")}` : ""} (${l.reason})`);
  for (const m of (v.missing ?? []).slice(0, 5)) lines.push(`  no current segment: ${m.id} step ${m.step} (${m.stepId})`);
  for (const s of v.stale ?? []) lines.push(`  changed since its last build: ${s.id} (${s.reason})`);
  for (const p of (v.qa?.ok === false ? v.qa.problems : []).slice(0, 5)) lines.push(`  QA: ${p}`);
  if (v.qa?.ok === false) lines.push(`  full QA report: ${v.qa.file}`);
  if (v.excluded.length > 0) lines.push(`  not considered: ${v.excluded.map((e) => `${e.id} (${e.reason})`).join(", ")}`);
  for (const g of v.guides) if (g.reason.includes("matched by position")) lines.push(`  note: ${g.id}'s steps were matched to ${v.base} by position, not by step id`);
  return lines;
}

/**
 * Runs `aida whats-new`. The app repo scanned for merge history is `--app-repo`, then
 * `config.impact.appRepo`, then the directory the config file lives in — never `process.cwd()`,
 * so this works the same from the app repo root or from CI with an absolute `--config` path.
 */
export async function runWhatsNew(opts: RunWhatsNewOptions, json: boolean): Promise<number> {
  let config;
  try {
    config = await loadConfig(opts.configPath);
  } catch (err) {
    const message = (err as Error).message;
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`whats-new failed: ${message}`);
    return 1;
  }

  if (!config.helpApp) {
    const message = "config.helpApp is not set — whats-new writes content/docs/whats-new/index.mdx into a help app";
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`whats-new failed: ${message}`);
    return 1;
  }

  const appRepo = opts.appRepo ?? config.impact?.appRepo ?? dirname(resolve(opts.configPath));
  const runner = createNodeCommandRunner();

  // Refs from flags or a frozen version's record reach git: one starting with "-" would be read
  // as an option (`--output=<file>` writes a file), so it never gets that far.
  const base = opts.video ? (opts.base ?? opts.since ?? lastFrozenRef(config.helpApp)) : undefined;
  for (const [flag, ref] of [["--since", opts.since], ["--base", base]] as const) {
    if (ref !== undefined && !refLooksSafe(ref)) {
      const message = `${flag} "${ref}" can't be a git ref`;
      if (json) console.log(JSON.stringify({ ok: false, error: message }));
      else console.error(`whats-new failed: ${message}`);
      return 1;
    }
  }

  try {
    let video: ReleaseVideoResult | undefined;
    if (opts.video) {
      const lang = config.lang ?? DEFAULT_LANG;
      const loaded = config;
      const captureSettings = resolveCaptureSettings(loaded.capture);
      video = await buildReleaseVideo({
        config: loaded,
        base,
        release: opts.release,
        dateLabel: await latestChangeDate(runner, appRepo, lang),
        maxGuides: opts.maxGuides,
        maxStepsPerGuide: opts.maxSteps,
        draft: opts.draft,
        tolerance: captureSettings.frameDiffTolerance,
        threshold: captureSettings.frameDiffThreshold,
        narrate: configCardNarrator(loaded),
        affected: base
          ? async () => {
              // The impact map runs git in the app repo: only with a ref that names a commit there.
              if (!resolveCommit(appRepo, base)) return undefined;
              const r = await computeAffected({ appRepo, base, config: loaded, app: loaded.impact?.app });
              const ids = r.all ? r.walkthroughs.map((w) => w.id) : r.walkthroughs.filter((w) => w.affected).map((w) => w.id);
              return { ids, ...(r.all ? { note: r.reason ?? "it can't tell which guides, so it counts every one" } : {}) };
            }
          : undefined,
      });
    }

    const result = await buildWhatsNew({
      appRepo,
      helpApp: config.helpApp,
      since: opts.since,
      fromGithub: opts.fromGithub,
      runner,
      ...(video ? { videoBlock: video.block } : {}),
    });

    const ok = !video || video.ok;
    if (json) {
      console.log(JSON.stringify({ ok, ...result, ...(video ? { video: { ...video, block: undefined } } : {}) }));
    } else {
      console.log(`wrote ${result.pageFile} (${result.entryCount} entr${result.entryCount === 1 ? "y" : "ies"}, ${result.skippedCount} filtered out)${result.since ? ` since ${result.since}` : ""}`);
      for (const s of result.suggestions) console.log(`note: ${s.message}`);
      if (video) for (const line of videoSummary(video)) (video.ok ? console.log : console.error)(line);
    }
    return ok ? 0 : 1;
  } catch (err) {
    const message = (err as Error).message;
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`whats-new failed: ${message}`);
    return 1;
  }
}
