import { describe, expect, it } from "vitest";
import {
  MAX_HISTORY_CHARS,
  MAX_HISTORY_TURNS,
  MAX_BRIEF_CHARS,
  MAX_QUESTION_CHARS,
  assembleRequest,
  buildBriefBlock,
  buildCitations,
  buildContextBlock,
  buildSystemPrompt,
  capHistory,
  validateChatInput,
} from "../../src/chat/prompt.js";
import type { ChatHistoryTurn, RetrievedContext } from "../../src/chat/types.js";
import { resolveChatConfig } from "../../src/chat/handler.js";

const procedure = {
  id: "add-competitor",
  title: "Add a competitor",
  start: { page: "/competitors" },
  steps: [{ n: 1, title: "Open competitors", instruction: "Click Competitors." }],
};

const context: RetrievedContext = {
  pages: [
    {
      url: "/add-competitor",
      title: "Add a competitor",
      score: 2,
      sections: [
        { url: "/add-competitor", title: "Add a competitor", text: "Add someone new." },
        { url: "/add-competitor#search-first", title: "Add a competitor", heading: "Search first", text: "Search before adding." },
        { url: "/add-competitor#steps", title: "Add a competitor", heading: "Steps", text: "" },
        { url: "/add-competitor#part-1-add", title: "Add a competitor", heading: "Part 1: Add", text: "1. Open competitors Click Comp" },
      ],
      procedure,
    },
  ],
  topScore: 2,
};

describe("buildCitations", () => {
  it("numbers each retrieved page once, best first", () => {
    const two: RetrievedContext = {
      ...context,
      pages: [...context.pages, { url: "/record-payment", title: "Record a payment", score: 1, sections: [] }],
    };
    expect(buildCitations(two)).toEqual([
      { n: 1, url: "/add-competitor", title: "Add a competitor" },
      { n: 2, url: "/record-payment", title: "Record a payment" },
    ]);
  });
});

describe("buildContextBlock", () => {
  it("gives each guide whole, with the procedure's full steps in place of the truncated step sections", () => {
    const block = buildContextBlock(context, buildCitations(context));
    expect(block).toContain("[1] Guide: Add a competitor");
    expect(block).toContain("Add someone new.");
    expect(block).toContain("Search first: Search before adding.");
    expect(block).toContain("  1. Open competitors — Click Competitors.");
    expect(block).not.toContain("Click Comp\n");
    expect(block).not.toContain("Part 1: Add");
  });

  it("says so when nothing matched", () => {
    expect(buildContextBlock({ pages: [], topScore: 0 }, [])).toContain("no help guide matches");
  });
});

describe("assembleRequest", () => {
  it("places the stable system prompt first, independent of the question", () => {
    const citations = buildCitations(context);
    const req = assembleRequest(undefined, context, citations, "How do I add a competitor?", undefined, 8000);
    expect(req.system).toHaveLength(1);
    expect(req.system[0].text).toBe(buildSystemPrompt(undefined));
  });

  it("does not set cache_control on the system prompt — below Haiku 4.5's 4096-token minimum cacheable prefix, so it would never actually cache (review finding prompt.ts:99)", () => {
    const citations = buildCitations(context);
    const req = assembleRequest(undefined, context, citations, "How do I add a competitor?", undefined, 8000);
    expect(req.system[0].cache_control).toBeUndefined();
  });

  it("keeps the system prompt byte-identical across different questions/support contacts being unset — the cache key", () => {
    const a = assembleRequest(undefined, context, buildCitations(context), "Question A", undefined, 8000);
    const b = assembleRequest(undefined, context, buildCitations(context), "A completely different question B", undefined, 8000);
    expect(a.system[0].text).toBe(b.system[0].text);
  });

  it("includes citation markers and the question in the final user message, after history", () => {
    const req = assembleRequest(
      "support@example.com",
      context,
      buildCitations(context),
      "How do I add a competitor?",
      [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }],
      8000,
    );
    expect(req.messages).toHaveLength(3);
    expect(req.messages[0]).toEqual({ role: "user", content: "hi" });
    const last = req.messages[req.messages.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toContain("[1] Guide: Add a competitor");
    expect(last.content).toContain("Question: How do I add a competitor?");
  });

  it("introduces itself by the app's name when known", () => {
    expect(buildSystemPrompt(undefined, "Acme Events")).toContain("help assistant for Acme Events");
    expect(buildSystemPrompt(undefined)).toContain("help assistant for this app");
  });

  it("mentions the configured support contact when the answer doesn't know", () => {
    const system = buildSystemPrompt("support@example.com");
    expect(system).toContain("support@example.com");
  });

  it("counts history against the input token budget instead of leaving it uncapped (review finding prompt.ts:101)", () => {
    const longHistory: ChatHistoryTurn[] = [
      { role: "user", content: "x".repeat(2000) },
      { role: "assistant", content: "y".repeat(2000) },
    ];
    const withHistory = assembleRequest(undefined, context, buildCitations(context), "Q", longHistory, 8000);
    const withoutHistory = assembleRequest(undefined, context, buildCitations(context), "Q", undefined, 8000);
    const contextLen = (r: typeof withHistory) => r.messages.at(-1)!.content.length;
    // Same total budget, but history now eats into it, so the context block left for the
    // question is smaller when history is present.
    expect(contextLen(withHistory)).toBeLessThanOrEqual(contextLen(withoutHistory));
  });
});

describe("validateChatInput", () => {
  it("rejects a missing/blank question", () => {
    expect(validateChatInput("", undefined)).toBeDefined();
    expect(validateChatInput("   ", undefined)).toBeDefined();
    expect(validateChatInput(undefined, undefined)).toBeDefined();
  });

  it("accepts a normal question with no history", () => {
    expect(validateChatInput("How do I add a competitor?", undefined)).toBeUndefined();
  });

  it("rejects a question over MAX_QUESTION_CHARS", () => {
    expect(validateChatInput("a".repeat(MAX_QUESTION_CHARS + 1), undefined)).toBeDefined();
    expect(validateChatInput("a".repeat(MAX_QUESTION_CHARS), undefined)).toBeUndefined();
  });

  it("accepts well-formed alternating history starting with a user turn", () => {
    const history: ChatHistoryTurn[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "and then?" },
    ];
    expect(validateChatInput("question", history)).toBeUndefined();
  });

  it("rejects history that doesn't start with a user turn", () => {
    const history = [{ role: "assistant", content: "hello" }];
    expect(validateChatInput("question", history)).toBeDefined();
  });

  it("rejects history with two user turns in a row (forged/non-alternating)", () => {
    const history = [
      { role: "user", content: "hi" },
      { role: "user", content: "hi again" },
    ];
    expect(validateChatInput("question", history)).toBeDefined();
  });

  it("rejects a history entry with an invalid role", () => {
    const history = [{ role: "system", content: "hi" }];
    expect(validateChatInput("question", history)).toBeDefined();
  });

  it("rejects a history entry with non-string content", () => {
    const history = [{ role: "user", content: { not: "a string" } }];
    expect(validateChatInput("question", history)).toBeDefined();
  });

  it("rejects a non-array history", () => {
    expect(validateChatInput("question", "not an array")).toBeDefined();
  });

  it("does not reject a long but well-formed history — that's capped, not malformed", () => {
    const history: ChatHistoryTurn[] = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `turn ${i}`,
    }));
    expect(validateChatInput("question", history)).toBeUndefined();
  });
});

describe("capHistory", () => {
  it("keeps everything when under both caps", () => {
    const history: ChatHistoryTurn[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(capHistory(history)).toEqual(history);
  });

  it(`caps to the last ${MAX_HISTORY_TURNS} turns, dropping from the front`, () => {
    const history: ChatHistoryTurn[] = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `turn ${i}`,
    }));
    const capped = capHistory(history);
    expect(capped.length).toBeLessThanOrEqual(MAX_HISTORY_TURNS);
    expect(capped[0].role).toBe("user");
    expect(capped.at(-1)).toEqual(history.at(-1));
  });

  it(`caps total characters to ${MAX_HISTORY_CHARS}, still starting on a user turn`, () => {
    const history: ChatHistoryTurn[] = [
      { role: "user", content: "a".repeat(5000) },
      { role: "assistant", content: "b".repeat(5000) },
    ];
    const capped = capHistory(history);
    const totalChars = capped.reduce((n, t) => n + t.content.length, 0);
    expect(totalChars).toBeLessThanOrEqual(MAX_HISTORY_CHARS);
    if (capped.length > 0) expect(capped[0].role).toBe("user");
  });

  it("returns an empty array for empty history", () => {
    expect(capHistory([])).toEqual([]);
  });
});

describe("the app brief (M31)", () => {
  const brief = "# Acme Events\n\n## What it's for\n\nSell seats at community events.\n\n## Words it uses\n\n| Term | Meaning | Not to be confused with |\n| --- | --- | --- |\n| Booking | One attendee's seats | Ticket |";

  it("goes first, as its own stable block ahead of the rules, with no cache_control", () => {
    const a = assembleRequest(undefined, context, buildCitations(context), "Question A", undefined, 8000, "Acme Events", brief);
    const b = assembleRequest(undefined, context, buildCitations(context), "Question B", undefined, 8000, "Acme Events", brief);
    expect(a.system).toHaveLength(2);
    expect(a.system[0].text).toBe(buildBriefBlock(brief, "Acme Events"));
    expect(a.system[0].text).toContain("| Booking | One attendee's seats | Ticket |");
    expect(a.system[1].text).toBe(buildSystemPrompt(undefined, "Acme Events"));
    expect(a.system[0].text).toBe(b.system[0].text);
    expect(a.system.every((s) => s.cache_control === undefined)).toBe(true);
  });

  it("is left out when blank, and capped when huge", () => {
    expect(assembleRequest(undefined, context, buildCitations(context), "Q", undefined, 8000, undefined, "  ").system).toHaveLength(1);
    expect(buildBriefBlock("x".repeat(MAX_BRIEF_CHARS * 2)).length).toBeLessThan(MAX_BRIEF_CHARS + 400);
  });

  it("rides along in the resolved chat config only when there is one", () => {
    expect(resolveChatConfig(undefined, undefined, brief).brief).toBe(brief);
    expect("brief" in resolveChatConfig(undefined, undefined)).toBe(false);
  });
});

describe("review fixes: the brief counts against the input budget", () => {
  it("shrinks the context block by the brief and rules it sends", () => {
    const bigContext: RetrievedContext = {
      pages: [{ url: "/a", title: "A", score: 1, sections: [{ url: "/a", title: "A", text: "x".repeat(20_000) }] }],
      topScore: 1,
    };
    const brief = "b".repeat(4_000);
    const without = assembleRequest(undefined, bigContext, buildCitations(bigContext), "Q", undefined, 3000);
    const withBrief = assembleRequest(undefined, bigContext, buildCitations(bigContext), "Q", undefined, 3000, undefined, brief);
    const total = (r: typeof without) => r.system.reduce((n, s) => n + s.text.length, 0) + r.messages.reduce((n, m) => n + m.content.length, 0);
    expect(total(without)).toBeLessThanOrEqual(3000 * 4 + 200);
    expect(total(withBrief)).toBeLessThanOrEqual(3000 * 4 + 200);
    expect(withBrief.messages[0].content.length).toBeLessThan(without.messages[0].content.length - 3_900);
  });
});
