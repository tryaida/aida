// `aida inspect <path> --config <cfg>`: opens one app page signed in, then prints a compact
// map of what a walkthrough author needs — role/name/required/disabled/select-options for every
// interactive element in the main landmark (or open dialog) — without the author (or an agent)
// reading the app's source. Read-only: the only clicks it ever makes are `--click` (repeatable,
// run in order), restricted to button/menuitem/tab and refusing submit-shaped names (see
// inspect/click.ts).
//
// `aida inspect --walkthrough <file-or-id> --after <stepId>` (M28) is the one mode that writes:
// it replays the walkthrough's real actions up to and including that step through the capture
// runner itself (no frames, no screenshots), then scans the page the step left, so a writer sees
// the screen after a save instead of guessing. Same safety gate as capture. `--after
// <pathId>/<stepId>` (M35) replays one of the walkthrough's other ways in up to that step.
//
// Reuses capture's own building blocks rather than re-implementing them: `config.signIn` (the
// same adapter capture uses) and a session file under `config.buildDir/.aida-session` keyed
// the same way commands/capture.ts keys it, so a session capture already signed in with is
// reused here too; `assertWritesAllowed`/`isLocalBaseUrl` (capture/write-guard.ts) gate the one
// write-shaped thing inspect can do (`--click`), the same way capture gates click/type/select.
import { sessionKey } from "../capture/session-key.js";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import { NAME_SHIM_SCRIPT } from "../capture/init-scripts.js";
import { gotoReady } from "../capture/page-ready.js";
import type { Browser, BrowserContext, Page } from "playwright";
import { loadConfig } from "../config/index.js";
import type { ResolvedConfig } from "../config/index.js";
import { DEFAULT_CAPTURE_LOCALE, DEFAULT_CAPTURE_TIMEZONE } from "../config/types.js";
import { loadWalkthroughFile, newRunId } from "../walkthrough/index.js";
import type { Persona, Walkthrough } from "../walkthrough/index.js";
import { formatFailureLines, isLocalBaseUrl, isSignInPath, runCapture, runLevelFailure } from "../capture/index.js";
import type { FailureReport } from "../capture/index.js";
import { captureSafetyRefusal } from "../safety/index.js";
import { loadRunWalkthroughs, personaLookup } from "../states/index.js";
import { resolveAfterTarget } from "../inspect/after.js";
import { scanPage, clickToOpen, checkToReveal, selectOption, InspectClickRefusedError } from "../inspect/index.js";
import type { ClickOutcome, InspectResult } from "../inspect/index.js";

export interface RunInspectOptions {
  configPath: string;
  /** The page to open. Not used with `walkthrough`/`after`, which start at the walkthrough's page. */
  path?: string;
  as?: string;
  area?: string;
  /** Clicked in order before the scan (one name or several). */
  click?: string | string[];
  check?: string;
  /** `[field, option]` — see inspect/click.ts's `selectOption`. */
  select?: [string, string];
  /** `--walkthrough <file-or-id>`: replay this walkthrough, with `after`. */
  walkthrough?: string;
  /** `--after <stepId>`: replay up to and including this step, then scan. `<pathId>/<stepId>`
   * replays that path instead: its start page, its opening steps, then the main steps from `joins`. */
  after?: string;
  /** Caps every wait while replaying (tests and quick probes). */
  maxWaitMs?: number;
  /** `--lines <n>`: lines to print (default 80; 0 prints them all). */
  lines?: number;
  /** `--skip <n>`: lines to skip from the top, to read a long page a window at a time. */
  skip?: number;
}

/**
 * The write block behind `aida inspect`. Installed on the browser context as soon as it is
 * created, before any navigation, so nothing a page does on load gets past it: every non-GET
 * request is aborted, and every WebSocket the page opens is routed through here from the start.
 *
 * `passThrough` is on only while writes are intended — signing in, and `--after`'s replay — and
 * is switched off before `--click`/`--check`/`--select` and the scan. Each request and each
 * WebSocket message is decided by the flag at the moment it is sent, so a socket opened while
 * writes were allowed (during the replay, say) can't send anything once they're not. The page
 * still receives what the server sends, so live screens keep rendering.
 *
 * On the whole context, so a popup's requests are blocked too; inspect contexts block service
 * workers, whose requests a context route wouldn't see.
 */
interface WriteGate {
  passThrough: boolean;
}

async function installWriteGate(context: BrowserContext, gate: WriteGate): Promise<void> {
  await context.route("**/*", (route) => {
    if (gate.passThrough || route.request().method() === "GET") return route.continue();
    return route.abort();
  });
  await context.routeWebSocket(/.*/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      if (gate.passThrough) server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });
}

/** Same baseUrl + persona + sign-in adapter -> session-file hash every command uses
 * (capture/session-key.ts), so a session one command signs in is reused by the others, and a
 * changed sign-in adapter signs in again. */
export function storageStateKey(
  baseUrl: string,
  persona: Persona | undefined,
  config?: Partial<Pick<ResolvedConfig, "signIn" | "signInHash">>,
): string {
  return sessionKey(baseUrl, persona, config);
}

/** Finds a persona to sign in as: `--as <role>` matches a walkthrough whose `start.persona.role`
 * or `start.signed_in_as` equals it; with no `--as`, the first walkthrough with any persona at
 * all. `undefined` when the walkthroughs dir has nothing usable (inspect still runs — a page
 * that needs no sign-in works fine with no persona). A role no walkthrough uses yet but the
 * config names (`roles`, `readers`) signs in as `{ role }`, so the first walkthrough for a role
 * can be written from what inspect shows. */
export function resolvePersona(walkthroughsDir: string, as: string | undefined, knownRoles: string[] = []): Persona | undefined {
  let files: string[] = [];
  try {
    files = readdirSync(walkthroughsDir)
      .filter((f) => /\.(ya?ml)$/i.test(f))
      .map((f) => join(walkthroughsDir, f))
      .sort();
  } catch {
    return undefined;
  }

  for (const file of files) {
    let wt;
    try {
      wt = loadWalkthroughFile(file);
    } catch {
      continue;
    }
    // Normalised at load: `signed_in_as` alone already became `persona: { role }`.
    const persona = wt.start?.persona;
    if (as === undefined) {
      if (persona) return persona;
      continue;
    }
    if (persona?.role === as) return persona;
  }

  if (as !== undefined) {
    if (knownRoles.includes(as)) return { role: as };
    throw new Error(
      `no walkthrough in ${walkthroughsDir} signs in as "${as}" (checked start.persona.role / start.signed_in_as), ` +
        `and the config doesn't name it: add it to \`roles\` in the config (e.g. roles: { ${JSON.stringify(as)}: "..." }) to sign in as it before any walkthrough does`,
    );
  }
  return undefined;
}

/** The role ids a config names: `roles` keys and `readers`. */
export function configRoles(config: { roles?: Record<string, unknown>; readers?: string[] }): string[] {
  return [...Object.keys(config.roles ?? {}), ...(config.readers ?? [])];
}

async function openSignedIn(
  config: ResolvedConfig,
  path: string,
  persona: Persona | undefined,
  gate: WriteGate,
): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const baseUrl = config.app.baseUrl;
  const storageStatePath = join(config.buildDir, ".aida-session", `storageState-${storageStateKey(baseUrl, persona, config)}.json`);
  const reuseState = existsSync(storageStatePath) ? storageStatePath : undefined;

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: config.viewport ?? { width: 1440, height: 810 },
    deviceScaleFactor: config.deviceScaleFactor ?? 2,
    locale: config.locale ?? DEFAULT_CAPTURE_LOCALE,
    timezoneId: config.timezone ?? DEFAULT_CAPTURE_TIMEZONE,
    colorScheme: "light",
    reducedMotion: config.reducedMotion ?? "reduce",
    // A service worker's requests bypass the context's route (the write block): none here.
    serviceWorkers: "block",
    ...(reuseState ? { storageState: reuseState } : {}),
  });

  // Before any page exists: the page's own load can't write either.
  gate.passThrough = false;
  await installWriteGate(context, gate);
  await context.addInitScript(NAME_SHIM_SCRIPT);
  const page = await context.newPage();

  const doSignIn = async (): Promise<void> => {
    if (!config.signIn) return;
    // Signing in may legitimately POST (a session ticket); nothing else here may.
    gate.passThrough = true;
    try {
      await config.signIn({ page, context, baseUrl, persona, env: process.env });
    } finally {
      gate.passThrough = false;
    }
    mkdirSync(dirname(storageStatePath), { recursive: true });
    await context.storageState({ path: storageStatePath });
  };

  if (!reuseState && config.signIn) {
    await doSignIn();
  }

  await gotoReady(page, baseUrl + path, 120_000);

  if (reuseState && config.signIn && isSignInPath(page.url())) {
    await doSignIn();
    await gotoReady(page, baseUrl + path, 120_000);
  }

  return { browser, context, page };
}

function clickLines(click: ClickOutcome, name?: string): string[] {
  const lines = [`--click${name ? ` "${name}"` : ""}: dialog opened=${click.dialogOpened}, blocked write=${click.blockedWrite}`];
  if (click.warning) lines.push(`  warning: ${click.warning}`);
  if (click.listboxOptions) {
    lines.push(`  listbox options: ${click.listboxOptions.map((o) => JSON.stringify(o)).join(", ")}`);
    if (click.listboxTruncated) lines.push(`  (+more, capped at 15)`);
  }
  return lines;
}

function formatText(result: InspectResult): string {
  const after = result.after
    ? `  (after step "${result.after.step}" of ${result.after.path ? `path ${result.after.path} of ` : ""}${result.after.walkthrough})`
    : "";
  const header = `${result.url}${result.area ? `  (area: ${result.area})` : ""}${after}`;
  const lines: string[] = [];
  if (result.clicks) for (const c of result.clicks) lines.push(...clickLines(c, c.name));
  else if (result.click) lines.push(...clickLines(result.click));
  return [header, ...lines, result.snapshot].join("\n");
}

function clickNames(click: RunInspectOptions["click"]): string[] {
  if (click === undefined) return [];
  return Array.isArray(click) ? click : [click];
}

/**
 * Everything after the page is open: block writes, run `--click`s in order, `--check`,
 * `--select`, then scan. Shared by plain inspect and `--after`.
 */
async function applyAndScan(page: Page, opts: RunInspectOptions, gate: WriteGate): Promise<InspectResult> {
  // From here on, nothing this scan does — `--click`, `--check`, or the scan itself — can
  // write anything: every non-GET request is aborted and every WebSocket send dropped.
  gate.passThrough = false;

  const clicks: (ClickOutcome & { name: string })[] = [];
  for (const name of clickNames(opts.click)) {
    clicks.push({ name, ...(await clickToOpen(page, name)) });
  }
  if (opts.check) {
    await checkToReveal(page, opts.check);
  }
  if (opts.select) {
    const [field, option] = opts.select;
    await selectOption(page, field, option);
  }

  const scanned = await scanPage(page, { area: opts.area, lineCap: opts.lines, skipLines: opts.skip });
  if (clicks.length === 0) return scanned;
  // `click` stays the last click's outcome (the one-click shape); `clicks` lists each when chained.
  const { name: _name, ...last } = clicks[clicks.length - 1];
  return { ...scanned, click: last, ...(clicks.length > 1 ? { clicks } : {}) };
}

function printError(message: string, json: boolean, extra: Record<string, unknown> = {}): void {
  if (json) console.log(JSON.stringify({ ok: false, error: message, ...extra }));
  else console.error(`inspect failed: ${message}`);
}

/** A walkthrough by file path, by id (`<id>.yaml`), or by its `walkthrough:` field. */
function findWalkthrough(dir: string, idOrFile: string): { walkthrough: Walkthrough; file: string } {
  if (existsSync(idOrFile)) return { walkthrough: loadWalkthroughFile(idOrFile), file: idOrFile };
  for (const ext of [".yaml", ".yml"]) {
    const file = join(dir, `${idOrFile}${ext}`);
    if (existsSync(file)) return { walkthrough: loadWalkthroughFile(file), file };
  }
  const match = loadRunWalkthroughs(dir).find((w) => w.walkthrough.walkthrough === idOrFile);
  if (!match) throw new Error(`no walkthrough found for "${idOrFile}" in ${dir}`);
  return match;
}

function printFailure(failure: FailureReport, after: string, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ ok: false, error: failure.error, failure }));
    return;
  }
  console.error(`inspect --after "${after}" stopped: the walkthrough failed before reaching the end of that step`);
  for (const line of formatFailureLines(failure)) console.error(`  ${line}`);
}

/**
 * `--walkthrough <file-or-id> --after <stepId>`: signs in as the walkthrough's persona, runs its
 * setup (needs, `setup.steps`), replays its real actions through the capture runner up to and
 * including `after` without recording anything, then scans that page. A step failing on the way
 * prints the failure report (with its category) instead.
 */
async function runInspectAfter(config: ResolvedConfig, opts: RunInspectOptions, json: boolean): Promise<number> {
  const after = opts.after!;
  let walkthrough: Walkthrough;
  try {
    walkthrough = findWalkthrough(config.walkthroughsDir, opts.walkthrough!).walkthrough;
  } catch (err) {
    printError((err as Error).message.split("\n")[0], json);
    return 1;
  }
  // A main step id, or `<pathId>/<stepId>`: a path replays from its own start page through its
  // opening steps (and the main steps from `joins` on), as capture runs it (inspect/after.ts).
  const target = resolveAfterTarget(walkthrough, after);
  if ("error" in target) {
    printError(target.error, json);
    return 1;
  }
  const replayed = target.walkthrough;

  const baseUrl = walkthrough.start?.baseUrl ?? config.app.baseUrl;
  const storageStatePath = join(
    config.buildDir,
    ".aida-session",
    `storageState-${storageStateKey(baseUrl, walkthrough.start?.persona, config)}.json`,
  );

  let scanned: InspectResult | undefined;
  let scanError: unknown;
  let failure: FailureReport | undefined;
  // The replay really writes (sign-in, setup, the steps); the gate is installed on its context
  // before the first page loads, so sockets opened during it are routed and go quiet afterwards.
  const gate: WriteGate = { passThrough: true };
  try {
    const result = await runCapture({
      walkthrough: replayed,
      config,
      // Nothing is written there: `record: false` keeps frames, screenshots and failure.json off disk.
      outDir: join(config.buildDir, walkthrough.walkthrough, "inspect"),
      storageStatePath,
      runId: process.env.AIDA_RUN_ID || newRunId(),
      personaFor: personaLookup(loadRunWalkthroughs(config.walkthroughsDir).map((w) => w.walkthrough)),
      stopAfterStep: target.stopAfterStep,
      record: false,
      maxWaitMs: opts.maxWaitMs,
      blockServiceWorkers: true,
      onContext: (context) => installWriteGate(context, gate),
      log: json ? undefined : (...a: unknown[]) => console.error("[inspect --after]", ...a),
      onStopped: async (page) => {
        try {
          scanned = await applyAndScan(page, opts, gate);
        } catch (err) {
          scanError = err;
        }
      },
    });
    failure = result.failure;
    if (!failure && !result.stopped) {
      printError(`the walkthrough ended without reaching step "${target.stopAfterStep}"${target.path ? ` of path ${target.path}` : ""}`, json);
      return 1;
    }
  } catch (err) {
    failure = runLevelFailure(err);
  }

  if (failure) {
    printFailure(failure, after, json);
    return 1;
  }
  if (scanError || !scanned) {
    const message = scanError instanceof Error ? scanError.message.split("\n")[0] : String(scanError ?? "nothing scanned");
    printError(message, json, { refused: scanError instanceof InspectClickRefusedError });
    return 1;
  }
  const result: InspectResult = {
    ...scanned,
    after: { walkthrough: walkthrough.walkthrough, step: target.stopAfterStep, ...(target.path ? { path: target.path } : {}) },
  };
  if (json) console.log(JSON.stringify({ ok: true, ...result }));
  else console.log(formatText(result));
  return 0;
}

/** Runs `aida inspect`. Returns 0 on success, 1 on a refused/failed scan. */
export async function runInspectCommand(opts: RunInspectOptions, json: boolean): Promise<number> {
  const config = await loadConfig(opts.configPath);

  const replay = opts.walkthrough !== undefined || opts.after !== undefined;
  if (replay && (opts.walkthrough === undefined || opts.after === undefined)) {
    printError("--walkthrough and --after go together: --walkthrough <file-or-id> --after <stepId>", json);
    return 1;
  }
  if (replay && opts.path) {
    printError("--after replays the walkthrough from its own start page: leave out the page path", json);
    return 1;
  }
  if (replay && opts.as) {
    printError("--after signs in as the walkthrough's own persona: leave out --as", json);
    return 1;
  }
  if (!replay && !opts.path) {
    printError("give a page path to inspect, or --walkthrough <file-or-id> --after <stepId>", json);
    return 1;
  }

  // Same gate as capture (decision 27), before any browser opens: even a read-only inspect signs
  // in (a sign-in adapter can POST through `context.request`, outside the page-level block), and
  // `--after` really writes. Refused exactly the way `aida capture` refuses.
  const refusal = await captureSafetyRefusal(config);
  if (refusal) {
    if (json) console.log(JSON.stringify({ ok: false, error: refusal.error, database: refusal.database }));
    else console.error(refusal.error);
    return 1;
  }

  if (replay) return runInspectAfter(config, opts, json);

  let persona: Persona | undefined;
  try {
    persona = resolvePersona(config.walkthroughsDir, opts.as, configRoles(config));
  } catch (err) {
    const message = (err as Error).message;
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`inspect failed: ${message}`);
    return 1;
  }

  let browser: Browser | undefined;
  try {
    const gate: WriteGate = { passThrough: false };
    const opened = await openSignedIn(config, opts.path!, persona, gate);
    browser = opened.browser;
    const result = await applyAndScan(opened.page, opts, gate);

    if (json) {
      console.log(JSON.stringify({ ok: true, ...result }));
    } else {
      console.log(formatText(result));
    }
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    const refused = err instanceof InspectClickRefusedError;
    if (json) console.log(JSON.stringify({ ok: false, error: message, refused }));
    else console.error(`inspect failed: ${message}`);
    return 1;
  } finally {
    await browser?.close().catch(() => {});
  }
}

// Re-exported so a test (or `aida digest`-style scripting) can check a baseUrl's write-safety
// the same way this command does, without reaching into capture/write-guard.ts directly.
export { isLocalBaseUrl };
