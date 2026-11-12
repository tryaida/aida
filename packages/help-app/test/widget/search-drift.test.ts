// The in-app widget (public/widget.js) has no build step, so it carries its own copy of the help
// site's search scoring (components/site/search-dialog.tsx `rank`, `cleanText`, `excerpt`). Both
// copies are read from their source files and fed the same index and queries here, so a reader
// gets the same results in the app as on the site.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Entry {
  url: string;
  title: string;
  heading?: string;
  section?: string;
  text: string;
}
interface Search {
  rank(index: Entry[], query: string): { entry: Entry; score: number }[];
  cleanText(text: string): string;
  excerpt(text: string, query: string): string;
}

function compile(js: string): Search {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- test-only: runs each copy's own source
  return new Function(`${js}\nreturn { rank, cleanText, excerpt };`)() as Search;
}

function siteCopy(): Search {
  const src = readFileSync(join(ROOT, "components", "site", "search-dialog.tsx"), "utf8");
  const start = src.indexOf("function cleanText(");
  const end = src.indexOf("function Row(");
  if (start < 0 || end < start) throw new Error("search-dialog.tsx no longer has cleanText … excerpt before Row");
  const body = src.slice(start, end);
  for (const name of ["rank", "excerpt"]) if (!body.includes(`function ${name}(`)) throw new Error(`search-dialog.tsx lost ${name}`);
  return compile(ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);
}

function widgetCopy(): Search {
  const src = readFileSync(join(ROOT, "public", "widget.js"), "utf8");
  const found = /\/\/ <search-rank>[^\n]*\n([\s\S]*?)\/\/ <\/search-rank>/.exec(src);
  if (!found) throw new Error("widget.js lost its <search-rank> markers");
  return compile(found[1]!);
}

const words = ["poll", "close", "invite", "member", "export", "payment", "report", "team", "settings", "a"];
const INDEX: Entry[] = [
  { url: "/how-do-i/close-poll", title: "Close a poll", text: "Stop a **poll** taking answers. <Callout>Members see it closed.</Callout>" },
  { url: "/how-do-i/close-poll#before-you-start", title: "Close a poll", heading: "Before you start", text: "You need to own the poll. {/* note */}" },
  { url: "/how-do-i/close-poll#reopen", title: "Close a poll", heading: "Reopen a poll", text: "Open it again from the poll's menu." },
  { url: "/how-do-i/close-poll#export", title: "Close a poll", heading: "Export the results", text: "Export a closed poll's answers to CSV." },
  { url: "/how-do-i/invite", title: "Invite a member", section: "Team", text: "Send an invitation to someone at example.com. ![Invite](/shots/invite.png)" },
  { url: "/how-do-i/invite#roles", title: "Invite a member", heading: "Member roles", section: "Team", text: "Choose what a team member can change." },
  { url: "/how-do-i/payments", title: "Record a payment", section: "Payments", text: `${"Payments come in from members. ".repeat(12)}Export a payment report for the team.` },
  { url: "/settings", title: "Team settings", text: "Rename the team, change its settings and export members." },
  ...Array.from({ length: 16 }, (_, i) => ({ url: `/how-do-i/poll-${i}`, title: `Poll task ${i}`, text: `Another poll guide, number ${i}.` })),
];
const QUERIES = [
  "poll",
  "Close Poll",
  "  export  ",
  "member roles",
  "example.com",
  "payment report",
  "settings team",
  "zzz",
  "",
  "A",
  ...words.flatMap((a) => words.map((b) => `${a} ${b}`)),
];

describe("widget.js search matches the help site's", () => {
  const site = siteCopy();
  const widget = widgetCopy();

  it("ranks the same entries in the same order with the same scores", () => {
    for (const q of QUERIES) {
      const want = site.rank(INDEX, q).map((h) => [h.entry.url, h.score]);
      expect(widget.rank(INDEX, q).map((h) => [h.entry.url, h.score]), q).toEqual(want);
    }
    // The cases above reach the per-guide cap and the 12-result cap.
    expect(site.rank(INDEX, "poll").length).toBe(12);
    expect(site.rank(INDEX, "close poll").filter((h) => h.entry.url.startsWith("/how-do-i/close-poll")).length).toBe(3);
  });

  it("cleans and excerpts text the same way", () => {
    for (const entry of INDEX) {
      expect(widget.cleanText(entry.text)).toBe(site.cleanText(entry.text));
      for (const q of QUERIES) expect(widget.excerpt(entry.text, q), `${entry.url} / ${q}`).toBe(site.excerpt(entry.text, q));
    }
  });
});
