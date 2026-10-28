// `app-brief.md` and `aida brief` (M31): the format, check, show, init and sources, and what the
// brief hands the help chat, the agent connector and the home page.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRIEF_PROMPTS,
  BRIEF_SECTIONS,
  briefArtifacts,
  briefForBuild,
  briefForChat,
  briefIntro,
  briefOverview,
  briefPath,
  briefTemplate,
  checkBrief,
  findBriefSources,
  findSection,
  formatBriefSources,
  parseBrief,
  scoreDoc,
  sectionText,
} from "../../src/brief/index.js";
import { runIndexStage } from "../../src/build/index-stage.js";
import { readFrontmatter } from "../../src/pages/index.js";
import { resolveChatConfig } from "../../src/chat/handler.js";
import { runBriefCheck, runBriefInit, runBriefShow, runBriefSources } from "../../src/commands/brief.js";
import { buildDomain } from "../../src/domain/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "..", "fixtures");
const briefFile = path.join(fixtures, "brief", "app-brief.md");
const briefText = readFileSync(briefFile, "utf8");
const acmeApp = path.join(fixtures, "brief", "acme-app");

let dir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let writeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "aida-brief-"));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  logSpy.mockRestore();
  errorSpy.mockRestore();
  writeSpy.mockRestore();
});

const lastJson = () => JSON.parse(logSpy.mock.calls[logSpy.mock.calls.length - 1][0] as string);

describe("parseBrief", () => {
  it("reads the frontmatter and the H2 sections, prompts kept out of sectionText", () => {
    const brief = parseBrief(briefText);
    expect(brief.frontmatter?.app).toBe("Acme Events");
    expect(brief.sections.map((s) => s.name)).toEqual([...BRIEF_SECTIONS]);
    expect(brief.preamble).toContain("# Acme Events brief");
    expect(sectionText(findSection(brief, "Rhythm"))).toMatch(/^Bookings open weeks ahead/);
  });

  it("finds a section by exact name, its start or a word in it, ignoring case and curly apostrophes", () => {
    const brief = parseBrief(briefText);
    expect(findSection(brief, "words")?.name).toBe("Words it uses");
    expect(findSection(brief, "WHAT IT’S FOR")?.name).toBe("What it's for");
    expect(findSection(brief, "several ways")?.name).toBe("Several ways to do one thing");
    expect(findSection(brief, "pricing")).toBeUndefined();
  });

  it("ignores a ## inside a code fence", () => {
    const brief = parseBrief("## A\n\n```\n## not a heading\n```\n\n## B\n");
    expect(brief.sections.map((s) => s.name)).toEqual(["A", "B"]);
  });
});

describe("checkBrief", () => {
  it("passes a complete brief", () => {
    const result = checkBrief(briefText);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.sections.every((s) => s.present && s.filled)).toBe(true);
  });

  it("flags missing frontmatter fields, missing and empty sections, and a glossary with no table", () => {
    const text = [
      "---",
      "app: Acme Events",
      "updated: soon",
      "readers:",
      "  - role: organiser",
      "    name: Event organisers",
      "---",
      "",
      "## What it's for",
      "",
      "<!-- prompt only -->",
      "",
      "## Words it uses",
      "",
      "Booking means a booking.",
    ].join("\n");
    const result = checkBrief(text);
    expect(result.ok).toBe(false);
    const messages = result.errors.map((e) => e.message);
    expect(messages).toContain("frontmatter `updated` must be a date, YYYY-MM-DD");
    expect(messages).toContain("readers[0] is missing job");
    expect(messages).toContain('"What it\'s for" is empty');
    expect(messages).toContain('missing section "## Rhythm"');
    expect(messages).toContain("needs a table: | Term | Meaning | Not to be confused with |");
  });

  it("errors on no frontmatter and on an unfilled template, glossary rows included", () => {
    expect(checkBrief("## What it's for\n\nText.\n").errors[0].message).toBe("no YAML frontmatter (app, updated, readers)");
    const template = checkBrief(briefTemplate({ app: "Acme Events", updated: "2026-10-27" }));
    expect(template.ok).toBe(false);
    expect(template.errors.map((e) => e.message)).toContain("the glossary table has no rows");
    expect(template.errors.map((e) => e.message)).toContain("readers[0] is missing role, name, job");
  });

  it("warns on real-looking emails and phone numbers but not example.com or fictional ranges", () => {
    const text = briefText.replace("## Rhythm\n", "## Rhythm\n\nAsk jo@realmail.test or call 0412 345 678. Demo: sam@example.com, 0491 570 156.\n");
    const result = checkBrief(text);
    expect(result.ok).toBe(true);
    const warnings = result.warnings.map((w) => w.message).join("\n");
    expect(warnings).toContain("jo@realmail.test");
    expect(warnings).toContain("0412 345 678");
    expect(warnings).not.toContain("sam@example.com");
    expect(warnings).not.toContain("0491 570 156");
  });

  it('allows "None found." where a section may be empty, and warns on a TODO', () => {
    const text = briefText
      .replace(/## Several ways to do one thing\n\n[^\n]+/, "## Several ways to do one thing\n\nNone found.")
      .replace("## Rhythm\n\n", "## Rhythm\n\nTODO: ask about the season. ");
    const result = checkBrief(text);
    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.message)).toEqual(['"Rhythm" still has a TODO']);
  });
});

describe("consumers", () => {
  const brief = parseBrief(briefText);

  it("gives the help chat what the app is for, who uses it and its words, never open questions", () => {
    const chat = briefForChat(brief)!;
    expect(chat.startsWith("# Acme Events\n\n## What it's for")).toBe(true);
    expect(chat).toContain("## Words it uses");
    expect(chat).toContain("| Booking | One attendee's seats at one event | Ticket (the printed pass) |");
    expect(chat).not.toContain("Rules that matter");
    expect(chat).not.toContain("Open questions");
    expect(chat).not.toContain("<!--");
  });

  it("gives the agent connector every published section and the readers", () => {
    const overview = briefOverview(brief)!;
    expect(overview).toContain("Readers: Event organisers (Run ticketed community events from announcement to the last payment); Door staff");
    for (const name of BRIEF_SECTIONS.filter((s) => s !== "Open questions")) expect(overview).toContain(`## ${name}`);
    expect(overview).not.toContain("Can a door staff member refund");
  });

  it("gives the home page the first paragraph of what it's for, as plain text", () => {
    expect(briefIntro(brief)).toBe(
      "Acme Events lets small community groups sell seats at their events and see who has paid, without a spreadsheet. Organisers publish an event, take bookings and record payments.",
    );
    const long = parseBrief(`## What it's for\n\n${"A long sentence about the app. ".repeat(20)}\n`);
    expect(briefIntro(long)!.length).toBeLessThanOrEqual(280);
    expect(briefIntro(long)!.endsWith(".")).toBe(true);
  });

  it("caps what the chat gets", () => {
    const big = briefText.replace("## Who uses it\n\n", `## Who uses it\n\n${"Organisers do many things. ".repeat(600)}\n\n`);
    expect(briefForChat(parseBrief(big))!.length).toBeLessThanOrEqual(6_000 + 2);
  });

  it("returns nothing for an empty brief", () => {
    expect(briefForChat(parseBrief(briefTemplate({ updated: "2026-10-27" })))).toBeUndefined();
    expect(briefIntro(parseBrief(""))).toBeUndefined();
  });

  it("puts the brief beside the config unless the config says otherwise", () => {
    expect(briefPath({ configDir: "/repo/help" })).toBe(path.join("/repo/help", "app-brief.md"));
    expect(briefPath({ configDir: "/repo/help", brief: "docs/brief.md" })).toBe(path.join("/repo/help", "docs/brief.md"));
  });
});

describe("aida build hands the brief on", () => {
  it("writes the chat prefix, the agent overview and the home intro; removes a stale overview without one", () => {
    const helpApp = path.join(dir, "help");
    const pagesDir = path.join(dir, "out", "pages");
    mkdirSync(pagesDir, { recursive: true });
    const base = { pagesDir, outDir: path.join(dir, "out"), helpApp, pages: [], walkthroughs: [], productName: "Acme Events", chatConfig: resolveChatConfig(undefined, undefined) };

    const result = runIndexStage({ ...base, appBrief: briefArtifacts(parseBrief(briefText)) });
    const chatConfig = JSON.parse(readFileSync(path.join(helpApp, "public", "chat-config.json"), "utf8"));
    expect(chatConfig.brief).toContain("## What it's for");
    expect(result.appOverviewFile).toBe(path.join(helpApp, "public", "app-overview.md"));
    expect(readFileSync(result.appOverviewFile!, "utf8")).toContain("## Rules that matter");
    const home = readFileSync(path.join(helpApp, "content", "docs", "index.mdx"), "utf8");
    expect(home).toContain("Acme Events lets small community groups sell seats");

    runIndexStage(base);
    expect(existsSync(path.join(helpApp, "public", "app-overview.md"))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(helpApp, "public", "chat-config.json"), "utf8")).brief).toBeUndefined();
    expect(readFileSync(path.join(helpApp, "content", "docs", "index.mdx"), "utf8")).toContain("Guides, videos and printable instructions for Acme Events.");
  });
});

describe("briefTemplate", () => {
  it("writes every section with a prompt, readers from roles, and the domain model in plain words", () => {
    const domain = buildDomain(path.join(fixtures, "domain", "drizzle"));
    if (!domain.ok) throw new Error(domain.error);
    const text = briefTemplate({ app: "Acme Events", updated: "2026-10-27", roles: [{ role: "organiser", name: "an organiser" }], domain: domain.model });
    const brief = parseBrief(text);
    expect(brief.sections.map((s) => s.name)).toEqual([...BRIEF_SECTIONS]);
    expect(brief.frontmatter).toEqual({ app: "Acme Events", updated: "2026-10-27", readers: [{ role: "organiser", name: "an organiser", job: "" }] });
    expect(sectionText(findSection(brief, "Things it keeps track of"))).toContain("- **Booking**: belongs to an Event and an Attendee");
    expect(brief.sections.every((s) => s.body.includes("<!--"))).toBe(true);
  });
});

describe("findBriefSources", () => {
  it("lists the app's own prose, best first, with headings and never page text", () => {
    const result = findBriefSources(acmeApp);
    const byPath = new Map(result.sources.map((s) => [s.path, s]));
    expect(result.sources[0]).toMatchObject({ kind: "readme", path: "README.md", headings: ["Acme Events", "Features", "Running it locally"] });
    expect(byPath.get("package.json")?.note).toBe("acme-events: Book seats at community events and take payments");
    expect(byPath.get("app/layout.tsx")?.note).toBe("Acme Events — Book seats at community events.");
    expect(byPath.get("app/(marketing)/page.tsx")?.headings).toEqual(["Run your event the spreadsheet", "Bookings, payments and door lists in one place"]);
    expect(byPath.get("e2e/booking.spec.ts")).toMatchObject({ kind: "tests", note: "2 tests", headings: ["books two seats for an attendee", "records a cash payment at the door"] });
    expect(byPath.get("scripts/seed.ts")?.kind).toBe("seed");
    expect(byPath.get(".github/pull_request_template.md")?.kind).toBe("pr-template");
    expect(byPath.has("build/README.md")).toBe(false);
    // A how-to doc ranks above a deploy note and the changelog.
    const order = result.sources.map((s) => s.path);
    expect(order.indexOf("docs/guides/organiser-guide.md")).toBeLessThan(order.indexOf("docs/deploy.md"));
    expect(order.indexOf("docs/guides/organiser-guide.md")).toBeLessThan(order.indexOf("CHANGELOG.md"));
    const text = formatBriefSources(result);
    expect(text).not.toContain("must never be listed");
    expect(text.split("\n").length).toBeLessThan(60);
  });
});

describe("M36: brief sources rank product docs above ops notes", () => {
  it("puts guides, help, FAQs and marketing copy above migrations, runbooks and fix summaries", () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "aida-brief-rank-"));
    try {
      const files: Record<string, string> = {
        "README.md": "# Acme Events\n",
        "PERMISSIONS_IMPLEMENTATION.md": "# Roles: implementation\n",
        "WEBSITE_CONTENT.md": "# Acme Events website copy\n",
        "TODO.md": "# Todo\n",
        "docs/production-migration-runbook.md": "# Production migration\n",
        "docs/deploy-checklist.md": "# Deploy\n",
        "docs/SECURITY_REVIEW.md": "# Security\n",
        "docs/BUGFIX_SUMMARY.md": "# Fixes\n",
        "docs/TIMEZONE_IMPLEMENTATION_COMPLETE.md": "# Timezones done\n",
        "docs/ops/restore.md": "# Restore\n",
        "docs/faq.md": "# FAQ\n",
        "docs/tutorials/first-booking/README.md": "# Take your first booking\n",
        "docs/marketing/one-pager.md": "# Acme Events in one page\n",
        "docs/seating-plans.md": "# Seating plans\n",
      };
      for (const [rel, text] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
        writeFileSync(path.join(repo, rel), text);
      }
      const order = findBriefSources(repo).sources.map((s) => s.path);
      const product = ["WEBSITE_CONTENT.md", "docs/faq.md", "docs/tutorials/first-booking/README.md", "docs/marketing/one-pager.md", "docs/seating-plans.md"];
      const ops = ["PERMISSIONS_IMPLEMENTATION.md", "TODO.md", "docs/production-migration-runbook.md", "docs/deploy-checklist.md", "docs/SECURITY_REVIEW.md", "docs/BUGFIX_SUMMARY.md", "docs/TIMEZONE_IMPLEMENTATION_COMPLETE.md", "docs/ops/restore.md"];
      const lastProduct = Math.max(...product.map((p) => order.indexOf(p)));
      for (const p of product) expect(order).toContain(p);
      for (const o of ops) if (order.includes(o)) expect(order.indexOf(o)).toBeGreaterThan(lastProduct);
      // "production" is not "product": the migration runbook gets no product bonus.
      expect(scoreDoc("docs/production-migration-runbook.md", 60)).toBeLessThan(scoreDoc("docs/seating-plans.md", 60));
      // Net of helpful and ops words (M36 review): a user guide naming an ops topic ranks between
      // plain product docs and pure ops notes, not with the ops notes.
      const guide = scoreDoc("docs/guides/security-settings-guide.md", 60);
      expect(guide).toBeLessThan(scoreDoc("docs/guides/seating-guide.md", 60));
      expect(guide).toBeGreaterThan(scoreDoc("docs/SECURITY_REVIEW.md", 60));
      expect(guide).toBeGreaterThan(scoreDoc("docs/ops/restore.md", 60));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("aida brief commands", () => {
  it("sources prints a summary or JSON", async () => {
    expect(await runBriefSources({ repo: acmeApp, json: true })).toBe(0);
    expect(lastJson().sources.length).toBeGreaterThan(5);
    expect(await runBriefSources({ repo: path.join(dir, "nope"), json: false })).toBe(1);
  });

  it("check passes the fixture and fails a broken brief, with --json", async () => {
    expect(await runBriefCheck({ brief: briefFile, json: true })).toBe(0);
    expect(lastJson()).toMatchObject({ ok: true, errors: [] });
    const broken = path.join(dir, "broken.md");
    writeFileSync(broken, "## What it's for\n\nText.\n");
    expect(await runBriefCheck({ brief: broken, json: false })).toBe(1);
    expect(await runBriefCheck({ brief: path.join(dir, "absent.md"), json: true })).toBe(1);
    expect(await runBriefCheck({ json: false })).toBe(1);
  });

  it("show prints the whole brief, or only the sections asked for", async () => {
    expect(await runBriefShow({ brief: briefFile, json: false })).toBe(0);
    expect(writeSpy.mock.calls[0][0]).toBe(briefText);
    expect(await runBriefShow({ brief: briefFile, sections: ["words", "Rules that matter"], json: false })).toBe(0);
    const shown = logSpy.mock.calls[0][0] as string;
    expect(shown.startsWith("## Words it uses\n\n| Term |")).toBe(true);
    expect(shown).toContain("## Rules that matter\n\n- A refunded payment");
    expect(shown).not.toContain("Rhythm");
    expect(await runBriefShow({ brief: briefFile, sections: ["rhythm"], json: true })).toBe(0);
    expect(lastJson().sections).toEqual([{ name: "Rhythm", text: expect.stringMatching(/^Bookings open/) }]);
    expect(await runBriefShow({ brief: briefFile, sections: ["pricing"], json: false })).toBe(1);
  });

  it("init writes the skeleton from the schema and refuses to overwrite without --force", async () => {
    const file = path.join(dir, "help", "app-brief.md");
    expect(await runBriefInit({ brief: file, repo: path.join(fixtures, "domain", "sql"), json: true })).toBe(0);
    expect(lastJson()).toMatchObject({ ok: true, path: file, domain: { entities: 4 } });
    expect(readFileSync(file, "utf8")).toContain("- **Booking**:");
    writeFileSync(file, "mine");
    expect(await runBriefInit({ brief: file, repo: acmeApp, json: false })).toBe(1);
    expect(readFileSync(file, "utf8")).toBe("mine");
    expect(await runBriefInit({ brief: file, repo: acmeApp, force: true, json: false })).toBe(0);
    expect(readFileSync(file, "utf8")).toContain("## Open questions");
  });
});

describe("review fixes: what aida build publishes", () => {
  const write = (text: string) => {
    const file = path.join(dir, "app-brief.md");
    writeFileSync(file, text);
    return file;
  };

  it("publishes a brief that passes the check", () => {
    const result = briefForBuild(write(briefText));
    expect(result.skipped).toBeUndefined();
    expect(result.artifacts?.chat).toContain("## What it's for");
    expect(briefForBuild(path.join(dir, "absent.md"))).toEqual({});
  });

  it("skips a brief with check errors, personal data or template prompts left, saying why", () => {
    expect(briefForBuild(write(briefTemplate({ app: "Acme Events", updated: "2026-10-27" }))).skipped).toMatch(/error/);
    const pii = briefForBuild(write(briefText.replace("## Rhythm\n\n", "## Rhythm\n\nCall Jo on 0412 345 678. ")));
    expect(pii.artifacts).toBeUndefined();
    expect(pii.skipped).toMatch(/real-looking/);
    const prompt = `<!-- ${BRIEF_PROMPTS["Rules that matter"]} -->`;
    const withPrompt = briefForBuild(write(briefText.replace("## Rules that matter\n\n", `## Rules that matter\n\n${prompt}\n\n`)));
    expect(withPrompt.artifacts).toBeUndefined();
    expect(withPrompt.skipped).toContain("Rules that matter");
    expect(checkBrief(briefText.replace("## Rules that matter\n\n", `## Rules that matter\n\n${prompt}\n\n`)).warnings[0]).toMatchObject({ kind: "prompt" });
  });

  it("publishes only sections whose heading matches exactly, never one that merely resembles", () => {
    const leaky = briefText.replace("## Rhythm", "## Rhythm of open questions (private)");
    const overview = briefOverview(parseBrief(leaky))!;
    expect(overview).not.toContain("Bookings open weeks ahead");
    expect(overview).not.toContain("## Rhythm");
  });
});

describe("docsDirs", () => {
  it("finds docs/ and a workspace's docs app", async () => {
    const { mkdirSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { docsDirs } = await import("../../src/brief/sources.js");
    const root = mkdtempSync(join(tmpdir(), "aida-docs-dirs-"));
    for (const d of ["docs", "apps/web", "apps/docs", "packages/ui", "packages/documentation"]) mkdirSync(join(root, d), { recursive: true });
    expect(docsDirs(root)).toEqual(["docs", "apps/docs", "packages/documentation"]);
  });
});

describe("briefPages", () => {
  it("builds a glossary, the rules and what the app is for from the published sections", async () => {
    const { briefPages } = await import("../../src/brief/index.js");
    const pages = briefPages(parseBrief(briefText));
    const by = Object.fromEntries(pages.map((p) => [p.slug, p]));
    expect(by.glossary).toMatchObject({ category: "words-we-use", title: "Words Acme Events uses" });
    expect(by.glossary.body).toContain("## Booking\n\nOne attendee's seats at one event.\n\nNot to be confused with: Ticket (the printed pass)");
    expect(by["good-to-know"]).toMatchObject({ category: "troubleshooting-and-faq", title: "Good to know" });
    expect(by["good-to-know"].body).toBe("- A refunded payment can't be changed back, so check the amount before refunding.");
    expect(by["what-acme-events-is-for"]).toMatchObject({ category: "getting-started", first: true });
    expect(by["what-acme-events-is-for"].body).toContain("## Who uses it");
  });

  it("never publishes Open questions, escapes MDX, and skips empty sections", async () => {
    const { briefPages } = await import("../../src/brief/index.js");
    const text = `---\napp: Acme\n---\n\n## What it's for\n\nTracks {things} <fast>.\n\n## Words it uses\n\n| Term | Meaning | Not to be confused with |\n| --- | --- | --- |\n\n## Rules that matter\n\n## Open questions\n\n- Secret plan?\n`;
    const pages = briefPages(parseBrief(text));
    expect(pages.map((p) => p.slug)).toEqual(["what-acme-is-for"]);
    expect(pages[0].body).toContain("Tracks \\{things\\} \\<fast>.");
    expect(JSON.stringify(pages)).not.toContain("Secret plan");
  });

  it("the index stage writes them into their categories, and removes them when the brief goes", () => {
    const helpApp = path.join(dir, "help");
    const pagesDir = path.join(dir, "out", "pages");
    mkdirSync(pagesDir, { recursive: true });
    const base = { pagesDir, outDir: path.join(dir, "out"), helpApp, pages: [], walkthroughs: [], productName: "Acme Events" };
    runIndexStage({ ...base, appBrief: briefArtifacts(parseBrief(briefText)) });
    const docs = path.join(helpApp, "content", "docs");
    const glossary = readFileSync(path.join(docs, "words-we-use", "glossary", "index.mdx"), "utf8");
    expect(readFrontmatter(glossary)).toMatchObject({ brief: true, generated: true });
    expect(glossary).toContain("## Held");
    expect(JSON.parse(readFileSync(path.join(docs, "words-we-use", "meta.json"), "utf8")).pages).toEqual(["glossary", "..."]);
    expect(JSON.parse(readFileSync(path.join(docs, "getting-started", "meta.json"), "utf8")).pages[0]).toBe("what-acme-events-is-for");

    runIndexStage(base);
    expect(existsSync(path.join(docs, "words-we-use", "glossary"))).toBe(false);
    expect(existsSync(path.join(docs, "troubleshooting-and-faq", "good-to-know"))).toBe(false);
  });

  it("leaves a page a person has taken over", () => {
    const helpApp = path.join(dir, "help");
    const pagesDir = path.join(dir, "out", "pages");
    mkdirSync(pagesDir, { recursive: true });
    const own = path.join(helpApp, "content", "docs", "words-we-use", "glossary");
    mkdirSync(own, { recursive: true });
    writeFileSync(path.join(own, "index.mdx"), "---\ntitle: Our words\n---\n\nHand written.\n");
    runIndexStage({ pagesDir, outDir: path.join(dir, "out"), helpApp, pages: [], walkthroughs: [], appBrief: briefArtifacts(parseBrief(briefText)) });
    expect(readFileSync(path.join(own, "index.mdx"), "utf8")).toContain("Hand written.");
    runIndexStage({ pagesDir, outDir: path.join(dir, "out"), helpApp, pages: [], walkthroughs: [] });
    expect(existsSync(path.join(own, "index.mdx"))).toBe(true);
  });
});
