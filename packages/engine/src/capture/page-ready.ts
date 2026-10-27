// Waiting for a page to be ready without trusting network idle (decision 37). Real apps keep a
// request open for minutes (a live-updates stream, long polling, an analytics beacon), so
// Playwright's `networkidle` never arrives and a `goto(..., { waitUntil: "networkidle" })` times
// out. Every wait here is: the `load` event, then network idle for at most a short cap, then a
// small settle. Only the `load` part can fail; the idle part never does.
import type { Page, Response } from "playwright";

/** How long to wait for network idle after `load` before carrying on anyway. */
export const NETWORK_IDLE_CAP_MS = 3_000;
/** A short pause after the idle wait, for a last render. */
export const READY_SETTLE_MS = 250;

export interface ReadyOptions {
  /** Cap on the idle wait (default `NETWORK_IDLE_CAP_MS`). */
  idleCapMs?: number;
  /** Pause after the idle wait (default `READY_SETTLE_MS`). */
  settleMs?: number;
}

/** Waits for network idle for at most `capMs`; never throws. */
export async function waitForNetworkQuiet(page: Page, capMs = NETWORK_IDLE_CAP_MS): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: capMs }).catch(() => {});
}

/** The page is loaded (`load`, bounded by `timeout`), then network idle (capped, never fails),
 * then a short settle. */
export async function waitForPageReady(page: Page, timeout: number, opts: ReadyOptions = {}): Promise<void> {
  await page.waitForLoadState("load", { timeout });
  await waitForNetworkQuiet(page, opts.idleCapMs);
  await page.waitForTimeout(opts.settleMs ?? READY_SETTLE_MS);
}

/** `page.goto` that waits for `load` (bounded by `timeout`), then idle (capped) and a settle. Use
 * this instead of `waitUntil: "networkidle"`. */
export async function gotoReady(page: Page, url: string, timeout: number, opts: ReadyOptions = {}): Promise<Response | null> {
  const response = await page.goto(url, { waitUntil: "load", timeout });
  await waitForNetworkQuiet(page, opts.idleCapMs);
  await page.waitForTimeout(opts.settleMs ?? READY_SETTLE_MS);
  return response;
}
