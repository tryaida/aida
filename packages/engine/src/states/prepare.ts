// The setup phase of a capture (decision 28): before a walkthrough's recorded steps, make sure
// the data it `needs` is there (config state `check`/`setup` hooks), then run its own unrecorded
// `setup.steps`. Nothing here takes a screenshot. After a successful capture, `checkLeftStates`
// confirms the states it `leaves`.
//
// `prepareWalkthrough` is reusable on purpose: anything that replays part of a walkthrough
// (`inspect --after <step>`) calls it with its own signed-in browser context first.
import { sessionKey } from "../capture/session-key.js";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";
import type { Action, Persona, Walkthrough } from "../walkthrough/index.js";
import { personaRole, resolveTemplatesDeep, withRunValues } from "../walkthrough/index.js";
import type { ResolvedConfig, ResolvedStateConfig, StateHookContext } from "../config/types.js";
import { locate } from "../capture/locate.js";
import { settle } from "../capture/settle.js";
import { waitForText } from "../capture/text-check.js";
import { isSignInPath } from "../capture/diagnose.js";
import { NAME_SHIM_SCRIPT } from "../capture/init-scripts.js";
import { gotoReady } from "../capture/page-ready.js";
import { loadRunWalkthroughs } from "./run.js";

const WRITE_ACTIONS = new Set(["click", "type", "select", "press"]);

/** A need or setup step that couldn't be made true. Capture reports it as a setup failure. */
export class WalkthroughSetupError extends Error {
  constructor(
    message: string,
    /** The state whose hook failed, when it was a need. */
    public readonly state?: string,
    /** The setup step that failed, when it was one of `setup.steps`. */
    public readonly step?: string,
    /** The page the failed setup step was on. */
    public readonly url?: string,
  ) {
    super(message);
    this.name = "WalkthroughSetupError";
  }
}

export interface PrepareOptions {
  /** As loaded: templates unresolved (they're resolved here with `runId`). */
  walkthrough: Walkthrough;
  /** `clock` is installed on every setup page, as on the capture page; `walkthroughsDir` is only
   * read to word a failed need (does any walkthrough leave it?). */
  config: Pick<ResolvedConfig, "states" | "signIn"> & Partial<Pick<ResolvedConfig, "clock" | "walkthroughsDir" | "signInHash">>;
  browser: Browser;
  /** The walkthrough's own signed-in context. Hooks and setup steps for its persona open a new page in it. */
  context: BrowserContext;
  baseUrl: string;
  runId: string;
  /** Persona for a role named by `setup.as` or a state's `as`. Default `{ role }`. */
  personaFor?: (role: string) => Persona | undefined;
  /** Keeps other roles' sessions between runs (`<buildDir>/.aida-session`). Unset: sign in each time. */
  sessionDir?: string;
  /** For contexts opened for other roles (viewport, locale, ...); `baseURL` is always set. */
  contextOptions?: BrowserContextOptions;
  env?: Record<string, string | undefined>;
  log?: (...args: unknown[]) => void;
}

export interface PrepareReport {
  needs: { state: string; outcome: "held" | "set-up" | "set-up-unchecked" | "no-hook" }[];
  setupSteps: number;
}

/** True when the walkthrough has anything for `prepareWalkthrough` to do. */
export function needsPreparation(walkthrough: Walkthrough, config: Pick<ResolvedConfig, "states">): boolean {
  if (walkthrough.setup?.steps.length) return true;
  return (walkthrough.needs ?? []).some((s) => config.states?.[s]?.setup || config.states?.[s]?.check);
}

/** True when the setup phase can write data: a setup hook for a need, or a click/type/select setup step. */
export function preparationWrites(walkthrough: Walkthrough, config: Pick<ResolvedConfig, "states">): boolean {
  if ((walkthrough.needs ?? []).some((s) => config.states?.[s]?.setup)) return true;
  return (walkthrough.setup?.steps ?? []).some((s) => s.actions.some((a) => WRITE_ACTIONS.has(a.do)));
}

/**
 * Makes a walkthrough's needs true and runs its `setup.steps`, unrecorded:
 * 1. a need with a `check`: run it; if false and there's a `setup`, run setup and check again;
 *    still false is a `WalkthroughSetupError`
 * 2. a need with a `setup` and no `check`: run the setup
 * 3. the walkthrough's own `setup.steps`, signed in as `setup.as` (else its own persona)
 * A need with neither hook was met by an earlier walkthrough in the run (see `planCaptureRun`).
 * Setup runs on pages of its own (closed afterwards); the caller's page is left where it was, so
 * bring it to the front and reload it (`page.bringToFront()`, `page.goto(...)`) before going on.
 */
export async function prepareWalkthrough(opts: PrepareOptions): Promise<PrepareReport> {
  const log = opts.log ?? (() => {});
  const sessions = new RoleSessions(opts);
  const report: PrepareReport = { needs: [], setupSteps: 0 };
  try {
    for (const state of opts.walkthrough.needs ?? []) {
      const hooks = opts.config.states?.[state];
      if (!hooks?.check && !hooks?.setup) {
        report.needs.push({ state, outcome: "no-hook" });
        continue;
      }
      report.needs.push({ state, outcome: await ensureState(state, hooks, sessions, opts, log) });
    }

    const setup = opts.walkthrough.setup;
    if (setup?.steps.length) {
      const data = withRunValues(opts.walkthrough.data, { id: opts.runId });
      const steps = resolveTemplatesDeep(setup.steps, data);
      log(`setup: ${steps.length} step(s)${setup.as ? ` as ${setup.as}` : ""}`);
      const { page } = await sessions.open(setup.as);
      const baseOrigin = new URL(opts.baseUrl).origin;
      for (const [i, step] of steps.entries()) {
        const label = step.id ?? step.title ?? `#${i + 1}`;
        try {
          for (const action of step.actions) await runSetupAction(page, action, baseOrigin);
        } catch (err) {
          throw new WalkthroughSetupError(`setup step "${label}" failed: ${firstLine(err)}`, undefined, label, page.url());
        }
        report.setupSteps += 1;
      }
    }
    return report;
  } finally {
    await sessions.close();
  }
}

async function ensureState(
  state: string,
  hooks: ResolvedStateConfig,
  sessions: RoleSessions,
  opts: PrepareOptions,
  log: (...args: unknown[]) => void,
): Promise<PrepareReport["needs"][number]["outcome"]> {
  const ctx = await sessions.hookContext(state, hooks.as);
  if (hooks.check) {
    if (await runHook(state, "check", () => hooks.check!(ctx))) {
      log(`needs ${state}: already true`);
      return "held";
    }
    if (!hooks.setup) throw new WalkthroughSetupError(missingStateMessage(state, opts), state);
    log(`needs ${state}: not true yet, running its setup hook`);
    await runHook(state, "setup", () => hooks.setup!(ctx));
    if (!(await runHook(state, "check", () => hooks.check!(ctx)))) {
      throw new WalkthroughSetupError(`needs ${state}: its setup hook ran, but its check still says it isn't true`, state);
    }
    return "set-up";
  }
  log(`needs ${state}: running its setup hook`);
  await runHook(state, "setup", () => hooks.setup!(ctx));
  return "set-up-unchecked";
}

/** Why a need with a failing check and no setup hook can't be met, and what to do about it. */
function missingStateMessage(state: string, opts: PrepareOptions): string {
  const self = opts.walkthrough.walkthrough;
  const providers = opts.config.walkthroughsDir
    ? loadRunWalkthroughs(opts.config.walkthroughsDir)
        .filter((r) => r.walkthrough.walkthrough !== self && (r.walkthrough.leaves ?? []).includes(state))
        .map((r) => r.walkthrough.walkthrough)
    : [];
  const head = `needs ${state}, but its check says it isn't true and config states.${state} has no setup hook`;
  if (providers.length === 0) {
    return `${head}. No walkthrough leaves ${state}, so this is starting data: reset the demo data (aida capture resets it when a database adapter with \`reset\` is configured), or add a states.${state}.setup hook`;
  }
  return `${head}: capture ${providers.join(" or ")} first (it leaves ${state}; --with-deps pulls it in), or add a states.${state}.setup hook`;
}

async function runHook<T>(state: string, kind: "setup" | "check", fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new WalkthroughSetupError(`the ${kind} hook for ${state} failed: ${firstLine(err)}`, state);
  }
}

/**
 * After a successful capture: runs the `check` of each state the walkthrough `leaves` and
 * returns a warning for each one that doesn't hold (or whose check throws). Never throws.
 */
export async function checkLeftStates(opts: PrepareOptions): Promise<string[]> {
  const warnings: string[] = [];
  const toCheck = (opts.walkthrough.leaves ?? []).filter((s) => opts.config.states?.[s]?.check);
  if (toCheck.length === 0) return warnings;
  const sessions = new RoleSessions(opts);
  try {
    for (const state of toCheck) {
      const hooks = opts.config.states![state];
      try {
        const ctx = await sessions.hookContext(state, hooks.as);
        if (!(await hooks.check!(ctx))) {
          warnings.push(`${opts.walkthrough.walkthrough} should leave ${state}, but its check says it isn't true afterwards`);
        }
      } catch (err) {
        warnings.push(`couldn't check ${state} after ${opts.walkthrough.walkthrough}: ${firstLine(err)}`);
      }
    }
  } catch (err) {
    warnings.push(`couldn't check the states ${opts.walkthrough.walkthrough} leaves: ${firstLine(err)}`);
  } finally {
    await sessions.close();
  }
  return warnings;
}

/**
 * Pages signed in as a role, opened on demand during one setup phase. The walkthrough's own
 * role gets a fresh page in its own context (same session, so client-side state carries over);
 * any other role gets its own context, signed in with `config.signIn`.
 */
class RoleSessions {
  private readonly open_ = new Map<string, { page: Page; context: BrowserContext; persona?: Persona }>();
  private readonly ownContexts: BrowserContext[] = [];
  private readonly pages: Page[] = [];

  constructor(private readonly opts: PrepareOptions) {}

  async hookContext(state: string, role: string | undefined): Promise<StateHookContext> {
    const { page, context, persona } = await this.open(role);
    return {
      state,
      page,
      context,
      request: context.request,
      baseUrl: this.opts.baseUrl,
      persona,
      env: this.opts.env ?? process.env,
      runId: this.opts.runId,
      log: this.opts.log ?? (() => {}),
    };
  }

  async open(role: string | undefined): Promise<{ page: Page; context: BrowserContext; persona?: Persona }> {
    const ownRole = personaRole(this.opts.walkthrough.start);
    const key = role === undefined || role === ownRole ? "" : role;
    const existing = this.open_.get(key);
    if (existing) {
      await existing.page.bringToFront();
      return existing;
    }

    let session: { page: Page; context: BrowserContext; persona?: Persona };
    if (key === "") {
      const page = await this.opts.context.newPage();
      this.pages.push(page);
      await this.installClock(page);
      await page.goto(this.opts.baseUrl + "/", { waitUntil: "domcontentloaded", timeout: 120_000 });
      session = { page, context: this.opts.context, persona: this.opts.walkthrough.start?.persona };
    } else {
      session = await this.signInAs(key);
    }
    this.open_.set(key, session);
    // A background tab gets no animation frames, so Playwright's clicks there never see a stable
    // element. The capture page is brought back to the front once setup is done.
    await session.page.bringToFront();
    return session;
  }

  private async signInAs(role: string): Promise<{ page: Page; context: BrowserContext; persona?: Persona }> {
    const { browser, baseUrl, config } = this.opts;
    const persona = this.opts.personaFor?.(role) ?? { role };
    // Same key shape as capture's own session files, so a role's session is shared with capture.
    const statePath = this.opts.sessionDir
      ? join(this.opts.sessionDir, `storageState-${sessionKey(baseUrl, persona, config)}.json`)
      : undefined;
    const reuse = statePath && existsSync(statePath) ? statePath : undefined;
    const context = await browser.newContext({
      ...this.opts.contextOptions,
      baseURL: baseUrl,
      ...(reuse ? { storageState: reuse } : {}),
    });
    this.ownContexts.push(context);
    await context.addInitScript(NAME_SHIM_SCRIPT);
    const page = await context.newPage();
    await this.installClock(page);
    const signIn = async (): Promise<void> => {
      if (!config.signIn) return;
      this.opts.log?.(`setup: signing in as ${role}`);
      await config.signIn({ page, context, baseUrl, persona, env: this.opts.env ?? process.env });
      if (statePath) {
        mkdirSync(this.opts.sessionDir!, { recursive: true });
        await context.storageState({ path: statePath });
      }
    };
    if (!reuse) await signIn();
    await page.goto(baseUrl + "/", { waitUntil: "domcontentloaded", timeout: 120_000 });
    if (reuse && config.signIn && isSignInPath(page.url())) {
      await signIn();
      await page.goto(baseUrl + "/", { waitUntil: "domcontentloaded", timeout: 120_000 });
    }
    return { page, context, persona };
  }

  /** Same pinned time as the capture page (config `clock`), so setup sees the dates capture does. */
  private async installClock(page: Page): Promise<void> {
    if (this.opts.config.clock) await page.clock.install({ time: new Date(this.opts.config.clock) });
  }

  async close(): Promise<void> {
    for (const page of this.pages) await page.close().catch(() => {});
    for (const context of this.ownContexts) await context.close().catch(() => {});
  }
}

/** Runs one setup action: the capture runner's action set, without frames, highlights or pacing. */
async function runSetupAction(page: Page, a: Action, baseOrigin: string): Promise<void> {
  if (WRITE_ACTIONS.has(a.do) && new URL(page.url()).origin !== baseOrigin) {
    throw new Error(`refusing to ${a.do} on off-origin page ${page.url()} (walkthrough origin is ${baseOrigin})`);
  }
  switch (a.do) {
    case "expect": {
      const loc = await locate(a.target, page);
      await loc.waitFor({ state: "visible", timeout: 20_000 });
      if (a.text !== undefined) await waitForText(loc, a.text, a.exact ?? false, 20_000);
      return;
    }
    case "point":
      await (await locate(a.target, page)).waitFor({ state: "visible", timeout: 20_000 });
      return;
    case "hover":
      await (await locate(a.target, page)).hover();
      return;
    case "focus":
      await (await locate(a.target, page)).focus();
      return;
    case "press":
      if (a.target) await (await locate(a.target, page)).press(a.key);
      else await page.keyboard.press(a.key);
      await settle(page);
      return;
    case "waitFor":
      await (await locate(a.target, page)).waitFor({ state: "visible", timeout: 60_000 });
      return;
    case "waitForUrl":
      await page.waitForURL(new RegExp(a.pattern), { timeout: 60_000 });
      return;
    case "goto": {
      const target = new URL(a.path, page.url());
      if (target.origin !== baseOrigin) throw new Error(`refusing cross-origin goto to ${target.origin} (walkthrough origin is ${baseOrigin})`);
      await gotoReady(page, target.href, 120_000);
      await settle(page);
      return;
    }
    case "scrollTo":
      await (await locate(a.target, page)).scrollIntoViewIfNeeded();
      return;
    case "click": {
      await (await locate(a.target, page)).click();
      await settle(page);
      return;
    }
    case "type": {
      await (await locate(a.target, page)).fill(a.text);
      return;
    }
    case "select": {
      const loc = await locate(a.target, page);
      const isNative = await loc.evaluate((el) => el.tagName === "SELECT").catch(() => false);
      if (isNative) {
        await loc.selectOption({ label: a.option }).catch(() => loc.selectOption(a.option));
      } else {
        await loc.click();
        await page.getByRole("option", { name: a.option, exact: true }).first().click({ timeout: 10_000 });
      }
      await settle(page);
      return;
    }
    default:
      throw new Error(`unknown action ${(a as Action).do}`);
  }
}

function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n")[0] ?? message;
}
