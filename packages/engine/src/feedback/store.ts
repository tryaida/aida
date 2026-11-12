// Where feedback entries go: the same two stores as the chat's unanswered questions
// (chat/unanswered.ts). A JSONL file in the help app's private `.aida/` folder where the
// filesystem persists, and a tagged console line on hosts where it doesn't, which
// `aida suggest --from <log>` reads back out of the host's logs.
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { UNANSWERED_LOG_PREFIX } from "../chat/unanswered.js";
import { sanitizeFeedbackEntry, type FeedbackEntry } from "./entry.js";

export interface FeedbackStore {
  record(entry: FeedbackEntry): Promise<void> | void;
}

/** Entries that parsed, and how many lines looked like entries but didn't (never thrown on: one
 * bad line must not hide every other entry). `truncated`: the source was bigger than the read
 * cap, so only its newest part was read. */
export interface ParsedFeedbackLog {
  entries: FeedbackEntry[];
  skipped: number;
  truncated?: boolean;
}

export const FEEDBACK_FILE = "feedback.jsonl";

/** Every console line the console store writes starts with this, then one JSON object. Distinct
 * from `aida-unanswered ` so the two never parse as each other. */
export const FEEDBACK_LOG_PREFIX = "aida-feedback ";

/** The file store stops appending once `feedback.jsonl` reaches this: the route is public and
 * unauthenticated, so the rate limits slow a flood down but only a cap bounds the disk. 5 MB is
 * some 30,000 entries, far more than `aida suggest` needs between two reads. */
export const FEEDBACK_FILE_MAX_BYTES = 5 * 1024 * 1024;

/** Most of a file or host log `aida suggest` reads, newest part kept. Host logs carry every other
 * line the app printed too, so this is well over the file cap. */
export const FEEDBACK_READ_MAX_BYTES = 16 * 1024 * 1024;

function parseLine(json: string, out: ParsedFeedbackLog): void {
  try {
    const entry = sanitizeFeedbackEntry(JSON.parse(json));
    if (entry) out.entries.push(entry);
    else out.skipped += 1;
  } catch {
    out.skipped += 1;
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Reads at most `maxBytes` of a file path or an open descriptor (`0` for stdin), keeping the
 * newest end and dropping the partial first line a cut leaves. Synchronous, because `aida suggest`
 * is; a descriptor is read in chunks so a huge piped log never sits in memory whole.
 */
export function readTextTail(source: string | number, maxBytes: number = FEEDBACK_READ_MAX_BYTES): { text: string; truncated: boolean } {
  const fd = typeof source === "number" ? source : openSync(source, "r");
  try {
    const stat = fstatSync(fd);
    const size = stat.isFile() ? stat.size : -1;
    if (size >= 0) {
      const start = Math.max(0, size - maxBytes);
      const buf = Buffer.alloc(size - start);
      let read = 0;
      while (read < buf.length) {
        const n = readSync(fd, buf, read, buf.length - read, start + read);
        if (n === 0) break;
        read += n;
      }
      return cutToLine(buf.subarray(0, read), start > 0);
    }
    // A pipe: read through, keeping the last `maxBytes` (twice that at most in memory).
    const chunk = Buffer.alloc(64 * 1024);
    let kept: Buffer[] = [];
    let keptBytes = 0;
    let truncated = false;
    for (;;) {
      let n: number;
      try {
        n = readSync(fd, chunk, 0, chunk.length, null);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EAGAIN") {
          sleep(5);
          continue;
        }
        if ((err as NodeJS.ErrnoException).code === "EOF") break;
        throw err;
      }
      if (n === 0) break;
      kept.push(Buffer.from(chunk.subarray(0, n)));
      keptBytes += n;
      if (keptBytes > maxBytes * 2) {
        const all = Buffer.concat(kept);
        kept = [all.subarray(all.length - maxBytes)];
        keptBytes = maxBytes;
        truncated = true;
      }
    }
    const all = Buffer.concat(kept);
    const tail = all.length > maxBytes ? all.subarray(all.length - maxBytes) : all;
    return cutToLine(tail, truncated || all.length > maxBytes);
  } finally {
    if (typeof source === "string") closeSync(fd);
  }
}

function cutToLine(buf: Buffer, cut: boolean): { text: string; truncated: boolean } {
  if (!cut) return { text: buf.toString("utf8"), truncated: false };
  const newline = buf.indexOf(0x0a);
  return { text: newline === -1 ? "" : buf.subarray(newline + 1).toString("utf8"), truncated: true };
}

/** Paths whose "store full" line was already printed, so a flood logs it once, not per post. */
const warnedFull = new Set<string>();

/** Dev and `next start` store: appends to `<dir>/feedback.jsonl`, `dir` defaulting to the help
 * app's own `.aida/` (beside unanswered.jsonl; never the repo the help app documents). */
export class FileFeedbackStore implements FeedbackStore {
  constructor(
    private readonly dir: string = join(process.cwd(), ".aida"),
    private readonly maxBytes: number = FEEDBACK_FILE_MAX_BYTES,
  ) {}

  get file(): string {
    return join(this.dir, FEEDBACK_FILE);
  }

  /** Appends one entry, unless the file has reached its cap: then nothing is written and one
   * line says so (the reader still gets a thank-you; they can't fix a full disk). */
  record(entry: FeedbackEntry): void {
    const clean = sanitizeFeedbackEntry(entry);
    if (!clean) return;
    if (existsSync(this.file) && statSync(this.file).size >= this.maxBytes) {
      if (!warnedFull.has(this.file)) {
        warnedFull.add(this.file);
        console.warn(
          `aida: ${this.file} has reached ${Math.round(this.maxBytes / 1024 / 1024)} MB, so new reader feedback is not being saved. Run \`aida suggest\`, then move or empty the file.`,
        );
      }
      return;
    }
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(clean)}\n`, "utf8");
  }

  readAllWithSkipped(maxBytes: number = FEEDBACK_READ_MAX_BYTES): ParsedFeedbackLog {
    const out: ParsedFeedbackLog = { entries: [], skipped: 0 };
    if (!existsSync(this.file)) return out;
    const { text, truncated } = readTextTail(this.file, maxBytes);
    for (const line of text.split("\n")) {
      if (line.trim()) parseLine(line.trim(), out);
    }
    if (truncated) out.truncated = true;
    return out;
  }
}

/** Serverless hosts: one tagged line on stdout per entry, already redacted. */
export class ConsoleFeedbackStore implements FeedbackStore {
  record(entry: FeedbackEntry): void {
    const clean = sanitizeFeedbackEntry(entry);
    if (!clean) return;
    // eslint-disable-next-line no-console
    console.log(`${FEEDBACK_LOG_PREFIX}${JSON.stringify(clean)}`);
  }
}

/** Same rule as the unanswered-questions store: console in production, the file otherwise. */
export function defaultFeedbackStore(): FeedbackStore {
  return process.env.NODE_ENV === "production" ? new ConsoleFeedbackStore() : new FileFeedbackStore();
}

/** Where a log line's own tag starts: the first of the two prefixes on the line wins, so a
 * feedback query that contains `aida-unanswered ` (or a chat question that contains
 * `aida-feedback `) is read as the entry it is and never counts against the other parser. */
function ownPrefixAt(line: string, prefix: string, other: string): number {
  const idx = line.indexOf(prefix);
  if (idx === -1) return -1;
  const otherIdx = line.indexOf(other);
  return otherIdx !== -1 && otherIdx < idx ? -1 : idx;
}

/**
 * Pulls `FEEDBACK_LOG_PREFIX` lines out of host log text. Hosts prepend timestamps and request
 * ids, so the prefix may sit anywhere in the line; lines without it, or whose first tag is the
 * chat's, are ordinary output and are ignored, not counted as skipped.
 */
export function parseFeedbackLogText(text: string): ParsedFeedbackLog {
  const out: ParsedFeedbackLog = { entries: [], skipped: 0 };
  for (const line of text.split("\n")) {
    const idx = ownPrefixAt(line, FEEDBACK_LOG_PREFIX, UNANSWERED_LOG_PREFIX);
    if (idx === -1) continue;
    const json = line.slice(idx + FEEDBACK_LOG_PREFIX.length).trim();
    if (json) parseLine(json, out);
  }
  return out;
}

/** The other half of the first-prefix rule, for the chat's parser (which lives in
 * chat/unanswered.ts): host log text without the lines whose first tag is feedback's. */
export function withoutFeedbackLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const feedback = line.indexOf(FEEDBACK_LOG_PREFIX);
      if (feedback === -1) return true;
      const chat = line.indexOf(UNANSWERED_LOG_PREFIX);
      return chat !== -1 && chat < feedback;
    })
    .join("\n");
}
