// Browser side of reader feedback (M47), shared by the guide page's "Was this helpful?" and the
// search dialog. Posts the entry contract to /api/feedback; the server redacts and stores it.
// Nothing here identifies the reader: no ids, no cookies, and the per-session memory below lives
// in sessionStorage, which the browser drops when the tab closes.

export type FeedbackBody =
  | { kind: "helpful"; page: string }
  | { kind: "not-helpful"; page: string; comment?: string }
  | { kind: "no-results"; query: string; page?: string };

/** Mirrors the engine's caps (feedback/entry.ts FEEDBACK_LIMITS); the server refuses more. */
export const COMMENT_MAX = 300;
export const QUERY_MAX = 120;

/** A static export has no /api routes at all (`aida publish --to static`). */
export const FEEDBACK_UNAVAILABLE = process.env.NEXT_PUBLIC_AIDA_STATIC_EXPORT === "1";

const OFF_KEY = "aida-feedback-off";
const VOTED_KEY = "aida-feedback-voted";
const SEARCHED_KEY = "aida-feedback-searched";
/** Most pages and queries remembered per session: enough for any real visit, bounded for a
 * reader who leaves a tab open for days. */
const MEMORY_MAX = 100;

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** sessionStorage, or nothing (private modes that throw, server render). */
export function sessionStore(): KeyValueStore | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

function readList(store: KeyValueStore | undefined, key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function remember(store: KeyValueStore | undefined, key: string, value: string): void {
  try {
    const list = readList(store, key).filter((v) => v !== value);
    store?.setItem(key, JSON.stringify([...list, value].slice(-MEMORY_MAX)));
  } catch {
    // Storage full or blocked: the worst case is a second vote, which the server takes anyway.
  }
}

export function hasVoted(store: KeyValueStore | undefined, page: string): boolean {
  return readList(store, VOTED_KEY).includes(page);
}

export function markVoted(store: KeyValueStore | undefined, page: string): void {
  remember(store, VOTED_KEY, page);
}

export function hasRecordedSearch(store: KeyValueStore | undefined, query: string): boolean {
  return readList(store, SEARCHED_KEY).includes(query);
}

export function markRecordedSearch(store: KeyValueStore | undefined, query: string): void {
  remember(store, SEARCHED_KEY, query);
}

/** Set after the route failed once (static export, feedback turned off, offline), so the rest of
 * the session doesn't keep trying. */
export function feedbackOff(store: KeyValueStore | undefined): boolean {
  if (FEEDBACK_UNAVAILABLE) return true;
  try {
    return store?.getItem(OFF_KEY) === "1";
  } catch {
    return false;
  }
}

export function markFeedbackOff(store: KeyValueStore | undefined): void {
  try {
    store?.setItem(OFF_KEY, "1");
  } catch {
    // ignore: see remember()
  }
}

// Copy of the engine's `cleanReaderText` character sets (feedback/entry.ts): this file ships to
// the browser, and the engine module pulls in node:fs. Keep the two in step; the help app's
// feedback test checks the keys agree on inputs where these sets matter.
const HIDDEN =
  /[\p{Cf}\p{Co}\p{Cn}\p{Cs}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u3164\ufe00-\ufe0f\uffa0\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
const BREAKS = /[\p{Cc}\p{Zl}\p{Zp}\u2800]/gu;

/** The grouping key for "once per distinct query": the same rule as `aida suggest` uses
 * (`normaliseQuery`), so a reader retyping "Invoices" after "invoices", or a full-width
 * "Ｉｎｖｏｉｃｅｓ", is one search, not two. */
export function searchKey(query: string): string {
  return query
    .normalize("NFKC")
    .replace(HIDDEN, "")
    .replace(BREAKS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** `stored`: the server took it. `unavailable`: the route isn't there or is turned off (static
 * export, `feedback.enabled: false`), so stop for the session. `failed`: anything else (rate
 * limited, offline); try again on a later page. */
export type PostResult = "stored" | "unavailable" | "failed";

/** Posts one entry. `keepalive` lets a vote still go out as the reader leaves the page. */
export async function postFeedback(
  body: FeedbackBody,
  opts: { fetchImpl?: typeof fetch; keepalive?: boolean } = {},
): Promise<PostResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: opts.keepalive,
      credentials: "omit",
    });
    if (res.ok) return "stored";
    return res.status === 404 || res.status === 405 || res.status === 501 ? "unavailable" : "failed";
  } catch {
    return "failed";
  }
}

let cachedEnabled: Promise<boolean> | undefined;

/** The switch as read from a `/feedback-config.json` response. Only a missing file (404) means
 * on, the default for a site built before the setting existed; a file that's there but
 * unreadable, or any other failure, means off, the same rule as the server's
 * `readFeedbackConfig`. */
async function enabledFrom(res: Response): Promise<boolean> {
  if (res.status === 404) return true;
  if (!res.ok) return false;
  const data: unknown = await res.json();
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
  const enabled = (data as { enabled?: unknown }).enabled;
  return enabled === undefined || enabled === true;
}

/** The owner's switch as `aida build` wrote it (public/feedback-config.json). For client code
 * the server can't hand it to, like the search dialog. Cached for the page's life; a test's own
 * `fetchImpl` skips the cache. */
export function loadFeedbackEnabled(fetchImpl?: typeof fetch): Promise<boolean> {
  if (FEEDBACK_UNAVAILABLE) return Promise.resolve(false);
  const load = () =>
    (fetchImpl ?? fetch)("/feedback-config.json")
      .then(enabledFrom)
      .catch(() => false);
  if (fetchImpl) return load();
  cachedEnabled ??= load();
  return cachedEnabled;
}
