import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConsoleUnansweredStore,
  FileUnansweredStore,
  UNANSWERED_LOG_PREFIX,
  UNANSWERED_QUESTION_MAX_CHARS,
  normalisePath,
  parseUnansweredLogText,
  redactPii,
} from "../../src/chat/unanswered.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe("redactPii", () => {
  it("redacts a real-looking email but leaves example.com addresses alone", () => {
    const text = "contact me at jordan.smith@gmail.com or test@example.com";
    const out = redactPii(text);
    expect(out).not.toContain("jordan.smith@gmail.com");
    expect(out).toContain("[redacted-email]");
    expect(out).toContain("test@example.com");
  });

  it("redacts a real-looking phone number but leaves the reserved fictional range alone", () => {
    const text = "call me on 555-0123 or the demo line 555-0199";
    const out = redactPii(text);
    // 555-01xx is the NANP fictional range — both of these are safe and should survive.
    expect(out).toContain("555-0123");
    expect(out).toContain("555-0199");
  });

  it("redacts a long digit run that scanPhones deliberately skips as 'looks like an id/hash' (13+ unformatted digits — qa/pii.ts's looksLikeIdOrHash)", () => {
    const out = redactPii("my account number is 1234567890123, can you help?");
    expect(out).not.toContain("1234567890123");
    expect(out).toContain("[redacted-number]");
  });

  it("truncates a question longer than UNANSWERED_QUESTION_MAX_CHARS (review finding unanswered.ts:39: 'question unbounded')", () => {
    const out = redactPii("a".repeat(UNANSWERED_QUESTION_MAX_CHARS + 100));
    expect(out.length).toBeLessThanOrEqual(UNANSWERED_QUESTION_MAX_CHARS + 1); // +1 for the truncation ellipsis
  });
});

describe("normalisePath", () => {
  it("replaces a numeric id segment with :id (review finding unanswered.ts:39: 'path stored unredacted (ids like /users/123)')", () => {
    expect(normalisePath("/users/123")).toBe("/users/:id");
  });

  it("replaces a UUID segment with :id", () => {
    expect(normalisePath("/orders/550e8400-e29b-41d4-a716-446655440000")).toBe("/orders/:id");
  });

  it("replaces a long hex id segment with :id", () => {
    expect(normalisePath("/documents/5f8d0d55b54764421b7156c3")).toBe("/documents/:id");
  });

  it("drops a query string and fragment", () => {
    expect(normalisePath("/search?q=secret+term#results")).toBe("/search");
  });

  it("leaves an ordinary route untouched", () => {
    expect(normalisePath("/add-competitor")).toBe("/add-competitor");
  });

  it("passes through undefined", () => {
    expect(normalisePath(undefined)).toBeUndefined();
  });
});

describe("ConsoleUnansweredStore", () => {
  it("logs a line starting with UNANSWERED_LOG_PREFIX followed by valid JSON, with the path normalised and the question redacted", () => {
    const lines: string[] = [];
    const spy = { log: (line: string) => lines.push(line) };
    const originalLog = console.log;
    console.log = spy.log;
    try {
      new ConsoleUnansweredStore().record({
        question: "how do I reach jordan.smith@gmail.com?",
        path: "/users/123",
        at: "2026-10-22T00:00:00.000Z",
      });
    } finally {
      console.log = originalLog;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith(UNANSWERED_LOG_PREFIX)).toBe(true);
    const parsed = JSON.parse(lines[0].slice(UNANSWERED_LOG_PREFIX.length));
    expect(parsed.path).toBe("/users/:id");
    expect(parsed.question).toContain("[redacted-email]");
  });
});

describe("parseUnansweredLogText (aida suggest --from)", () => {
  it("extracts entries from tagged lines mixed in with other host log output", () => {
    const text = [
      "2026-10-22T00:00:00Z [info] server started",
      `2026-10-22T00:00:01Z [info] ${UNANSWERED_LOG_PREFIX}${JSON.stringify({ question: "how do I add a competitor?", at: "2026-10-22T00:00:01Z" })}`,
      "2026-10-22T00:00:02Z [info] some unrelated line",
    ].join("\n");
    const { entries, skipped } = parseUnansweredLogText(text);
    expect(entries).toHaveLength(1);
    expect(entries[0].question).toBe("how do I add a competitor?");
    expect(skipped).toBe(0);
  });

  it("skips (and counts) a tagged line whose JSON is corrupt, instead of throwing (review finding commands/suggest.ts:12: 'one corrupt line throws')", () => {
    const text = [
      `${UNANSWERED_LOG_PREFIX}{"question": "valid one", "at": "2026-10-22T00:00:00.000Z"}`,
      `${UNANSWERED_LOG_PREFIX}{not valid json`,
      `${UNANSWERED_LOG_PREFIX}{"question": "valid two", "at": "2026-10-22T00:00:01.000Z"}`,
    ].join("\n");
    const { entries, skipped } = parseUnansweredLogText(text);
    expect(entries).toHaveLength(2);
    expect(skipped).toBe(1);
  });

  it("ignores lines with no prefix at all", () => {
    const { entries, skipped } = parseUnansweredLogText("just some ordinary log output\nnothing to see here");
    expect(entries).toHaveLength(0);
    expect(skipped).toBe(0);
  });
});

describe("FileUnansweredStore", () => {
  it("appends redacted JSONL entries and reads them back", () => {
    const dir = mkdtempSync(join(tmpdir(), "aida-unanswered-"));
    dirs.push(dir);
    const store = new FileUnansweredStore(dir);

    store.record({ question: "how do I reach jordan.smith@gmail.com?", path: "/help", at: "2026-10-22T00:00:00.000Z" });
    store.record({ question: "how do I add a competitor?", at: "2026-10-22T00:01:00.000Z" });

    const all = store.readAll();
    expect(all).toHaveLength(2);
    expect(all[0].question).not.toContain("jordan.smith@gmail.com");
    expect(all[0].question).toContain("[redacted-email]");

    const raw = readFileSync(join(dir, "unanswered.jsonl"), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(2);
  });

  it("normalises the path before writing", () => {
    const dir = mkdtempSync(join(tmpdir(), "aida-unanswered-"));
    dirs.push(dir);
    const store = new FileUnansweredStore(dir);
    store.record({ question: "where is my order?", path: "/orders/123", at: "2026-10-22T00:00:00.000Z" });
    expect(store.readAll()[0].path).toBe("/orders/:id");
  });

  it("skips a corrupt JSONL line instead of throwing, and counts it (review finding commands/suggest.ts:12: 'one corrupt line throws')", () => {
    const dir = mkdtempSync(join(tmpdir(), "aida-unanswered-"));
    dirs.push(dir);
    const store = new FileUnansweredStore(dir);
    store.record({ question: "first", at: "2026-10-22T00:00:00.000Z" });
    appendFileSync(join(dir, "unanswered.jsonl"), "{not valid json\n");
    store.record({ question: "second", at: "2026-10-22T00:00:01.000Z" });

    expect(() => store.readAll()).not.toThrow();
    const { entries, skipped } = store.readAllWithSkipped();
    expect(entries.map((e) => e.question)).toEqual(["first", "second"]);
    expect(skipped).toBe(1);
  });
});
