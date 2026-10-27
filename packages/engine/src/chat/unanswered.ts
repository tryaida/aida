// Unanswered-question logging (docs/scope.md "Help chat": "Questions it can't answer become
// suggested new walkthroughs"; build-plan.md M15 step 5). Runs the qa/pii scan over the question
// text before it's stored anywhere — a question can itself contain a reader's own name/email/
// phone number, and this is the one place in aida that writes end-user-typed text to disk.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EMAIL_PATTERN, PHONE_CANDIDATE, scanEmails, scanPhones } from "../qa/pii.js";

export interface UnansweredEntry {
  question: string;
  path?: string;
  at: string;
}

export interface UnansweredStore {
  record(entry: UnansweredEntry): Promise<void> | void;
}

/** Catches long digit runs `redactPii` would otherwise miss — account/order numbers, card
 * digits, IDs typed into a question — that aren't shaped like a phone number (those have
 * separators and are already handled by `PHONE_CANDIDATE`/`scanPhones`). 6+ digits is long
 * enough to skip common short numbers (years, step counts) while still catching most real IDs. */
const LONG_DIGIT_RUN = /\d{6,}/g;

/** Hard cap on a question's stored length (review finding unanswered.ts:39: "question
 * unbounded") — `aida suggest` only needs enough of the question to triage it, not an
 * unbounded blob a malicious/buggy client could pad the log with. */
export const UNANSWERED_QUESTION_MAX_CHARS = 500;

/**
 * Redacts emails, phone numbers, and long digit runs that the qa/pii scan (or the digit-run
 * check above) would flag — real docs content never reaches this path, but an end user's
 * question is free text, and may name their own contact details. Safe/fictional matches (e.g.
 * example.com, the NANP fictional phone range) are left as-is, same as the rest of aida's PII
 * scanning. Also truncates to `UNANSWERED_QUESTION_MAX_CHARS`.
 */
export function redactPii(text: string): string {
  let out = text.replace(EMAIL_PATTERN, (full) => (scanEmails(full).length > 0 ? "[redacted-email]" : full));
  out = out.replace(PHONE_CANDIDATE, (full) => (scanPhones(full).length > 0 ? "[redacted-phone]" : full));
  out = out.replace(LONG_DIGIT_RUN, "[redacted-number]");
  if (out.length > UNANSWERED_QUESTION_MAX_CHARS) {
    out = `${out.slice(0, UNANSWERED_QUESTION_MAX_CHARS)}…`;
  }
  return out;
}

/** Segment shapes that identify a specific record (and so are themselves potentially
 * identifying/PII) rather than naming a route: all-digits ("123"), a UUID, or a long hex id
 * (e.g. a Mongo ObjectId or hash, 8+ hex chars with at least one digit so plain words like
 * "feed" or "deed" aren't caught). */
const NUMERIC_SEGMENT = /^\d+$/;
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_ID_SEGMENT = /^(?=.*\d)[0-9a-f]{8,}$/i;

/**
 * Normalises a logged path so an unanswered-question entry never carries a specific record id
 * (review finding unanswered.ts:39: "path stored unredacted (ids like /users/123)") — replaces
 * every numeric/UUID/hex segment with `:id` and drops the query string and fragment (which can
 * carry tokens, search text, or other identifying data of their own).
 */
export function normalisePath(path: string | undefined): string | undefined {
  if (!path) return path;
  const withoutQueryOrHash = path.split(/[?#]/, 1)[0];
  return withoutQueryOrHash
    .split("/")
    .map((segment) => {
      if (!segment) return segment;
      if (NUMERIC_SEGMENT.test(segment) || UUID_SEGMENT.test(segment) || HEX_ID_SEGMENT.test(segment)) return ":id";
      return segment;
    })
    .join("/");
}

/** Shared sanitization both stores apply before anything hits a log/disk: redact + truncate the
 * question, normalise the path. Centralised so `aida suggest`'s parser (unanswered.ts:68 /
 * commands/suggest.ts:12) sees the same shape regardless of which store produced it. */
function sanitize(entry: UnansweredEntry): UnansweredEntry {
  return { question: redactPii(entry.question), path: normalisePath(entry.path), at: entry.at };
}

/** Result of parsing a JSONL/log source into entries: `entries` that parsed, plus a `skipped`
 * count for lines that looked like an entry but didn't parse (review finding unanswered.ts:68 /
 * commands/suggest.ts:12: "one corrupt line throws" — a single bad line must never abort the
 * whole read, but silently losing entries with no signal isn't right either). */
export interface ParsedUnansweredLog {
  entries: UnansweredEntry[];
  skipped: number;
}

function parseJsonLines(lines: string[]): ParsedUnansweredLog {
  const entries: UnansweredEntry[] = [];
  let skipped = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as UnansweredEntry);
    } catch {
      skipped += 1;
    }
  }
  return { entries, skipped };
}

/** Default dev store: appends JSONL under `.aida/unanswered.jsonl` (relative to `cwd`, the
 * help app's own directory — never the repo the help app documents). */
export class FileUnansweredStore implements UnansweredStore {
  constructor(private readonly dir: string = join(process.cwd(), ".aida")) {}

  record(entry: UnansweredEntry): void {
    const file = join(this.dir, "unanswered.jsonl");
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(sanitize(entry))}\n`, "utf8");
  }

  /** Reads every logged entry — used by `aida suggest`. A corrupt line is skipped, not
   * thrown on, so one bad append (e.g. a crash mid-write) doesn't take down every entry after it. */
  readAll(): UnansweredEntry[] {
    return this.readAllWithSkipped().entries;
  }

  /** Same as `readAll`, but also reports how many lines were skipped for being unparseable. */
  readAllWithSkipped(): ParsedUnansweredLog {
    const file = join(this.dir, "unanswered.jsonl");
    if (!existsSync(file)) return { entries: [], skipped: 0 };
    return parseJsonLines(readFileSync(file, "utf8").split("\n"));
  }
}

/** Every console line this writes starts with this exact prefix, immediately followed by one
 * JSON object — `aida suggest --from <logfile|->` greps for it (review finding
 * unanswered.ts:39 / commands/suggest.ts:12: "prod uses console store" but nothing could read
 * console/host logs back). Kept distinct from `[aida:chat]`'s usage-log line format so the two
 * never get parsed as each other. */
export const UNANSWERED_LOG_PREFIX = "aida-unanswered ";

/**
 * Parses host log text (e.g. `aida suggest --from app.log`, or piped via stdin as `-`) for
 * `UNANSWERED_LOG_PREFIX`-tagged lines. A real host log line is rarely *just* the console
 * output — platforms commonly prepend a timestamp/level/request-id — so this looks for the
 * prefix anywhere in the line rather than requiring it to start the line, and parses only what
 * follows it. Lines with no prefix are ordinary log output and are silently ignored (not
 * "skipped" — nothing here was malformed); a line that does carry the prefix but fails to parse
 * counts against `skipped`.
 */
export function parseUnansweredLogText(text: string): ParsedUnansweredLog {
  const entries: UnansweredEntry[] = [];
  let skipped = 0;
  for (const rawLine of text.split("\n")) {
    const idx = rawLine.indexOf(UNANSWERED_LOG_PREFIX);
    if (idx === -1) continue;
    const jsonPart = rawLine.slice(idx + UNANSWERED_LOG_PREFIX.length).trim();
    if (!jsonPart) continue;
    try {
      entries.push(JSON.parse(jsonPart) as UnansweredEntry);
    } catch {
      skipped += 1;
    }
  }
  return { entries, skipped };
}

/** Production default: logs to the server console (no filesystem writes expected on most
 * hosts) instead of a file — still redacted first, and tagged with `UNANSWERED_LOG_PREFIX` so
 * `aida suggest --from <logfile|->` can pull entries back out of whatever the host does with
 * stdout/stderr. */
export class ConsoleUnansweredStore implements UnansweredStore {
  record(entry: UnansweredEntry): void {
    // eslint-disable-next-line no-console
    console.log(`${UNANSWERED_LOG_PREFIX}${JSON.stringify(sanitize(entry))}`);
  }
}

/** `NODE_ENV === "production"` -> console store; otherwise the file store (build-plan.md M15
 * step 5: "default file JSONL under .aida/unanswered.jsonl in dev / console in prod"). */
export function defaultUnansweredStore(): UnansweredStore {
  return process.env.NODE_ENV === "production" ? new ConsoleUnansweredStore() : new FileUnansweredStore();
}
