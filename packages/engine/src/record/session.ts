// The Node side of `aida record`: listens to the page script (page-script.ts) through one
// binding, works out each element's target while it's still on screen (resolve-target.ts), and
// keeps the person's actions in order until they press Finish, close the window, or the command
// is stopped.
//
// Order matters more than speed: every message is appended to the list the moment it arrives,
// with its target as a promise, and `finish()` waits for them all. Hover messages only warm the
// cache, so by the time a click arrives its target has usually been checked already.
import type { BrowserContext, Page } from "playwright";
import { RECORDER_SCRIPT } from "./page-script.js";
import { resolveTarget, unverifiedTarget } from "./resolve-target.js";
import type { ElementInfo, PageMessage, RecordedAction, RecorderStatus, ResolvedTarget } from "./types.js";

/** A navigation this soon after something the person did is taken to be caused by it. */
const CAUSED_NAVIGATION_MS = 10_000;
/** Working out one target gives up after this, and uses the page's own description instead. */
const RESOLVE_DEADLINE_MS = 5_000;
/** Any one Playwright call while recording: an element that's gone isn't coming back. */
const RECORDING_TIMEOUT_MS = 2_000;

type Pending =
  | { kind: "click"; at: Promise<ResolvedTarget>; field: boolean }
  | { kind: "type"; at: Promise<ResolvedTarget>; marker: string; text: string; secret: boolean }
  | { kind: "select"; at: Promise<ResolvedTarget>; option: string }
  | { kind: "point" | "expect"; at: Promise<ResolvedTarget> }
  | Exclude<RecordedAction, { at: ResolvedTarget }>;

export interface RecorderOptions {
  log?: (line: string) => void;
}

export class Recorder {
  private readonly items: Pending[] = [];
  private readonly cache = new Map<string, Promise<ResolvedTarget>>();
  private lastActionAt = 0;
  private lastPath: string;
  private readonly origin: string;
  private finishResolve!: () => void;
  private finished = false;
  readonly done: Promise<void>;

  private constructor(
    private readonly page: Page,
    private readonly opts: RecorderOptions,
  ) {
    this.lastPath = pathOf(page.url());
    this.origin = originOf(page.url());
    this.done = new Promise((resolve) => {
      this.finishResolve = resolve;
    });
  }

  /** Starts recording on `page` (the context's other pages and frames are ignored). */
  static async attach(context: BrowserContext, page: Page, opts: RecorderOptions = {}): Promise<Recorder> {
    const rec = new Recorder(page, opts);
    // The runner's 30 s default is for waiting on a replay; here a lookup on a page the person
    // has already left would only hold up the draft.
    page.setDefaultTimeout(RECORDING_TIMEOUT_MS);
    await context.exposeBinding("__aidaRecord", (source, msg: PageMessage) => {
      if (source.page !== page || source.frame !== page.mainFrame()) return null;
      return rec.receive(msg);
    });
    await context.addInitScript(RECORDER_SCRIPT);
    await page.evaluate(RECORDER_SCRIPT).catch(() => {});

    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) rec.navigated(frame.url());
    });
    // Capture can't answer a browser dialog, so the recording mustn't either: dismiss it, the way
    // a replay would, and say so in the draft.
    page.on("dialog", (dialog) => {
      rec.items.push({
        kind: "todo",
        text: `the app opened a browser ${dialog.type()} ("${dialog.message().slice(0, 80)}"); it was dismissed, as a replay would dismiss it`,
      });
      void dialog.dismiss().catch(() => {});
    });
    page.on("close", () => rec.finish());
    context.browser()?.on("disconnected", () => rec.finish());
    context.on("page", (other) => {
      if (other === page) return;
      rec.items.push({ kind: "todo", text: "a new tab or window opened; only the first tab is recorded" });
    });
    return rec;
  }

  /** Stops listening for more; `actions()` then returns what was recorded. */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.finishResolve();
  }

  /** Resolves once every target asked for so far has been worked out. */
  async settled(): Promise<void> {
    await Promise.all(this.cache.values());
  }

  get isFinished(): boolean {
    return this.finished;
  }

  /** Everything recorded, in order, with every target worked out. */
  async actions(): Promise<RecordedAction[]> {
    const out: RecordedAction[] = [];
    for (const item of this.items) {
      switch (item.kind) {
        case "click":
          out.push({ kind: "click", at: await item.at, field: item.field });
          break;
        case "type":
          out.push({ kind: "type", at: await item.at, text: item.text, secret: item.secret });
          break;
        case "select":
          out.push({ kind: "select", at: await item.at, option: item.option });
          break;
        case "point":
        case "expect":
          out.push({ kind: item.kind, at: await item.at });
          break;
        default:
          out.push(item);
      }
    }
    return out;
  }

  /** How many actions (not notes or waits) have been recorded. */
  get count(): number {
    return this.items.filter((i) => ["click", "type", "select", "point", "expect"].includes(i.kind) || (i.kind === "navigate" && !i.byAction)).length;
  }

  private target(el: ElementInfo, kind: "act" | "see"): Promise<ResolvedTarget> {
    const key = `${kind}:${el.marker}`;
    let p = this.cache.get(key);
    if (!p) {
      const fallback = unverifiedTarget(el, kind);
      p = Promise.race([
        resolveTarget(this.page, el, kind).catch(() => fallback),
        new Promise<ResolvedTarget>((resolve) => setTimeout(() => resolve(fallback), RESOLVE_DEADLINE_MS).unref()),
      ]);
      this.cache.set(key, p);
    }
    return p;
  }

  private status(last?: string): RecorderStatus {
    return { actions: this.count, ...(last ? { last } : {}), ...(this.finished ? { finished: true } : {}) };
  }

  private say(line: string): string {
    this.opts.log?.(line);
    return line;
  }

  /** Handles one message from the page; returns the toolbar's new status. */
  receive(msg: PageMessage): RecorderStatus | null {
    if (this.finished) return this.status();
    const words = (el: ElementInfo): string => el.name ?? el.labelDirect ?? el.placeholder ?? el.text ?? el.tag;
    switch (msg.kind) {
      case "hello":
        return this.status();
      case "hover":
        void this.target(msg.el, "act");
        return null;
      case "click":
        this.lastActionAt = Date.now();
        this.items.push({ kind: "click", at: this.target(msg.el, "act"), field: msg.field });
        return this.status(this.say(`click "${words(msg.el)}"`));
      case "input": {
        const last = this.items[this.items.length - 1];
        if (last?.kind === "type" && last.marker === msg.el.marker) {
          last.text = msg.value;
          return null;
        }
        this.lastActionAt = Date.now();
        this.items.push({ kind: "type", at: this.target(msg.el, "act"), marker: msg.el.marker, text: msg.value, secret: msg.secret });
        return this.status(this.say(`fill "${words(msg.el)}"`));
      }
      case "select":
        this.lastActionAt = Date.now();
        this.items.push({ kind: "select", at: this.target(msg.el, "act"), option: msg.option });
        return this.status(this.say(`choose "${msg.option}" in "${words(msg.el)}"`));
      case "point":
      case "expect":
        this.items.push({ kind: msg.kind, at: this.target(msg.el, "see") });
        return this.status(this.say(`${msg.kind === "point" ? "point at" : "check shown"} "${words(msg.el)}"`));
      case "file":
        this.items.push({ kind: "todo", text: `a file was chosen in "${words(msg.el)}"; file uploads aren't recorded` });
        return this.status(this.say("file upload (not recorded)"));
      case "submit":
        this.lastActionAt = Date.now();
        if (msg.submitter) {
          this.items.push({ kind: "click", at: this.target(msg.submitter, "act"), field: false });
          this.items.push({ kind: "todo", text: `Enter was pressed to send the form; this step clicks "${words(msg.submitter)}" instead` });
          return this.status(this.say(`press Enter (recorded as click "${words(msg.submitter)}")`));
        }
        this.items.push({ kind: "todo", text: "Enter was pressed to send a form that has no button to click; add the step that sends it" });
        return this.status(this.say("press Enter (no button to record)"));
      case "note":
        this.items.push({ kind: "note", text: msg.text });
        return this.status(this.say(`note "${msg.text}"`));
      case "step":
        this.items.push({ kind: "step", ...(msg.title ? { title: msg.title } : {}) });
        return this.status(this.say(msg.title ? `new step "${msg.title}"` : "new step"));
      case "undo": {
        for (let i = this.items.length - 1; i >= 0; i--) {
          const kind = this.items[i].kind;
          // A wait for the page a click led to goes with the click.
          if (kind === "navigate" && (this.items[i] as { byAction: boolean }).byAction) continue;
          this.items.splice(i);
          return this.status(this.say(`undo ${kind}`));
        }
        return this.status();
      }
      case "finish":
        this.finish();
        return this.status();
    }
  }

  private navigated(url: string): void {
    if (this.finished) return;
    const path = pathOf(url);
    if (!path) return;
    if (originOf(url) !== this.origin) {
      this.items.push({ kind: "todo", text: `the page left the app for ${originOf(url)}; a walkthrough stays on the app's own pages` });
      this.say(`left the app for ${originOf(url)}`);
      return;
    }
    if (path === this.lastPath) return;
    this.lastPath = path;
    const byAction = Date.now() - this.lastActionAt < CAUSED_NAVIGATION_MS;
    this.items.push({ kind: "navigate", path, byAction });
    this.say(byAction ? `  page moved to ${path}` : `go to ${path}`);
  }
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.pathname;
  } catch {
    return "";
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}
