import { readFileSync } from "node:fs";
import { FileUnansweredStore, clusterUnanswered, parseUnansweredLogText } from "../chat/index.js";
import type { ParsedUnansweredLog } from "../chat/index.js";

export interface RunSuggestOptions {
  /** Directory holding `.aida/unanswered.jsonl` — defaults to the file store's own default
   * (`<cwd>/.aida`). Ignored when `from` is given. */
  dir?: string;
  /** Read host log text instead of the file store's JSONL (review finding unanswered.ts:39 /
   * commands/suggest.ts:12: prod logs via console, which `FileUnansweredStore` never sees).
   * A file path, or `"-"` to read stdin — either way parsed with `parseUnansweredLogText`
   * (looks for `UNANSWERED_LOG_PREFIX`-tagged lines anywhere in the text). */
  from?: string;
}

function readFrom(source: string): string {
  if (source === "-") return readFileSync(0, "utf8");
  return readFileSync(source, "utf8");
}

/** Runs `aida suggest`: clusters logged unanswered questions into suggested new walkthroughs
 * (build-plan.md M15 step 5). A corrupt line is skipped (counted, never thrown on) — one bad
 * entry must never hide every other logged question. */
export function runSuggest(opts: RunSuggestOptions, json: boolean): number {
  let parsed: ParsedUnansweredLog;
  if (opts.from) {
    parsed = parseUnansweredLogText(readFrom(opts.from));
  } else {
    const store = new FileUnansweredStore(opts.dir);
    parsed = store.readAllWithSkipped();
  }
  const { entries, skipped } = parsed;
  const suggestions = clusterUnanswered(entries);

  if (json) {
    console.log(JSON.stringify({ ok: true, count: entries.length, skipped, suggestions }));
    return 0;
  }

  if (skipped > 0) {
    console.log(`skipped ${skipped} unparseable log line(s)`);
  }

  if (entries.length === 0) {
    console.log("no unanswered questions logged yet");
    return 0;
  }

  console.log(`${entries.length} unanswered question(s), ${suggestions.length} suggested walkthrough(s):`);
  for (const s of suggestions) {
    console.log(`\n- ${s.slug} (${s.count} question${s.count === 1 ? "" : "s"})`);
    for (const q of s.questions.slice(0, 3)) console.log(`    "${q}"`);
  }
  return 0;
}
