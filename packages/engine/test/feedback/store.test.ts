import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UNANSWERED_LOG_PREFIX, parseUnansweredLogText } from "../../src/chat/unanswered.js";
import {
  ConsoleFeedbackStore,
  FEEDBACK_LOG_PREFIX,
  FileFeedbackStore,
  defaultFeedbackStore,
  parseFeedbackLogText,
  readTextTail,
  withoutFeedbackLines,
} from "../../src/feedback/store.js";
import type { FeedbackEntry } from "../../src/feedback/entry.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-feedback-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// An entry that slipped past validation (a caller that skipped it): the store still redacts.
const RAW = {
  kind: "not-helpful",
  page: "/billing/77777",
  comment: "I am sam@acme-mail.net, 0412 345 678",
  at: "2026-11-11T09:30:00.000Z",
  ip: "203.0.113.9",
} as unknown as FeedbackEntry;

describe("FileFeedbackStore", () => {
  it("appends redacted JSONL under the given folder and reads it back", () => {
    const dir = tempDir();
    const store = new FileFeedbackStore(dir);
    store.record(RAW);
    store.record({ kind: "no-results", query: "export invoices", at: "2026-11-11" });
    const text = readFileSync(join(dir, "feedback.jsonl"), "utf8");
    expect(text).not.toMatch(/sam@acme-mail|0412 345 678|203\.0\.113\.9|77777|T09:30/);
    const { entries, skipped } = store.readAllWithSkipped();
    expect(skipped).toBe(0);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: "not-helpful", page: "/billing/*", at: "2026-11-11" });
  });

  it("returns nothing for a missing file", () => {
    expect(new FileFeedbackStore(join(tempDir(), "nope")).readAllWithSkipped()).toEqual({ entries: [], skipped: 0 });
  });

  it("counts a corrupt or foreign line as skipped and keeps the rest", () => {
    const dir = tempDir();
    const store = new FileFeedbackStore(dir);
    store.record({ kind: "helpful", page: "/a", at: "2026-11-11" });
    appendFileSync(join(dir, "feedback.jsonl"), '{broken\n{"kind":"helpful"}\n');
    store.record({ kind: "helpful", page: "/b", at: "2026-11-11" });
    const { entries, skipped } = store.readAllWithSkipped();
    expect(entries.map((e) => e.page)).toEqual(["/a", "/b"]);
    expect(skipped).toBe(2);
  });

  it("stops appending at its size cap and says so once", () => {
    const dir = tempDir();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new FileFeedbackStore(dir, 400);
    for (let i = 0; i < 50; i++) store.record({ kind: "no-results", query: `query number ${i}`, at: "2026-11-11" });
    const size = statSync(store.file).size;
    expect(size).toBeGreaterThanOrEqual(400);
    expect(size).toBeLessThan(500);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("not being saved");
    expect(String(warn.mock.calls[0][0])).not.toContain(FEEDBACK_LOG_PREFIX);
  });

  it("reads only the newest part of a file over the read cap, without a broken first line", () => {
    const dir = tempDir();
    const lines = Array.from({ length: 200 }, (_, i) => JSON.stringify({ kind: "no-results", query: `query ${i}`, at: "2026-11-11" }));
    writeFileSync(join(dir, "feedback.jsonl"), `${lines.join("\n")}\n`);
    const { entries, skipped, truncated } = new FileFeedbackStore(dir).readAllWithSkipped(2000);
    expect(truncated).toBe(true);
    expect(skipped).toBe(0);
    expect(entries.length).toBeGreaterThan(10);
    expect(entries.length).toBeLessThan(60);
    expect(entries[entries.length - 1].query).toBe("query 199");
  });

  it("re-redacts a hand-edited line on the way out", () => {
    const dir = tempDir();
    appendFileSync(join(dir, "feedback.jsonl"), `${JSON.stringify({ kind: "no-results", query: "sam@acme-mail.net", at: "2026-11-11", userId: "u1" })}\n`);
    const [entry] = new FileFeedbackStore(dir).readAllWithSkipped().entries;
    expect(entry.query).toBe("[redacted-email]");
    expect(entry).not.toHaveProperty("userId");
  });
});

describe("ConsoleFeedbackStore and log import", () => {
  it("logs one tagged, redacted line that parseFeedbackLogText reads back from host log text", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
    new ConsoleFeedbackStore().record(RAW);
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith(FEEDBACK_LOG_PREFIX)).toBe(true);
    expect(lines[0]).not.toMatch(/sam@acme-mail|0412 345 678|203\.0\.113\.9/);

    const hostLog = [
      "2026-11-11T09:30:00Z INFO server started",
      `2026-11-11T09:30:01Z [req abc] ${lines[0]}`,
      `2026-11-11T09:30:02Z ${FEEDBACK_LOG_PREFIX}{not json`,
      `aida-unanswered ${JSON.stringify({ question: "chat only", at: "2026-11-11" })}`,
    ].join("\n");
    const { entries, skipped } = parseFeedbackLogText(hostLog);
    expect(entries).toEqual([{ kind: "not-helpful", page: "/billing/*", comment: expect.any(String), at: "2026-11-11" }]);
    expect(skipped).toBe(1);
  });

  it("reads a line by the prefix that comes first on it, so neither parser counts the other's lines", () => {
    const feedbackLine = `t1 ${FEEDBACK_LOG_PREFIX}${JSON.stringify({ kind: "no-results", query: `x ${UNANSWERED_LOG_PREFIX}y`, at: "2026-11-11" })}`;
    const chatLine = `t2 ${UNANSWERED_LOG_PREFIX}${JSON.stringify({ question: `why ${FEEDBACK_LOG_PREFIX}z`, at: "2026-11-11" })}`;
    const log = [feedbackLine, chatLine].join("\n");
    const feedback = parseFeedbackLogText(log);
    expect(feedback.skipped).toBe(0);
    expect(feedback.entries).toHaveLength(1);
    const chat = parseUnansweredLogText(withoutFeedbackLines(log));
    expect(chat.skipped).toBe(0);
    expect(chat.entries).toHaveLength(1);
  });

  it("defaults to the console store in production and the file store otherwise", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(defaultFeedbackStore()).toBeInstanceOf(ConsoleFeedbackStore);
    vi.stubEnv("NODE_ENV", "development");
    expect(defaultFeedbackStore()).toBeInstanceOf(FileFeedbackStore);
  });
});

describe("readTextTail", () => {
  it("reads a small file whole and a large one from the end", () => {
    const dir = tempDir();
    const file = join(dir, "log.txt");
    writeFileSync(file, "one\ntwo\nthree\n");
    expect(readTextTail(file, 1000)).toEqual({ text: "one\ntwo\nthree\n", truncated: false });
    expect(readTextTail(file, 8)).toEqual({ text: "three\n", truncated: true });
  });
});
