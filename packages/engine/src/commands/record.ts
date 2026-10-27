// `aida record <id> --config <cfg> [--page /path] [--as role] [--needs state...]`: opens the app
// in a browser window, signed in, and turns one click-through into a draft walkthrough
// (docs/scope.md, the "Show me" recorder).
//
// The window is the capture runner's own, so recording starts exactly where a capture would: the
// same safety gate first (decisions #27), the same sign-in and saved session, the walkthrough's
// `needs` made true by their setup hooks, the same viewport and locale. The run stops after an
// empty first step and hands the live page to the recorder (record/session.ts) instead of
// replaying anything.
//
// Recording really writes — the person saves things — so it's held to capture's write guard too.
// Afterwards the draft is replayed once, headless and unrecorded, so the person learns straight
// away whether it works (`--no-replay` skips that, since it saves the same things again).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Page } from "playwright";
import { loadConfig } from "../config/index.js";
import type { ResolvedConfig } from "../config/index.js";
import { loadWalkthroughFile, newRunId } from "../walkthrough/index.js";
import type { Persona, Walkthrough } from "../walkthrough/index.js";
import { assertWritesAllowed, formatFailureLines, runCapture, runLevelFailure } from "../capture/index.js";
import type { FailureReport } from "../capture/index.js";
import { captureSafetyRefusal } from "../safety/index.js";
import { loadRunWalkthroughs, personaLookup } from "../states/index.js";
import { Recorder, buildSteps, draftYaml } from "../record/index.js";
import type { RecordedAction } from "../record/index.js";
import { resolvePersona, storageStateKey } from "./inspect.js";

export interface RunRecordOptions {
  configPath: string;
  /** The new walkthrough's id: its file is `<walkthroughsDir>/<id>.yaml`. */
  id: string;
  /** Page to start on. Default `/`. */
  page?: string;
  as?: string;
  needs?: string[];
  title?: string;
  section?: string;
  force?: boolean;
  /** Default true: replay the draft once after saving it. */
  replay?: boolean;
  json?: boolean;
  /** Default false (a window the person clicks in). Tests record headless with `drive`. */
  headless?: boolean;
  /** Does the clicking instead of a person (tests). Recording finishes when it resolves. */
  drive?: (page: Page, recorder: Recorder) => Promise<void>;
}

export interface RecordResult {
  ok: boolean;
  draft?: string;
  steps?: number;
  unverified?: number;
  swapped?: string[];
  todos?: number;
  replay?: { ok: boolean; failure?: FailureReport };
  error?: string;
}

const RECORD_STEP = "__record";

function humanTitle(id: string): string {
  const words = id.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function print(result: RecordResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result));
    return;
  }
  if (!result.ok && !result.draft) {
    console.error(`record failed: ${result.error}`);
    return;
  }
  console.log(`recorded ${result.steps} step(s) -> ${result.draft}`);
  if (result.unverified) console.log(`  ${result.unverified} target(s) to check: the recorder couldn't confirm them on the page (marked TODO)`);
  if (result.swapped?.length) console.log(`  swapped for safe demo values: ${result.swapped.join("; ")}`);
  if (result.todos) console.log(`  ${result.todos} TODO comment(s) in the draft`);
  if (result.replay?.ok) console.log("  replayed once: every step passed");
  else if (result.replay?.failure) {
    console.log("  replayed once: it stopped — the draft is saved; fix it, then `aida capture` it");
    for (const line of formatFailureLines(result.replay.failure)) console.log(`    ${line}`);
  }
  console.log("next: rewrite titles and narration (or run the aida-write skill), then `aida capture`");
}

function personaFor(config: ResolvedConfig, as: string | undefined): Persona | undefined {
  try {
    return resolvePersona(config.walkthroughsDir, as);
  } catch {
    // No walkthrough signs in as this role yet: this one will be the first.
    return as ? { role: as } : undefined;
  }
}

function lookup(config: ResolvedConfig): ((role: string) => Persona | undefined) | undefined {
  try {
    return personaLookup(loadRunWalkthroughs(config.walkthroughsDir).map((w) => w.walkthrough));
  } catch {
    return undefined;
  }
}

/** Runs `aida record`. Returns 0 when the draft is saved (and, unless skipped, its replay passed). */
export async function runRecordCommand(opts: RunRecordOptions): Promise<number> {
  const json = Boolean(opts.json);
  const fail = (error: string): number => {
    print({ ok: false, error }, json);
    return 1;
  };

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(opts.id)) return fail(`walkthrough id "${opts.id}" must be lowercase words joined by hyphens, e.g. add-a-competitor`);
  const startPage = opts.page ?? "/";
  if (!startPage.startsWith("/")) return fail(`--page must be a path on the app, starting with "/" (got "${startPage}")`);

  const config = await loadConfig(opts.configPath);
  const outFile = join(config.walkthroughsDir, `${opts.id}.yaml`);
  if (existsSync(outFile) && !opts.force) return fail(`"${outFile}" already exists — pass --force to overwrite it`);

  const refusal = await captureSafetyRefusal(config);
  if (refusal) return fail(refusal.error);
  try {
    assertWritesAllowed(config.app.baseUrl, config.allowWrites);
  } catch (err) {
    return fail((err as Error).message);
  }

  const persona = personaFor(config, opts.as);
  const skeleton: Walkthrough = {
    walkthrough: opts.id,
    title: opts.title ?? humanTitle(opts.id),
    start: { page: startPage, ...(persona ? { persona } : {}) },
    ...(opts.needs?.length ? { needs: opts.needs } : {}),
    steps: [{ id: RECORD_STEP, actions: [] }],
  };
  const storageStatePath = join(config.buildDir, ".aida-session", `storageState-${storageStateKey(config.app.baseUrl, persona)}.json`);
  const log = json ? undefined : (line: string): void => console.error(`  ● ${line}`);

  let recorded: RecordedAction[] | undefined;
  let failure: FailureReport | undefined;
  try {
    const result = await runCapture({
      walkthrough: skeleton,
      config,
      outDir: join(config.buildDir, opts.id, "record"),
      storageStatePath,
      runId: process.env.AIDA_RUN_ID || newRunId(),
      personaFor: lookup(config),
      stopAfterStep: RECORD_STEP,
      record: false,
      headless: opts.headless ?? false,
      log: json ? undefined : (...a: unknown[]) => console.error("[record]", ...a),
      onStopped: async (page) => {
        const recorder = await Recorder.attach(page.context(), page, { log });
        const stop = (): void => recorder.finish();
        process.once("SIGINT", stop);
        try {
          if (opts.drive) {
            await opts.drive(page, recorder);
            recorder.finish();
          } else {
            if (!json) {
              console.error(`recording ${opts.id} in the browser window: use the app as a reader would.`);
              console.error("  the toolbar at the bottom: Point at, Check shown, Note, New step, Undo, Finish.");
              console.error("  Finish (or close the window, or Ctrl-C here) saves the draft.");
            }
            await recorder.done;
          }
          recorded = await recorder.actions();
        } finally {
          process.removeListener("SIGINT", stop);
        }
      },
    });
    failure = result.failure;
  } catch (err) {
    failure = runLevelFailure(err);
  }

  if (failure && !recorded) {
    if (json) console.log(JSON.stringify({ ok: false, error: failure.error, failure }));
    else {
      console.error("record failed before the window was ready:");
      for (const line of formatFailureLines(failure)) console.error(`  ${line}`);
    }
    return 1;
  }

  const built = buildSteps(recorded ?? [], { locale: config.locale });
  if (built.steps.length === 0) return fail("nothing was recorded, so no draft was written");

  const yaml = draftYaml(
    {
      id: opts.id,
      title: skeleton.title,
      startPage,
      persona,
      needs: opts.needs,
      section: opts.section,
      recordedOn: new Date().toISOString().slice(0, 10),
    },
    built,
  );
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, yaml, "utf8");

  const result: RecordResult = {
    ok: true,
    draft: outFile,
    steps: built.steps.length,
    unverified: built.unverified,
    swapped: built.swapped,
    todos: (yaml.match(/# TODO/g) ?? []).length,
  };

  if (opts.replay !== false) {
    const walkthrough = loadWalkthroughFile(outFile);
    let replayFailure: FailureReport | undefined;
    let ok = false;
    try {
      const replay = await runCapture({
        walkthrough,
        config,
        outDir: join(config.buildDir, opts.id, "record-check"),
        storageStatePath,
        runId: process.env.AIDA_RUN_ID || newRunId(),
        personaFor: lookup(config),
        record: false,
        log: json ? undefined : (...a: unknown[]) => console.error("[replay]", ...a),
      });
      replayFailure = replay.failure;
      ok = !replay.failure && replay.validation.steps.every((s) => s.ok);
    } catch (err) {
      replayFailure = runLevelFailure(err);
    }
    result.replay = { ok, ...(replayFailure ? { failure: replayFailure } : {}) };
    result.ok = ok;
  }

  print(result, json);
  return result.ok ? 0 : 1;
}
