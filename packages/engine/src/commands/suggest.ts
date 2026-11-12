import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { UNANSWERED_QUESTION_MAX_CHARS, clusterUnanswered, parseUnansweredLogText } from "../chat/index.js";
import type { UnansweredEntry } from "../chat/index.js";
import {
  FEEDBACK_FILE,
  FEEDBACK_READ_MAX_BYTES,
  FileFeedbackStore,
  READER_TEXT_NOTICE,
  normaliseFeedbackPath,
  parseFeedbackLogText,
  readTextTail,
  redactFeedbackText,
  summariseFeedback,
  withoutFeedbackLines,
} from "../feedback/index.js";
import type { FeedbackSummary, PageCheck, ParsedFeedbackLog } from "../feedback/index.js";

export interface RunSuggestOptions {
  /** Directory holding `unanswered.jsonl` and `feedback.jsonl` — defaults to the file stores'
   * own default (`<cwd>/.aida`). Ignored when `from` is given. */
  dir?: string;
  /** Read host log text instead of the file stores' JSONL (review finding unanswered.ts:39 /
   * commands/suggest.ts:12: prod logs via console, which the file stores never see).
   * A file path, or `"-"` to read stdin. One read serves both: unanswered questions and reader
   * feedback carry different line prefixes in the same log. */
  from?: string;
  /** The help app folder (the one holding `public/search-index.json`), to check that the pages
   * readers voted on are real. Default: beside `dir`, then `<cwd>`, then `<cwd>/help`. */
  siteDir?: string;
  /** Most bytes read from each source, newest kept. Default `FEEDBACK_READ_MAX_BYTES`. */
  maxReadBytes?: number;
}

/** Longest comment printed in the summary (the JSON carries the stored text, already capped). */
const COMMENT_PRINT_CHARS = 140;

function clip(text: string): string {
  return text.length > COMMENT_PRINT_CHARS ? `${text.slice(0, COMMENT_PRINT_CHARS - 1)}…` : text;
}

/**
 * Reader text as printed: always a JSON string literal, so a quote inside it can't close the
 * quoting and pass the rest off as aida's own words, and a line break can't start a line of its
 * own. Anything invisible that got this far (the readers below strip it) is escaped, not printed.
 */
export function quoteReaderText(text: string): string {
  return JSON.stringify(text).replace(
    /[\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}͏ᅟᅠㅤﾠ︀-️]/gu,
    (c) => Array.from({ length: c.length }, (_, i) => `\\u${c.charCodeAt(i).toString(16).padStart(4, "0")}`).join(""),
  );
}

const PAGE_NOTE: Record<PageCheck, string> = {
  known: "",
  "not-on-site": "  [not a page of this help site]",
  unverified: "  [unverified page]",
};

/**
 * A logged chat question made as safe to show as reader feedback is: the same invisible-character
 * stripping, redaction and caps (the chat's own store redacts less, and a pasted host log can
 * carry anything). Undefined for a line that isn't a question.
 */
function readerSafeQuestion(raw: unknown): UnansweredEntry | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const { question, path, at } = raw as Record<string, unknown>;
  if (typeof question !== "string") return undefined;
  const text = redactFeedbackText(question, UNANSWERED_QUESTION_MAX_CHARS);
  if (!text) return undefined;
  const safePath = typeof path === "string" ? normaliseFeedbackPath(path) : undefined;
  return { question: text, ...(safePath ? { path: safePath } : {}), at: typeof at === "string" ? at.slice(0, 32) : "" };
}

interface Questions {
  entries: UnansweredEntry[];
  skipped: number;
}

function safeQuestions(raw: unknown[], skipped: number): Questions {
  const entries: UnansweredEntry[] = [];
  for (const item of raw) {
    const entry = readerSafeQuestion(item);
    if (entry) entries.push(entry);
    else skipped += 1;
  }
  return { entries, skipped };
}

function questionsFromJsonl(text: string): Questions {
  const raw: unknown[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      raw.push(JSON.parse(line));
    } catch {
      skipped += 1;
    }
  }
  return safeQuestions(raw, skipped);
}

/**
 * The help site's pages, from the search index the help app already has on disk. Undefined when
 * none is found, and then every page is reported unverified rather than guessed at.
 */
function loadKnownPages(candidates: string[]): Set<string> | undefined {
  for (const dir of candidates) {
    const file = join(dir, "public", "search-index.json");
    if (!existsSync(file)) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(parsed)) continue;
      const pages = new Set<string>();
      for (const item of parsed) {
        const url = (item as { url?: unknown } | null)?.url;
        if (typeof url !== "string") continue;
        const page = normaliseFeedbackPath(url.split("#")[0] || "/");
        if (page) pages.add(page);
      }
      if (pages.size > 0) return pages;
    } catch {
      // Not readable here; try the next place.
    }
  }
  return undefined;
}

function siteCandidates(opts: RunSuggestOptions): string[] {
  if (opts.siteDir) return [resolve(opts.siteDir)];
  const out: string[] = [];
  if (opts.dir && !opts.from) out.push(dirname(resolve(opts.dir)));
  out.push(process.cwd(), join(process.cwd(), "help"));
  return out;
}

function printFeedback(summary: FeedbackSummary, skipped: number): void {
  if (skipped > 0) console.log(`skipped ${skipped} unparseable feedback line(s)`);
  if (summary.count === 0) {
    console.log("no reader feedback logged yet");
    return;
  }
  const { searches, votes } = summary;
  console.log(`Reader feedback: ${searches.total} search(es) with no results, ${votes.notHelpful} not helpful, ${votes.helpful} helpful`);
  if (searches.top.length > 0) {
    console.log(`\nSearches that found nothing (${searches.distinct} distinct):`);
    for (const s of searches.top) {
      const from = s.screens ? `  from ${s.screens.map(quoteReaderText).join(", ")}` : "";
      console.log(`- ${quoteReaderText(s.query)} x${s.count}${from}`);
    }
    if (searches.more > 0) console.log(`  (${searches.more} more)`);
  }
  if (summary.pages.length > 0) {
    console.log("\nGuides marked not helpful:");
    for (const p of summary.pages) {
      console.log(`- ${quoteReaderText(p.page)}${PAGE_NOTE[p.check]}  ${p.notHelpful} not helpful, ${p.helpful} helpful`);
      for (const c of p.comments ?? []) console.log(`    comment: ${quoteReaderText(clip(c))}`);
    }
    if (summary.morePages > 0) console.log(`  (${summary.morePages} more)`);
  }
}

/** Runs `aida suggest`: clusters logged unanswered chat questions into suggested new
 * walkthroughs (build-plan.md M15 step 5), and summarises reader feedback (M47) beside them,
 * never mixed in. A corrupt line is skipped (counted, never thrown on) — one bad entry must
 * never hide every other one. Everything readers typed is printed as a quoted JSON string under
 * `READER_TEXT_NOTICE`, because a coding agent reads this output. */
export function runSuggest(opts: RunSuggestOptions, json: boolean): number {
  const maxBytes = opts.maxReadBytes ?? FEEDBACK_READ_MAX_BYTES;
  let questions: Questions;
  let feedback: ParsedFeedbackLog;
  let truncated = false;
  if (opts.from) {
    const { text, truncated: cut } = readTextTail(opts.from === "-" ? 0 : opts.from, maxBytes);
    truncated = cut;
    // Lines whose first tag is feedback's are dropped before the chat's parser sees them (the
    // chat's own parser looks for its prefix anywhere on a line).
    const parsed = parseUnansweredLogText(withoutFeedbackLines(text));
    questions = safeQuestions(parsed.entries, parsed.skipped);
    feedback = parseFeedbackLogText(text);
  } else {
    const dir = opts.dir ?? join(process.cwd(), ".aida");
    const file = join(dir, "unanswered.jsonl");
    if (existsSync(file)) {
      const { text, truncated: cut } = readTextTail(file, maxBytes);
      truncated = cut;
      questions = questionsFromJsonl(text);
    } else {
      questions = { entries: [], skipped: 0 };
    }
    feedback = new FileFeedbackStore(dir).readAllWithSkipped(maxBytes);
    if (feedback.truncated) truncated = true;
  }
  const { entries, skipped } = questions;
  const suggestions = clusterUnanswered(entries);
  const knownPages = loadKnownPages(siteCandidates(opts));
  const summary = summariseFeedback(feedback.entries, { knownPages });

  if (json) {
    // Top-level `count`/`skipped`/`suggestions` stay the chat's, as before; reader feedback has
    // its own object so the two signals are never added together. `readerText` is the notice an
    // agent reading the JSON gets in place of the printed line.
    console.log(
      JSON.stringify({
        ok: true,
        readerText: READER_TEXT_NOTICE,
        count: entries.length,
        skipped,
        ...(truncated ? { truncated: true } : {}),
        suggestions,
        feedback: { readerText: READER_TEXT_NOTICE, ...summary, pagesChecked: knownPages !== undefined, skipped: feedback.skipped },
      }),
    );
    return 0;
  }

  if (truncated) console.log(`read only the newest ${Math.round(maxBytes / 1024 / 1024)} MB of ${opts.from ? "the log" : FEEDBACK_FILE}`);
  if (entries.length > 0 || summary.count > 0) console.log(`NOTE: ${READER_TEXT_NOTICE}\n`);

  if (skipped > 0) {
    console.log(`skipped ${skipped} unparseable log line(s)`);
  }

  if (entries.length === 0) {
    console.log("no unanswered chat questions logged yet");
  } else {
    console.log(`${entries.length} unanswered chat question(s), ${suggestions.length} suggested walkthrough(s):`);
    for (const s of suggestions) {
      console.log(`\n- suggested slug ${quoteReaderText(s.slug)} (${s.count} question${s.count === 1 ? "" : "s"})`);
      for (const q of s.questions.slice(0, 3)) console.log(`    question: ${quoteReaderText(q)}`);
    }
  }

  console.log("");
  if (summary.pages.length > 0 && !knownPages) console.log("(no public/search-index.json found, so no page below could be checked against the site)");
  printFeedback(summary, feedback.skipped);
  return 0;
}
