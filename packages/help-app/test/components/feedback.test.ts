import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { normaliseQuery } from "aida-docs/dist/feedback/index.js";
import {
  feedbackOff,
  hasRecordedSearch,
  hasVoted,
  loadFeedbackEnabled,
  markFeedbackOff,
  markRecordedSearch,
  markVoted,
  postFeedback,
  searchKey,
  type FeedbackBody,
  type KeyValueStore,
  type PostResult,
} from "../../components/site/feedback-client";
import {
  NOT_SENT,
  PageFeedback,
  PageFeedbackView,
  THANKS,
  VoteFlow,
  afterSend,
  focusAfter,
  initialState,
  type VoteView,
} from "../../components/site/page-feedback";
import { SEARCH_MIN_CHARS, SEARCH_PAUSE_MS, SearchMissRecorder } from "../../components/site/search-feedback";

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

function fakeFetch(status: number | "throw") {
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    if (status === "throw") throw new TypeError("network");
    return new Response(null, { status });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("page control markup", () => {
  const html = renderToStaticMarkup(createElement(PageFeedback, { page: "/billing/refunds" }));

  it("asks with real buttons under a heading that labels the region", () => {
    expect(html).toMatch(/<section[^>]*aria-labelledby="([^"]+)"/);
    const labelled = html.match(/aria-labelledby="([^"]+)"/)![1];
    expect(html).toContain(`<h2 id="${labelled}"`);
    expect(html).toContain("Was this helpful?");
    expect(html.match(/<button type="button"/g)).toHaveLength(2);
    expect(html).toMatch(/>Yes<\/button>/);
    expect(html).toMatch(/aria-expanded="false"[^>]*>No<\/button>/);
  });

  it("is hidden in print and keeps a live region ready for the result", () => {
    expect(html).toMatch(/<section[^>]*class="[^"]*print:hidden/);
    expect(html).toContain('role="status"');
  });

  it("doesn't render the comment field until No is pressed, nor point aria-controls at it", () => {
    expect(html).not.toContain("<input");
    expect(html).not.toContain("aria-controls");
  });

  it("renders nothing when the owner's switch is off", () => {
    expect(renderToStaticMarkup(createElement(PageFeedback, { page: "/billing/refunds", enabled: false }))).toBe("");
  });
});

describe("page control markup in each state", () => {
  const render = (view: VoteView) => renderToStaticMarkup(createElement(PageFeedbackView, { view, comment: "", idBase: "fb" }));

  it("ties the field to its hint and No to the form, once the form is there", () => {
    const html = render({ state: "asking", message: "", fieldOpen: true });
    expect(html).toContain('<form id="fb-form"');
    expect(html).toMatch(/aria-expanded="true" aria-controls="fb-form"[^>]*>No</);
    expect(html).toMatch(/<input[^>]*aria-describedby="fb-hint"/);
    expect(html).toMatch(/<p id="fb-hint"[^>]*>Please don&#x27;t include personal details/);
  });

  it("keeps every control focusable while sending: aria-disabled and read-only, never disabled", () => {
    const html = render({ state: "sending", message: "", fieldOpen: true });
    expect(html).not.toMatch(/\sdisabled(=|\s|>)/);
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(3);
    expect(html).toMatch(/<input[^>]*readOnly/i);
  });

  it("shows only the thanks once voted", () => {
    const html = render({ state: "voted-before", message: "", fieldOpen: false });
    expect(html).not.toContain("<button");
    expect(html).toContain(THANKS);
    expect(render({ state: "gone", message: "", fieldOpen: false })).toBe("");
  });
});

describe("focus after a send", () => {
  it("goes to the thanks, to the page when the control removes itself under focus, and stays put otherwise", () => {
    expect(focusAfter("done", true)).toBe("status");
    expect(focusAfter("gone", true)).toBe("page");
    expect(focusAfter("gone", false)).toBe("none");
    expect(focusAfter("idle", true)).toBe("none");
    expect(focusAfter("asking", true)).toBe("none");
  });
});

describe("VoteFlow", () => {
  function setup(results: PostResult[] = ["stored"], store = memoryStore(), page = "/billing/refunds") {
    const posts: FeedbackBody[] = [];
    const post = vi.fn(async (body: FeedbackBody) => {
      posts.push(body);
      return results.shift() ?? "stored";
    });
    const flow = new VoteFlow({ page, post, store: () => store });
    return { flow, posts, store, post };
  }

  it("sends nothing when No is pressed, so leaving after a misclick records nothing", () => {
    // Only Send sends the not-helpful vote; the control has no leave (pagehide) handler at all.
    const { flow, posts } = setup();
    flow.pressNo();
    expect(flow.view).toEqual({ state: "asking", message: "", fieldOpen: true });
    expect(posts).toEqual([]);
  });

  it("lets Yes undo a No pressed by mistake: one helpful vote, nothing else", async () => {
    const { flow, posts } = setup();
    flow.pressNo();
    await flow.pressYes();
    expect(posts).toEqual([{ kind: "helpful", page: "/billing/refunds" }]);
    expect(flow.view.state).toBe("done");
  });

  it("sends one not-helpful vote with its comment on Send, however many times Send is pressed", async () => {
    const { flow, posts } = setup();
    flow.pressNo();
    await Promise.all([flow.submit("  partial refunds  "), flow.submit("partial refunds"), flow.submit("")]);
    expect(posts).toEqual([{ kind: "not-helpful", page: "/billing/refunds", comment: "partial refunds" }]);
    await flow.submit("again");
    await flow.pressYes();
    expect(posts).toHaveLength(1);
  });

  it("remembers the vote for the session: a new view of the page (or one restored from the back-forward cache) can't vote again", async () => {
    const { flow, store, posts } = setup();
    await flow.pressYes();
    expect(hasVoted(store, "/billing/refunds")).toBe(true);
    const again = new VoteFlow({ page: "/billing/refunds", post: async (b) => (posts.push(b), "stored"), store: () => store });
    expect(again.view.state).toBe("voted-before");
    await again.pressYes();
    again.pressNo();
    expect(posts).toHaveLength(1);
  });

  it("refreshes from the session when another view voted first, and then sends nothing", async () => {
    const store = memoryStore();
    const { flow, posts } = setup(["stored"], store);
    flow.pressNo();
    markVoted(store, "/billing/refunds");
    flow.refresh();
    expect(flow.view.state).toBe("voted-before");
    await flow.submit("x");
    expect(posts).toEqual([]);
    // Even without a refresh, a send checks the session first.
    const other = setup(["stored"], memoryStore());
    other.flow.pressNo();
    markVoted(other.store, "/billing/refunds");
    await other.flow.submit("x");
    expect(other.posts).toEqual([]);
  });

  it("keeps the field open with a retry message when Send fails, and lets the retry through", async () => {
    const { flow, posts } = setup(["failed", "stored"]);
    flow.pressNo();
    await flow.submit("refunds");
    expect(flow.view).toEqual({ state: "asking", message: NOT_SENT, fieldOpen: true });
    await flow.submit("refunds");
    expect(flow.view.state).toBe("done");
    expect(posts).toHaveLength(2);
  });

  it("goes idle with a message when Yes fails, and away for the session when the route is missing", async () => {
    const failed = setup(["failed"]);
    await failed.flow.pressYes();
    expect(failed.flow.view).toEqual({ state: "idle", message: NOT_SENT, fieldOpen: false });
    expect(hasVoted(failed.store, "/billing/refunds")).toBe(false);

    const gone = setup(["unavailable"]);
    await gone.flow.pressYes();
    expect(gone.flow.view.state).toBe("gone");
    expect(feedbackOff(gone.store)).toBe(true);
    expect(new VoteFlow({ page: "/other", post: gone.post, store: () => gone.store }).view.state).toBe("gone");
  });
});

describe("page control states", () => {
  it("thanks the reader once the vote is stored", () => {
    expect(afterSend("stored", false)).toEqual({ state: "done", message: THANKS, off: false });
  });

  it("removes itself quietly, for the session, when the route isn't there", () => {
    expect(afterSend("unavailable", true)).toEqual({ state: "gone", message: "", off: true });
  });

  it("says a failed send didn't go and keeps the field open to retry", () => {
    expect(afterSend("failed", true)).toEqual({ state: "asking", message: NOT_SENT, off: false });
    expect(afterSend("failed", false).state).toBe("idle");
  });

  it("starts as already voted on a page voted on this session, or gone when feedback is off", () => {
    expect(initialState(false, false)).toBe("idle");
    expect(initialState(false, true)).toBe("voted-before");
    expect(initialState(true, false)).toBe("gone");
  });
});

describe("session memory", () => {
  it("remembers one vote per page", () => {
    const store = memoryStore();
    expect(hasVoted(store, "/a")).toBe(false);
    markVoted(store, "/a");
    markVoted(store, "/a");
    expect(hasVoted(store, "/a")).toBe(true);
    expect(hasVoted(store, "/b")).toBe(false);
    expect(JSON.parse(store.data.get("aida-feedback-voted")!)).toEqual(["/a"]);
  });

  it("stays bounded", () => {
    const store = memoryStore();
    for (let i = 0; i < 150; i++) markRecordedSearch(store, `q${i}`);
    expect(JSON.parse(store.data.get("aida-feedback-searched")!)).toHaveLength(100);
    expect(hasRecordedSearch(store, "q149")).toBe(true);
  });

  it("survives broken or missing storage", () => {
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(() => markVoted(broken, "/a")).not.toThrow();
    expect(hasVoted(broken, "/a")).toBe(false);
    expect(feedbackOff(undefined)).toBe(false);
    const store = memoryStore();
    markFeedbackOff(store);
    expect(feedbackOff(store)).toBe(true);
  });
});

describe("loadFeedbackEnabled (the search dialog's view of the switch)", () => {
  const respond = (status: number, body?: string) => vi.fn(async () => new Response(body ?? null, { status })) as unknown as typeof fetch;

  it("is on only when the file says so or is missing", async () => {
    expect(await loadFeedbackEnabled(respond(200, '{"enabled":true}'))).toBe(true);
    expect(await loadFeedbackEnabled(respond(200, "{}"))).toBe(true);
    expect(await loadFeedbackEnabled(respond(404))).toBe(true);
  });

  it("is off when the file says so, or is there but unreadable, or can't be fetched", async () => {
    expect(await loadFeedbackEnabled(respond(200, '{"enabled":false}'))).toBe(false);
    expect(await loadFeedbackEnabled(respond(200, "{broken"))).toBe(false);
    expect(await loadFeedbackEnabled(respond(200, "[]"))).toBe(false);
    expect(await loadFeedbackEnabled(respond(200, '{"enabled":"yes"}'))).toBe(false);
    expect(await loadFeedbackEnabled(respond(500))).toBe(false);
    expect(await loadFeedbackEnabled(fakeFetch("throw"))).toBe(false);
  });
});

describe("postFeedback", () => {
  it("posts the entry contract as JSON with no credentials", async () => {
    const f = fakeFetch(204);
    expect(await postFeedback({ kind: "not-helpful", page: "/a", comment: "refunds" }, { fetchImpl: f })).toBe("stored");
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/feedback");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("omit");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ kind: "not-helpful", page: "/a", comment: "refunds" });
  });

  it("tells a missing or switched-off route apart from a passing failure", async () => {
    expect(await postFeedback({ kind: "helpful", page: "/a" }, { fetchImpl: fakeFetch(404) })).toBe("unavailable");
    expect(await postFeedback({ kind: "helpful", page: "/a" }, { fetchImpl: fakeFetch(405) })).toBe("unavailable");
    expect(await postFeedback({ kind: "helpful", page: "/a" }, { fetchImpl: fakeFetch(429) })).toBe("failed");
    expect(await postFeedback({ kind: "helpful", page: "/a" }, { fetchImpl: fakeFetch("throw") })).toBe("failed");
  });
});

describe("SearchMissRecorder", () => {
  function setup() {
    vi.useFakeTimers();
    const store = memoryStore();
    const sent: string[] = [];
    const recorder = new SearchMissRecorder({
      send: (q) => void sent.push(q),
      isRecorded: (k) => hasRecordedSearch(store, k),
      markRecorded: (k) => markRecordedSearch(store, k),
    });
    return { recorder, sent };
  }

  it("records nothing per keystroke, only once the reader pauses on a query with no results", () => {
    const { recorder, sent } = setup();
    for (const q of ["inv", "invo", "invoi", "invoic"]) {
      recorder.update(q, 0);
      vi.advanceTimersByTime(SEARCH_PAUSE_MS - 100);
    }
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(sent).toEqual(["invoic"]);
    vi.useRealTimers();
  });

  it("records once per distinct query, however it's cased or punctuated", () => {
    const { recorder, sent } = setup();
    recorder.update("Export invoices", 0);
    vi.advanceTimersByTime(SEARCH_PAUSE_MS);
    recorder.update("export invoices?", 0);
    vi.advanceTimersByTime(SEARCH_PAUSE_MS);
    recorder.update("export invoices", 0);
    recorder.flush();
    expect(sent).toEqual(["Export invoices"]);
    vi.useRealTimers();
  });

  it("records straight away when the dialog closes on a no-result query", () => {
    const { recorder, sent } = setup();
    recorder.update("tax report", 0);
    recorder.flush();
    expect(sent).toEqual(["tax report"]);
    vi.advanceTimersByTime(SEARCH_PAUSE_MS);
    expect(sent).toEqual(["tax report"]);
    vi.useRealTimers();
  });

  it("ignores queries with results, short queries, and an index still loading", () => {
    const { recorder, sent } = setup();
    recorder.update("refunds", 3);
    recorder.flush();
    recorder.update("x".repeat(SEARCH_MIN_CHARS - 1), 0);
    recorder.flush();
    recorder.update("anything", undefined);
    recorder.flush();
    expect(sent).toEqual([]);
    vi.useRealTimers();
  });

  it("drops a pending query when the reader types on to one with results", () => {
    const { recorder, sent } = setup();
    recorder.update("refun", 0);
    recorder.update("refund", 2);
    vi.advanceTimersByTime(SEARCH_PAUSE_MS * 2);
    recorder.flush();
    expect(sent).toEqual([]);
    vi.useRealTimers();
  });

  it("records nothing while the switch is off, even on close", () => {
    vi.useFakeTimers();
    let enabled = false;
    const sent: string[] = [];
    const store = memoryStore();
    const recorder = new SearchMissRecorder({
      isEnabled: () => enabled,
      send: (q) => void sent.push(q),
      isRecorded: (k) => hasRecordedSearch(store, k),
      markRecorded: (k) => markRecordedSearch(store, k),
    });
    recorder.update("tax report", 0);
    vi.advanceTimersByTime(SEARCH_PAUSE_MS);
    recorder.flush();
    expect(sent).toEqual([]);
    expect(hasRecordedSearch(store, "tax report")).toBe(false);
    enabled = true;
    recorder.update("tax report", 0);
    enabled = false;
    recorder.flush();
    expect(sent).toEqual([]);
    vi.useRealTimers();
  });

  it("caps the query sent", () => {
    const { recorder, sent } = setup();
    recorder.update("long ".repeat(60), 0);
    recorder.flush();
    expect(sent[0].length).toBeLessThanOrEqual(120);
    vi.useRealTimers();
  });
});

describe("searchKey", () => {
  it("groups queries the same way aida suggest does", () => {
    for (const q of ["  Export   Invoices?! ", "tax-report 2026", "what's new", "Café menu"]) {
      expect(searchKey(q)).toBe(normaliseQuery(q));
    }
  });

  it("agrees with aida suggest where Unicode normalisation and invisible characters matter", () => {
    const tags = Array.from({ length: 5 }, (_, i) => String.fromCodePoint(0xe0041 + i)).join("");
    const inputs = [
      "Ｅｘｐｏｒｔ Ｉｎｖｏｉｃｅｓ", // full-width
      "Cafe\u0301 menu", // decomposed é
      "\ufb01le upload", // ligature
      "ex\u200bport invoices", // zero-width space
      `refund${tags} policy`, // tag characters
      "in\u00advoice\ufe0f", // soft hyphen, variation selector
      "tax\u3164report", // Hangul filler
      "line\u2028break", // line separator
      "x²  ① ™", // compatibility forms
    ];
    for (const q of inputs) expect(searchKey(q), JSON.stringify(q)).toBe(normaliseQuery(q));
    expect(searchKey("Ｅｘｐｏｒｔ Ｉｎｖｏｉｃｅｓ")).toBe("export invoices");
  });
});
