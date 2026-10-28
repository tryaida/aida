// What changed during a failing step, and who the failure probably belongs to (decision 30;
// build-plan.md M28). `StepWatch` listens to the page while a step runs: the URL it started on,
// write requests and their statuses, error responses, page and console errors. When the step
// fails, `changes()` turns that into the small `FailureChanges` block of the failure report, and
// `classifyFailure` reads it to say "walkthrough", "app" or "environment" with a one-line reason.
//
// Deliberately small and agent-safe: paths without query strings, no bodies, the first line of
// the first error only, redacted the same way the failure snapshot is.
import type { ConsoleMessage, Page, Request, Response } from "playwright";
import type { Target } from "../walkthrough/index.js";
import { locate } from "./locate.js";
import { redactLine, stripOpaqueSegments, stripQueryAndHash } from "./redact.js";
import type { FailureActionRef, FailureCategory, FailureChanges, FailureRequest } from "./types.js";
import { NETWORK_IDLE_CAP_MS, waitForNetworkQuiet } from "./page-ready.js";

const WRITE_CAP = 8;
const ERROR_RESPONSE_CAP = 5;
const ERROR_TEXT_CAP = 200;
const IGNORED_CONSOLE = [/fonts\.googleapis\.com/];
/** Not writes: a HEAD probe or a CORS preflight never changes anything. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const IGNORED_PATHS = new Set(["/favicon.ico"]);
/** Only these count as the app's own traffic: an analytics beacon (`ping`), a script or image
 * from a CDN, a font, never do. */
const APP_RESOURCE_TYPES = new Set(["fetch", "xhr", "document"]);
const WAIT_ACTIONS = new Set(["waitFor", "waitForUrl", "expect"]);
/** How long a page that looks blank gets to fill in before it's called blank. */
const BLANK_SETTLE_MS = 750;

/**
 * A sign-in page: `/login`, `/sign-in`, `/signin`, `/users/sign_in`, `/auth/...`, `/en/login`.
 * Anchored at the start of the path, so `/settings/auth` or `/admin/login-history` is not one.
 */
const SIGN_IN_PATH =
  /^\/(?:[a-z]{2}(?:-[a-z]{2,4})?\/)?(?:(?:auth|account|accounts|user|users|session|sessions|api\/auth)\/)?(?:sign[-_]?in|log[-_]?in)(?:\/|$)|^\/auth(?:\/|$)/i;

/** True when `pathOrUrl` (a path or a full URL) is a sign-in page. */
export function isSignInPath(pathOrUrl: string): boolean {
  return SIGN_IN_PATH.test(pathOf(pathOrUrl));
}

/**
 * A short fingerprint of what the screen shows: the open dialog's, else `main`'s, else `body`'s
 * text length, a hash of its first and last 256 characters, its element count and how many
 * elements are `hidden`. `textContent`, not `innerText`: no layout, so it stays cheap on a big
 * table (it runs before every click). A plain source string, not a function: see
 * capture/init-scripts.ts for why (`__name` under tsx).
 */
const SCREEN_FINGERPRINT_SCRIPT = `
(() => {
  var root = document.querySelector("dialog[open], [role=dialog]:not([hidden]), [role=alertdialog]:not([hidden])")
    || document.querySelector("main, [role=main]") || document.body;
  if (!root) return "none";
  var t = root.textContent || "";
  var s = t.length > 512 ? t.slice(0, 256) + t.slice(-256) : t;
  var h = 5381;
  for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return root.tagName + ":" + t.length + ":" + h + ":" + root.getElementsByTagName("*").length + ":" + root.querySelectorAll("[hidden]").length;
})()
`;

/**
 * "blank" when `main` (if the page has one) or `body` shows no text at all; "loading" when a
 * loading placeholder is up (a skeleton, a spinner, `aria-busy`), which is not blank; else "ok".
 */
const BLANK_PAGE_SCRIPT = `
(() => {
  var body = document.body;
  if (!body) return "blank";
  if (document.querySelector('[aria-busy="true"], [role=progressbar], .animate-pulse, [class*="skeleton" i], [class*="shimmer" i], [class*="spinner" i], [class*="loading" i]')) return "loading";
  if (!(body.innerText || "").trim()) return "blank";
  var main = document.querySelector("main, [role=main]");
  return main && !(main.innerText || "").trim() ? "blank" : "ok";
})()
`;

/** Where the runner is in a step's actions: the one running now and the last one that finished. */
export interface ActionProgress {
  current?: FailureActionRef & { target?: Target };
  lastOk?: FailureActionRef;
}

/**
 * The origins whose traffic counts as the app's: `baseUrl`'s, `capture.apiOrigins` (an API on
 * another host), and the origin of any `*SUPABASE_URL` in the environment (a Supabase app's API).
 */
export function appOrigins(baseUrl: string, apiOrigins: readonly string[] = [], env: Record<string, string | undefined> = process.env): Set<string> {
  const out = new Set<string>([new URL(baseUrl).origin]);
  const add = (value: string | undefined): void => {
    if (!value) return;
    try {
      const u = new URL(value);
      if (u.protocol === "http:" || u.protocol === "https:") out.add(u.origin);
    } catch {
      // not a URL: ignored
    }
  };
  for (const o of apiOrigins) add(o);
  for (const [name, value] of Object.entries(env)) if (/(^|_)SUPABASE_URL$/.test(name)) add(value);
  return out;
}

/** `localhost`, `*.localhost`, `127.x.x.x` or `[::1]`: this machine. */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "[::1]" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Suffixes under which anyone can register a name, so the site is one label more: country
 * second levels (`co.uk`, `com.au`) and the hosting platforms an app or its API commonly sits on
 * (`vercel.app`, `supabase.co`). A short list, not the public suffix list: anything missing just
 * makes two names on it look like one site, never an app's own name look like a third party.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "ltd.uk", "plc.uk", "me.uk", "net.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "asn.au", "id.au",
  "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz",
  "co.jp", "ne.jp", "or.jp", "co.kr", "co.za", "org.za", "co.in", "net.in",
  "com.br", "com.mx", "com.ar", "com.sg", "com.hk", "com.cn", "com.tw", "com.tr", "co.il",
  "vercel.app", "netlify.app", "pages.dev", "workers.dev", "web.app", "firebaseapp.com", "github.io",
  "herokuapp.com", "onrender.com", "fly.dev", "railway.app", "supabase.co", "supabase.in",
  "azurewebsites.net", "cloudfront.net", "amazonaws.com", "appspot.com", "ngrok.io", "ngrok-free.app",
]);

/** The registrable part of `hostname` (`app.acme.co.uk` -> `acme.co.uk`), or undefined for an
 * IP address or a single-label name. */
export function siteOf(hostname: string): string | undefined {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return undefined;
  const labels = h.split(".").filter(Boolean);
  if (labels.length < 2) return undefined;
  const two = labels.slice(-2).join(".");
  if (MULTI_LABEL_SUFFIXES.has(two)) return labels.length >= 3 ? labels.slice(-3).join(".") : undefined;
  return two;
}

/**
 * True when `url` (or an origin) is the app's own: one of `appOrigins`; any port on this machine
 * when an app origin is on this machine (a dev server, its API and a Vite or Storybook server on
 * other ports are all the app's); or the same site as an app origin (`api.acme.test` for
 * `app.acme.test`). Calling the app's own traffic a third party hides its bugs, so the rule leans
 * that way.
 */
export function isAppOrigin(url: string, appOrigins: ReadonlySet<string>): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (appOrigins.has(u.origin)) return true;
  const site = siteOf(u.hostname);
  const loopback = isLoopbackHost(u.hostname);
  for (const o of appOrigins) {
    let a: URL;
    try {
      a = new URL(o);
    } catch {
      continue;
    }
    if (loopback && isLoopbackHost(a.hostname)) return true;
    if (site && siteOf(a.hostname) === site) return true;
  }
  return false;
}

/** URLs in an error's stack, `https://x/app.js:1:2` style. */
function stackUrls(stack: string): string[] {
  return [...stack.matchAll(/\b(https?:\/\/[^\s()]+?):\d+:\d+/g)].map((m) => m[1]);
}

/** An error from a third party's script: one whose stack frames all sit in scripts that aren't
 * the app's (`isAppOrigin`), e.g. an analytics or chat widget. The browser's opaque "Script
 * error." says nothing about whose script it was, so it counts as the app's: hiding an app bug
 * is worse than a false alarm. */
export function isThirdPartyError(err: { message?: string; stack?: string }, appOrigins: ReadonlySet<string>): boolean {
  const urls = stackUrls(err?.stack ?? "");
  return urls.length > 0 && urls.every((u) => !isAppOrigin(u, appOrigins));
}

export interface StepWatchOptions {
  /** The role the walkthrough signed in as. */
  signedInAs?: string;
  /** `capture.apiOrigins`: other origins whose fetch/xhr traffic is the app's. */
  apiOrigins?: readonly string[];
  /** Default `process.env` (read for `*SUPABASE_URL`). */
  env?: Record<string, string | undefined>;
}

/**
 * Watches one page across a walkthrough's steps. Call `start()` at each step's start,
 * `navigated()` after the runner opens a page (the start page, a `goto`), `beforeClick()` right
 * before a click or select lands, and `changes()` once a step has failed.
 *
 * Only the app's own traffic counts: fetch, xhr and document requests to the app's origins (see
 * `appOrigins`). Analytics beacons, CDN scripts and cross-origin script errors are ignored.
 */
export class StepWatch {
  private origin: string;
  private origins: Set<string>;
  private signedInAs?: string;
  private writes: FailureRequest[] = [];
  /** How many of `writes` (at the front) were carried over from an earlier step. */
  private carried = 0;
  /** How many of `writes` (at the front) a wait that passed has already confirmed. */
  private confirmed = 0;
  private pending = new Map<Request, FailureRequest>();
  private startedAt = new Map<FailureRequest, number>();
  private lastWriteActivity = 0;
  private errorResponses: FailureRequest[] = [];
  private pageErrors: { count: number; first?: string } = { count: 0 };
  private consoleErrors: { count: number; first?: string } = { count: 0 };
  private urlBefore = "";
  private textAtClick: string | undefined;
  /** The page the walkthrough last opened, until a click happens. */
  private opened: string | undefined;

  constructor(
    private page: Page,
    baseUrl: string,
    opts: StepWatchOptions = {},
  ) {
    this.origin = new URL(baseUrl).origin;
    this.origins = appOrigins(baseUrl, opts.apiOrigins, opts.env);
    this.signedInAs = opts.signedInAs;
    page.on("request", this.onRequest);
    page.on("response", this.onResponse);
    page.on("requestfailed", this.onRequestFailed);
    page.on("pageerror", this.onPageError);
    page.on("console", this.onConsole);
  }

  /**
   * Starts a new step. Forgets what the previous one saw, except writes no wait has confirmed yet
   * and the screen at the click that made them: a save clicked at the end of one step and waited
   * for in the next is still one save, so those carry forward until the next click.
   */
  start(): void {
    this.writes = this.writes.slice(this.confirmed);
    this.confirmed = 0;
    this.carried = this.writes.length;
    if (this.carried === 0) this.textAtClick = undefined;
    this.errorResponses = [];
    this.pageErrors = { count: 0 };
    this.consoleErrors = { count: 0 };
    this.urlBefore = stripQueryAndHash(this.page.url());
  }

  /** Forgets everything, carried writes included: sign-in and setup traffic isn't any step's. */
  reset(): void {
    this.writes = [];
    this.carried = 0;
    this.confirmed = 0;
    this.textAtClick = undefined;
    this.opened = undefined;
    this.start();
  }

  /** A wait passed: the writes so far did what the walkthrough expected, so none carries over. */
  waitPassed(): void {
    this.confirmed = this.writes.length;
  }

  /** The runner opened `path` (the start page, a `goto`): a different path before the next click
   * is the app redirecting. */
  navigated(path: string): void {
    this.opened = pathOf(path);
  }

  /** Remembers what the screen said just before a click, so a failure can tell whether it changed. */
  async beforeClick(): Promise<void> {
    this.writes = this.writes.slice(this.carried);
    this.confirmed = Math.max(0, this.confirmed - this.carried);
    this.carried = 0;
    this.opened = undefined;
    this.textAtClick = await this.fingerprint();
  }

  /** Writes still waiting for an answer. */
  get pendingWrites(): number {
    return this.pending.size;
  }

  /**
   * Waits until no write has been waiting or answered for `quietMs`, up to `capMs`: a save's
   * follow-up request (fired once the first one answers) gets its chance too. True when it got
   * quiet, false when the cap ran out.
   */
  async writesSettled(capMs = 10_000, quietMs = 300): Promise<boolean> {
    const deadline = Date.now() + capMs;
    for (;;) {
      if (this.pending.size === 0 && Date.now() - this.lastWriteActivity >= quietMs) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** The `changes` section for a step that just failed. */
  async changes(progress: ActionProgress): Promise<FailureChanges> {
    let blank = await this.blankState();
    if (blank === "blank") {
      // A page mid-render can be empty for a moment: give it a short settle before calling it blank.
      await this.page.waitForTimeout(BLANK_SETTLE_MS).catch(() => {});
      blank = await this.blankState();
    }
    let screenChanged: boolean | undefined;
    if (this.textAtClick !== undefined) {
      const now = await this.fingerprint();
      screenChanged = now === undefined ? undefined : now !== this.textAtClick;
    }
    const now = Date.now();
    // Carried writes only explain a missed wait (the save of a step that ended on its click);
    // they say nothing about a click target that isn't there.
    const failedWait = progress.current ? WAIT_ACTIONS.has(progress.current.do) : false;
    const writes = (failedWait ? this.writes : this.writes.slice(this.carried)).map((w) => {
      const started = this.startedAt.get(w);
      return w.status === undefined && started !== undefined ? { ...w, waitedSeconds: Math.round((now - started) / 1000) } : { ...w };
    });
    return {
      urlBefore: this.urlBefore,
      urlAfter: stripQueryAndHash(this.page.url()),
      ...(this.opened ? { expectedPath: stripOpaqueSegments(this.opened) } : {}),
      writes,
      errorResponses: this.errorResponses.map((r) => ({ ...r })),
      pageErrors: { ...this.pageErrors },
      consoleErrors: { ...this.consoleErrors },
      blankPage: blank === "blank",
      ...(screenChanged === undefined ? {} : { screenChanged }),
      ...(this.signedInAs ? { signedInAs: this.signedInAs } : {}),
      ...(progress.current ? { failedAction: { index: progress.current.index, do: progress.current.do } } : {}),
      ...(progress.lastOk ? { lastOkAction: { ...progress.lastOk } } : {}),
    };
  }

  dispose(): void {
    this.page.off("request", this.onRequest);
    this.page.off("response", this.onResponse);
    this.page.off("requestfailed", this.onRequestFailed);
    this.page.off("pageerror", this.onPageError);
    this.page.off("console", this.onConsole);
  }

  private async blankState(): Promise<"blank" | "loading" | "ok"> {
    return (await this.page.evaluate(BLANK_PAGE_SCRIPT).catch(() => "ok")) as "blank" | "loading" | "ok";
  }

  private async fingerprint(): Promise<string | undefined> {
    return (await this.page.evaluate(SCREEN_FINGERPRINT_SCRIPT).catch(() => undefined)) as string | undefined;
  }

  private isAppUrl(url: string): boolean {
    try {
      return isAppOrigin(url, this.origins);
    } catch {
      return false;
    }
  }

  /** Path only (no query, no tokens) for the app's own fetch/xhr/document traffic: same-origin
   * as `/api/x`, an API origin as `host/api/x`. `undefined` for anything else. */
  private pathOf(req: Request): string | undefined {
    if (!APP_RESOURCE_TYPES.has(req.resourceType())) return undefined;
    try {
      const u = new URL(req.url());
      if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
      if (!isAppOrigin(u.href, this.origins) || IGNORED_PATHS.has(u.pathname)) return undefined;
      const path = stripOpaqueSegments(u.pathname);
      return u.origin === this.origin ? path : `${u.host}${path}`;
    } catch {
      return undefined;
    }
  }

  private onRequest = (req: Request): void => {
    if (READ_METHODS.has(req.method())) return;
    const path = this.pathOf(req);
    if (!path) return;
    const entry: FailureRequest = { method: req.method(), path };
    this.pending.set(req, entry);
    this.startedAt.set(entry, Date.now());
    this.lastWriteActivity = Date.now();
    if (this.writes.length >= WRITE_CAP && this.carried > 0) {
      this.writes.shift();
      this.carried -= 1;
      this.confirmed = Math.max(0, this.confirmed - 1);
    }
    if (this.writes.length < WRITE_CAP) this.writes.push(entry);
  };

  private onResponse = (res: Response): void => {
    const req = res.request();
    const status = res.status();
    const entry = this.pending.get(req);
    if (entry) {
      entry.status = status;
      this.pending.delete(req);
      this.startedAt.delete(entry);
      this.lastWriteActivity = Date.now();
    }
    if (status < 400) return;
    const path = this.pathOf(req);
    if (!path || this.errorResponses.length >= ERROR_RESPONSE_CAP) return;
    this.errorResponses.push({ method: req.method(), path, status });
  };

  private onRequestFailed = (req: Request): void => {
    const entry = this.pending.get(req);
    if (!entry) return;
    entry.status = 0;
    this.pending.delete(req);
    this.startedAt.delete(entry);
    this.lastWriteActivity = Date.now();
  };

  private onPageError = (err: Error): void => {
    if (this.isThirdPartyError(err)) return;
    this.pageErrors.count += 1;
    if (!this.pageErrors.first) this.pageErrors.first = redactLine(String(err), ERROR_TEXT_CAP);
  };

  private isThirdPartyError(err: Error): boolean {
    return isThirdPartyError(err, this.origins);
  }

  private onConsole = (m: ConsoleMessage): void => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (IGNORED_CONSOLE.some((re) => re.test(text)) || /^\s*Script error\.?\s*$/i.test(text)) return;
    // "Failed to load resource" for a CDN script, a widget's own logging: not the app's.
    const source = m.location()?.url;
    if (source && /^https?:/i.test(source) && !this.isAppUrl(source)) return;
    this.consoleErrors.count += 1;
    if (!this.consoleErrors.first) this.consoleErrors.first = redactLine(text, ERROR_TEXT_CAP);
  };
}

/**
 * The diagnosis-only reload (never part of the walkthrough, and only after the failure has been
 * recorded): opens the current URL again with every non-GET request blocked and looks for the
 * wait's target. True when it shows up: the save worked but the screen was stale.
 */
export async function targetShownAfterReload(page: Page, target: Target, timeoutMs: number): Promise<{ targetShown: boolean; wsSendsDropped: boolean }> {
  const block = (route: import("playwright").Route): Promise<void> =>
    route.request().method() === "GET" ? route.continue() : route.abort();
  await page.route("**/*", block);
  // WebSocket sends too: a route never sees a socket's messages, and a live screen reconnects on
  // the reload (a "subscribe", a presence or autosave message). The connection is allowed, so a
  // screen that draws from what the server pushes still can, but nothing the page sends reaches
  // the server. Page-level, so it wins over a context's own socket route (`aida inspect --after`'s
  // replay lets writes through there), and never removed (Playwright has no
  // `unrouteWebSocket`): the reload is the last thing a failed run does on its page. A screen
  // that needs its "subscribe" to show anything can't show the target this way, so a dropped
  // send is reported: the classification then can't blame the walkthrough (decision 30).
  let wsSendsDropped = false;
  await page.routeWebSocket(/.*/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage(() => {
      wsSendsDropped = true;
    });
    server.onMessage((message) => ws.send(message));
  });
  let targetShown = false;
  try {
    await page.goto(page.url(), { waitUntil: "load", timeout: timeoutMs });
    await waitForNetworkQuiet(page, Math.min(timeoutMs, NETWORK_IDLE_CAP_MS));
    await (await locate(target, page)).waitFor({ state: "visible", timeout: timeoutMs });
    targetShown = true;
  } catch {
    targetShown = false;
  } finally {
    await page.unroute("**/*", block).catch(() => {});
  }
  return { targetShown, wsSendsDropped };
}

export interface Classification {
  category: FailureCategory;
  reason: string;
}

export interface ClassifyInput {
  /** First line of the error. */
  error: string;
  /**
   * Where it failed: a recorded step, the unrecorded setup phase (needs, `setup.steps`), signing
   * in, or anywhere else before the first step ("run": opening the browser or the start page).
   */
  phase: "step" | "setup" | "sign-in" | "run";
  /** The failing step's `changes`, when it was a step. */
  changes?: FailureChanges;
}

function req(r: FailureRequest): string {
  return `${r.method} ${r.path}${r.status === undefined ? " (no answer yet)" : r.status === 0 ? " (no response)" : ` ${r.status}`}`;
}

/**
 * Environment problems recognisable from the error text alone: the app isn't reachable, the
 * browser can't start, a safety check refused. `undefined` when the text says nothing of the sort.
 */
export function classifyErrorMessage(error: string): Classification | undefined {
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/.test(error)) {
    return { category: "environment", reason: "couldn't reach the app (connection refused): is it running at the configured baseUrl?" };
  }
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|ERR_ADDRESS_UNREACHABLE|ERR_CONNECTION_(RESET|TIMED_OUT|CLOSED)|ERR_INTERNET_DISCONNECTED|ERR_UNSAFE_PORT/.test(error)) {
    return { category: "environment", reason: "couldn't reach the app at the configured baseUrl: check the address and that it's running" };
  }
  if (/browserType\.launch|Executable doesn't exist|Failed to launch|Host system is missing dependencies/i.test(error)) {
    return { category: "environment", reason: "the browser couldn't start: run `aida doctor` to check Playwright's browser and libraries" };
  }
  if (/^refusing to|Refusing to capture/i.test(error)) {
    return { category: "environment", reason: "a safety check refused to run this capture, before anything was written" };
  }
  return undefined;
}

/**
 * Suspected owner of a capture failure (decision 30). Heuristic and always worded as a suspicion:
 *   - environment: sign-in or setup failed, the app couldn't be reached, the browser didn't
 *     start, a safety check refused, the app signed the browser out, or the app sent the
 *     browser somewhere other than the page the walkthrough opened before anything was clicked
 *     (a missing precondition)
 *   - app: a 5xx or an uncaught page error from the app, a blank page, a save still waiting for
 *     the server, a save whose result only showed after a reload (stale screen), or a write
 *     that succeeded while the URL and the screen stayed the same and a wait timed out
 *   - undetermined: the evidence fits both the app and the walkthrough and aida couldn't check
 *     which (a save worked, the target never showed, and the diagnosis reload had to block the
 *     page's WebSocket sends): for a person, never the repair skill
 *   - walkthrough: everything else, e.g. a target that was never found with no write and no
 *     server error, a 403 (wrong persona), or a 4xx answer to a save (a missing field or bad
 *     demo data)
 * Only the app's own traffic is in `changes` (see `StepWatch`): third-party failures never count.
 */
export function classifyFailure(input: ClassifyInput): Classification {
  const byMessage = classifyErrorMessage(input.error);
  if (input.phase === "sign-in") {
    return byMessage ?? { category: "environment", reason: "signing in failed, so no step ran: check the sign-in adapter and the persona's demo account" };
  }
  if (input.phase === "setup") {
    return byMessage ?? { category: "environment", reason: "the setup before the first step failed (a state hook or a setup step), so no recorded step ran" };
  }
  if (byMessage) return byMessage;
  if (input.phase === "run") {
    if (/does not match config\.app\.baseUrl/.test(input.error)) {
      return { category: "walkthrough", reason: "the walkthrough's start.baseUrl points somewhere other than the configured app" };
    }
    return { category: "environment", reason: "capture stopped before the first step: the app, browser or config needs a look" };
  }

  const c: FailureChanges = input.changes ?? {
    urlBefore: "",
    urlAfter: "",
    writes: [],
    errorResponses: [],
    pageErrors: { count: 0 },
    consoleErrors: { count: 0 },
    blankPage: false,
  };
  const failedDo = c.failedAction?.do;
  const after = c.lastOkAction ? ` after "${c.lastOkAction.do}"` : "";
  const pathAfter = normalisePath(pathOf(c.urlAfter));
  const responses = [...c.writes, ...c.errorResponses];

  // Sent somewhere else before anything was clicked: the app redirected.
  const expected = c.expectedPath ? normalisePath(c.expectedPath) : undefined;
  if (expected && pathAfter !== expected && c.urlAfter) {
    if (isSignInPath(pathAfter)) {
      return {
        category: "environment",
        reason: `the app sent the browser to its sign-in page (${pathAfter}) instead of ${expected}: the session may have expired or signing in didn't work`,
      };
    }
    if (expected !== "/") {
      return {
        category: "environment",
        reason: `the app sent the browser to ${pathAfter} instead of ${expected}: something the walkthrough needs isn't set up (add a \`needs:\` state with a setup hook, or a setup step)`,
      };
    }
  }
  const startedSignedIn = !isSignInPath(c.urlBefore);
  if (startedSignedIn && isSignInPath(pathAfter)) {
    return { category: "environment", reason: "the app sent the browser to its sign-in page mid-step: the session may have expired" };
  }
  const unauthorised = responses.find((w) => w.status === 401);
  if (unauthorised) {
    return { category: "environment", reason: `the app said nobody is signed in (${req(unauthorised)}): the session may have expired` };
  }
  const serverError = c.errorResponses.find((r) => (r.status ?? 0) >= 500);
  if (serverError) {
    return { category: "app", reason: `suspected app bug: the server failed during this step (${req(serverError)})` };
  }
  if (c.blankPage) {
    return { category: "app", reason: `suspected app bug: the page went blank${after}` };
  }
  const timedOut = /timeout|exceeded/i.test(input.error);
  const waiting = c.writes.find((w) => w.status === undefined);
  if (waiting && timedOut) {
    const secs = waiting.waitedSeconds !== undefined ? ` after ${waiting.waitedSeconds}s` : "";
    return {
      category: "app",
      reason: `suspected app bug: a save was still waiting for the server${secs} (${waiting.method} ${waiting.path}): the app or its server may be stuck or slow`,
    };
  }
  const savedOk = c.writes.find((w) => w.status !== undefined && w.status >= 200 && w.status < 300);
  if (savedOk && c.reload?.targetShown) {
    return {
      category: "app",
      reason: `stale screen: the save worked (${req(savedOk)}) but the page only showed it after a reload (suspected app bug)`,
    };
  }
  if (savedOk && timedOut && failedDo && WAIT_ACTIONS.has(failedDo) && c.urlBefore === c.urlAfter && c.screenChanged === false) {
    return {
      category: "app",
      reason: `suspected app bug: the save request succeeded (${req(savedOk)}) but the screen didn't change`,
    };
  }
  const forbidden = responses.find((w) => w.status === 403);
  if (forbidden) {
    const who = c.signedInAs ? ` for ${c.signedInAs}` : "";
    return { category: "walkthrough", reason: `the app refused this${who} (${req(forbidden)}): the walkthrough may sign in as the wrong person (check its persona)` };
  }
  const rejected = c.writes.find((w) => w.status !== undefined && w.status >= 400 && w.status < 500);
  if (rejected) {
    return {
      category: "walkthrough",
      reason: `the app rejected the save (${req(rejected)}): likely a missing required field or bad demo data`,
    };
  }
  if (c.pageErrors.count > 0) {
    return { category: "app", reason: `suspected app bug: the page threw an error during this step (${c.pageErrors.first ?? "uncaught error"})` };
  }
  if (/ambiguous|strict mode violation/i.test(input.error)) {
    return { category: "walkthrough", reason: "the target matched more than one thing on the page: narrow it with within/exact/nth" };
  }
  // The diagnosis reload had to hold back what the page sends over its live connection (writes
  // are blocked then), and a screen that subscribes before drawing can't show anything without
  // it: a stale screen (the app's) and a wrong target (the walkthrough's) look the same.
  if (savedOk && c.reload && !c.reload.targetShown && c.reload.wsSendsDropped) {
    return {
      category: "undetermined",
      reason: `can't tell whether this is the walkthrough or the app: the save worked (${req(savedOk)}) but the page didn't show what the walkthrough expects, and the diagnosis-only reload couldn't check it because the page needs to send over its live connection (blocked while diagnosing): a person should look`,
    };
  }
  if (savedOk) {
    const screen = c.screenChanged === true ? " and the screen changed" : "";
    return {
      category: "walkthrough",
      reason: `the save went through (${req(savedOk)})${screen}, but the page doesn't show what the walkthrough expects: check what it shows now`,
    };
  }
  if (timedOut) {
    return {
      category: "walkthrough",
      reason: `the target${failedDo ? ` of "${failedDo}"` : ""} was never found (nothing saved, no server error): its name or role may have changed`,
    };
  }
  return { category: "walkthrough", reason: "the page didn't match what the step expects (no server error): check the step against the page" };
}

/** `/dashboard/` -> `/dashboard`; `/` stays. */
function normalisePath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
}

function pathOf(url: string): string {
  try {
    const path = new URL(url, "http://x").pathname;
    try {
      return decodeURI(path);
    } catch {
      return path;
    }
  } catch {
    return url;
  }
}
