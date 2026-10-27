/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { Page } from "playwright";
import type { Target } from "../walkthrough/index.js";
import type { CaptureEvent } from "./types.js";
import { locate } from "./locate.js";
import { profileAsync } from "./profile.js";
import { waitForNetworkQuiet } from "./page-ready.js";

/** Waits two animation frames so a just-made DOM change is actually painted. */
export function paint(page: Page): Promise<void> {
  return page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

/**
 * Waits for every running CSS animation/transition on the page to finish (or a bounded timeout
 * to pass), via `document.getAnimations()` — covers a toast mid-fade or a list row still
 * animating in, which Playwright's own `screenshot({ animations: "disabled" })` doesn't catch
 * (that option freezes animations at the instant of the screenshot call; it doesn't wait for a
 * class-toggle-driven transition to actually reach its end state first). Fixes two sub-0.2%
 * screenshot flaps seen on identical pilot-app code (build-plan.md M19 follow-up): a toast captured
 * mid-fade, and one list row. Best-effort — never throws, and bounded so one animation that
 * never settles (an infinite spinner, `animation-iteration-count: infinite`) can't hang capture.
 */
export async function waitForAnimations(page: Page, timeoutMs = 2000): Promise<void> {
  await profileAsync("waitForAnimations", async () => {
    await page
      .evaluate((timeout) => {
        const finishing = document
          .getAnimations()
          .filter((a) => a.playState === "running")
          .map((a) => a.finished.catch(() => {}));
        if (finishing.length === 0) return Promise.resolve();
        return Promise.race([Promise.all(finishing), new Promise<void>((r) => setTimeout(r, timeout))]);
      }, timeoutMs)
      .catch(() => {});
  });
}

/** Settle's network-idle cap: longer than a page load's (a save's follow-up fetches), still short. */
const SETTLE_IDLE_CAP_MS = 5_000;

/**
 * Waits for the page to go quiet: network idle (capped), skeleton loaders gone, the
 * route-change progress bar gone, running animations/transitions settled, then a short settle
 * pause. Matches the original pipeline's `settle()`; every wait is best-effort (never throws).
 */
export async function settle(page: Page): Promise<void> {
  await profileAsync("settle", async () => {
    // Capped (decision 37): a page with a long-lived request never goes idle, and a step's own
    // wait (`expect`, `waitFor`) is what proves a save finished.
    await waitForNetworkQuiet(page, SETTLE_IDLE_CAP_MS);
    await page
      .waitForFunction(
        () =>
          ![...document.querySelectorAll("main .animate-pulse")].some(
            (el) => el.getBoundingClientRect().height > 0,
          ),
        null,
        { timeout: 30_000 },
      )
      .catch(() => {});
    await page
      .waitForFunction(
        () =>
          ![...document.querySelectorAll("div.fixed.top-0 > div.h-0\\.5")].some(
            (el) => el.getBoundingClientRect().width > 0 && getComputedStyle(el).opacity !== "0",
          ),
        null,
        { timeout: 8_000 },
      )
      .catch(() => {});
    await page.waitForTimeout(350);
    await paint(page);
    await waitForAnimations(page);
  });
}

export interface ScrollOptions {
  align?: "center" | "top";
  margin?: number;
}

interface ScrollPlan {
  from: number;
  to: number;
}

/** Scrolls the target into the comfortable middle band, pushing an eased frame burst into `events`. */
export async function smoothScrollTo(
  page: Page,
  desc: Target,
  events: CaptureEvent[],
  shot: (kind: string, mask?: string[]) => Promise<string>,
  { align = "center", margin = 60 }: ScrollOptions = {},
  mask?: string[],
): Promise<void> {
  const loc = await locate(desc, page);
  await loc.waitFor({ state: "visible" });
  const plan: ScrollPlan | null = await loc.evaluate(
    (el, { align, margin }) => {
      for (let n: HTMLElement | null = el as HTMLElement; n; n = n.parentElement) {
        if (/^(fixed|sticky)$/.test(getComputedStyle(n).position)) return null;
      }
      const scroller = ((): Element => {
        for (let n = (el as HTMLElement).parentElement; n; n = n.parentElement) {
          const oy = getComputedStyle(n).overflowY;
          if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight + 1) return n;
        }
        return document.scrollingElement as Element;
      })();
      const isDoc = scroller === document.scrollingElement;
      const view = isDoc ? { top: 0, height: innerHeight } : scroller.getBoundingClientRect();
      const r = (el as HTMLElement).getBoundingClientRect();
      const visible = r.top >= view.top + margin && r.bottom <= view.top + view.height - margin;
      if (visible && align === "center") return null;
      const anchor = align === "top" ? view.top + view.height * 0.12 : view.top + view.height / 2 - r.height / 2;
      const max = scroller.scrollHeight - scroller.clientHeight;
      const target = Math.max(0, Math.min(max, scroller.scrollTop + (r.top - anchor)));
      if (Math.abs(target - scroller.scrollTop) < 6) return null;
      scroller.setAttribute("data-tutorial-scroller", "1");
      return { from: scroller.scrollTop, to: target };
    },
    { align, margin },
  );
  if (!plan) return;
  const n = Math.max(6, Math.min(16, Math.round(Math.abs(plan.to - plan.from) / 45)));
  const images: string[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const y = plan.from + (plan.to - plan.from) * e;
    await page.evaluate((y) => {
      document.querySelector("[data-tutorial-scroller]")!.scrollTop = y;
    }, y);
    await paint(page);
    images.push(await shot("scroll", mask));
  }
  await page.evaluate(() => document.querySelector("[data-tutorial-scroller]")?.removeAttribute("data-tutorial-scroller"));
  events.push({ type: "scrollFrames", images });
}
