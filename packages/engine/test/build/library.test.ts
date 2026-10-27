// The index stage's help library layout (Contract 3): nested page folders by walkthrough
// `section:`, section index pages + meta.json order, root order, home page, media under
// public/videos/<id>/, and careful ownership of anything a person wrote.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runIndexStage } from "../../src/build/index-stage.js";
import type { BuildPageResult } from "../../src/pages/index.js";
import { readFrontmatter } from "../../src/pages/index.js";
import type { Walkthrough } from "../../src/walkthrough/index.js";

let dir: string;
let pagesDir: string;
let outDir: string;
let helpApp: string;
let docs: string;

function wf(id: string, title: string, section?: string, product = "Acme Events"): Walkthrough {
  return { walkthrough: id, title, product, ...(section ? { section } : {}), steps: [] } as unknown as Walkthrough;
}

function writePage(id: string, title: string, opts: { publishable?: boolean; screenshots?: Record<string, number> } = {}): BuildPageResult {
  const publishable = opts.publishable ?? true;
  const pageDir = path.join(pagesDir, id);
  mkdirSync(path.join(pageDir, "screenshots"), { recursive: true });
  const indexFile = path.join(pageDir, "index.mdx");
  writeFileSync(
    indexFile,
    [
      "---",
      `title: "${title}"`,
      "kind: walkthrough",
      `walkthrough: "${id}"`,
      `passed: ${publishable}`,
      `video: "../../videos/${id}/${id}.mp4"`,
      `srt: "../../videos/${id}/${id}.srt"`,
      `vtt: "../../videos/${id}/${id}.vtt"`,
      `pdf: "/pdf/${id}.pdf"`,
      "---",
      "",
      `# ${title}`,
      "",
      `Body for ${id}.`,
      "",
    ].join("\n"),
  );
  writeFileSync(path.join(pageDir, "index.plain.md"), `# ${title}\n\nBody for ${id}.\n`);
  writeFileSync(path.join(pageDir, "index.mdx.aida.json"), "{}");
  for (const [name, bytes] of Object.entries(opts.screenshots ?? { "step-01.png": 10 })) {
    writeFileSync(path.join(pageDir, "screenshots", name), "x".repeat(bytes));
  }
  return {
    id,
    outDir: pageDir,
    indexFile,
    plainFile: path.join(pageDir, "index.plain.md"),
    screenshotsDir: path.join(pageDir, "screenshots"),
    screenshots: [],
    passed: publishable,
    publishable,
    problems: [],
    suggestions: [],
  };
}

function writeRender(id: string, files = [".mp4", ".vtt", ".srt", ".chapters.vtt"]): void {
  const d = path.join(outDir, "videos", id);
  mkdirSync(d, { recursive: true });
  for (const ext of files) writeFileSync(path.join(d, `${id}${ext}`), `${id}${ext} data`);
}

function seedTemplate(): void {
  mkdirSync(docs, { recursive: true });
  writeFileSync(
    path.join(docs, "index.mdx"),
    '---\ntitle: "Help"\ndescription: "Guides, videos and printable instructions."\nkind: home\nplaceholder: true\npassed: true\n---\n',
  );
  writeFileSync(
    path.join(docs, "meta.json"),
    JSON.stringify({ title: "Help", pages: ["index", "...", "getting-started", "how-do-i", "screens-and-settings", "words-we-use", "troubleshooting-and-faq", "whats-new"] }),
  );
  for (const [slug, title] of [
    ["getting-started", "Getting started"],
    ["how-do-i", "How do I…"],
    ["whats-new", "What's new"],
  ]) {
    mkdirSync(path.join(docs, slug), { recursive: true });
    writeFileSync(path.join(docs, slug, "index.mdx"), `---\ntitle: "${title}"\nkind: section\nplaceholder: true\npassed: true\n---\n`);
    writeFileSync(path.join(docs, slug, "meta.json"), JSON.stringify({ title }));
  }
}

const fm = (rel: string) => readFrontmatter(readFileSync(path.join(docs, rel), "utf8"));
const json = (rel: string) => JSON.parse(readFileSync(path.join(docs, rel), "utf8"));

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "aida-library-"));
  outDir = path.join(dir, "out");
  pagesDir = path.join(outDir, "pages");
  helpApp = path.join(dir, "help");
  docs = path.join(helpApp, "content", "docs");
  mkdirSync(pagesDir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("index stage library layout", () => {
  it("stages pages into their section folders and writes section pages, meta.json order, root order and the home page", () => {
    seedTemplate();
    const walkthroughs = [
      wf("record-a-payment", "Record a payment", "Payments"),
      wf("filter-unpaid-entries", "Find unpaid entries", "Payments"),
      wf("add-competitor", "Add a competitor", "Competitors"),
      wf("export-results", "Export results"),
    ];
    const pages = walkthroughs.map((w) => writePage(w.walkthrough, w.title));
    runIndexStage({ pagesDir, outDir, helpApp, pages, walkthroughs, walkthroughIds: walkthroughs.map((w) => w.walkthrough) });

    expect(existsSync(path.join(docs, "how-do-i/payments/record-a-payment/index.mdx"))).toBe(true);
    expect(existsSync(path.join(docs, "how-do-i/payments/record-a-payment/screenshots/step-01.png"))).toBe(true);
    expect(existsSync(path.join(docs, "how-do-i/payments/record-a-payment/index.mdx.aida.json"))).toBe(false);
    expect(existsSync(path.join(docs, "how-do-i/export-results/index.mdx"))).toBe(true);

    expect(fm("how-do-i/payments/index.mdx")).toEqual({
      title: "Payments",
      description: "Step-by-step guides for payments.",
      kind: "section",
      generated: true,
    });
    expect(fm("how-do-i/index.mdx")).toMatchObject({ title: "How do I…", kind: "section", generated: true });
    expect(fm("how-do-i/index.mdx").placeholder).toBeUndefined();
    // Categories with no pages stay placeholders (the site hides them); never deleted.
    expect(fm("getting-started/index.mdx").placeholder).toBe(true);

    expect(json("how-do-i/meta.json")).toEqual({ title: "How do I…", pages: ["competitors", "payments", "export-results", "..."], generated: true });
    expect(json("how-do-i/payments/meta.json")).toEqual({
      title: "Payments",
      pages: ["filter-unpaid-entries", "record-a-payment", "..."],
      generated: true,
    });
    expect(json("meta.json").pages).toEqual([
      "index",
      "getting-started",
      "how-do-i",
      "screens-and-settings",
      "words-we-use",
      "troubleshooting-and-faq",
      "whats-new",
      "...",
    ]);

    expect(fm("index.mdx")).toEqual({
      title: "Acme Events help",
      description: "Guides, videos and printable instructions for Acme Events.",
      kind: "home",
      generated: true,
    });

    const page = fm("how-do-i/payments/record-a-payment/index.mdx");
    expect(page.section).toBe("How do I… / Payments");
    expect(page.walkthrough).toBe("record-a-payment");
    expect(page.pdf).toBe("/pdf/record-a-payment.pdf");

    const search = JSON.parse(readFileSync(path.join(helpApp, "public", "search-index.json"), "utf8")) as { url: string }[];
    expect(search.some((e) => e.url === "/how-do-i/payments/record-a-payment")).toBe(true);
    expect(search.some((e) => e.url === "/how-do-i/payments")).toBe(true);
    expect(search.some((e) => e.url === "/getting-started")).toBe(false); // placeholder
    const llms = readFileSync(path.join(helpApp, "public", "llms.txt"), "utf8");
    expect(llms).toContain("# record-a-payment");
    expect(llms).toContain("# add-competitor");
  });

  it("moves a legacy flat content/docs/<id> page, and pages whose section changed, even when this run didn't rebuild them", () => {
    const a = writePage("record-a-payment", "Record a payment");
    const b = writePage("add-competitor", "Add a competitor");
    // An older build: flat layout.
    runIndexStage({ pagesDir, outDir, helpApp, pages: [a, b] });
    rmSync(path.join(docs, "how-do-i"), { recursive: true });
    mkdirSync(path.join(docs, "record-a-payment"), { recursive: true });
    writeFileSync(path.join(docs, "record-a-payment", "index.mdx"), '---\ntitle: "Record a payment"\nwalkthrough: "record-a-payment"\n---\n');

    runIndexStage({ pagesDir, outDir, helpApp, pages: [], walkthroughs: [wf("record-a-payment", "Record a payment", "Payments")], walkthroughIds: ["record-a-payment"] });
    expect(existsSync(path.join(docs, "record-a-payment"))).toBe(false);
    expect(fm("how-do-i/payments/record-a-payment/index.mdx").section).toBe("How do I… / Payments");

    // Section changes: the page moves and the now-empty generated section folder goes away.
    runIndexStage({ pagesDir, outDir, helpApp, pages: [], walkthroughs: [wf("record-a-payment", "Record a payment", "Money / Fees")], walkthroughIds: ["record-a-payment"] });
    expect(existsSync(path.join(docs, "how-do-i/payments"))).toBe(false);
    expect(existsSync(path.join(docs, "how-do-i/money/fees/record-a-payment/index.mdx"))).toBe(true);
    expect(fm("how-do-i/money/index.mdx").title).toBe("Money");
    expect(json("how-do-i/money/meta.json").pages).toEqual(["fees", "..."]);
  });

  it("never touches a human-written section index, human pages, or a person's meta.json — and appends a missing page to an explicit list", () => {
    mkdirSync(path.join(docs, "how-do-i", "payments"), { recursive: true });
    writeFileSync(path.join(docs, "how-do-i/payments/index.mdx"), '---\ntitle: "Taking money"\n---\n\nOur own intro.\n');
    writeFileSync(path.join(docs, "how-do-i/payments/meta.json"), JSON.stringify({ title: "Taking money", pages: ["refunds"] }));
    mkdirSync(path.join(docs, "how-do-i/payments/refunds"), { recursive: true });
    writeFileSync(path.join(docs, "how-do-i/payments/refunds/index.mdx"), '---\ntitle: "Refunds"\n---\n\nHand-written.\n');
    writeFileSync(path.join(docs, "index.mdx"), '---\ntitle: "Our help"\n---\n\nWritten by us.\n');

    const page = writePage("record-a-payment", "Record a payment");
    runIndexStage({ pagesDir, outDir, helpApp, pages: [page], walkthroughs: [wf("record-a-payment", "Record a payment", "Payments")], walkthroughIds: ["record-a-payment"] });

    expect(readFileSync(path.join(docs, "how-do-i/payments/index.mdx"), "utf8")).toContain("Our own intro.");
    expect(json("how-do-i/payments/meta.json")).toEqual({ title: "Taking money", pages: ["refunds", "record-a-payment"] });
    expect(readFileSync(path.join(docs, "index.mdx"), "utf8")).toContain("Written by us.");

    // Page deleted from disk: the walkthrough page goes, the human folder and page stay.
    runIndexStage({ pagesDir, outDir, helpApp, pages: [], walkthroughIds: [] });
    expect(existsSync(path.join(docs, "how-do-i/payments/record-a-payment"))).toBe(false);
    expect(existsSync(path.join(docs, "how-do-i/payments/refunds/index.mdx"))).toBe(true);
    expect(existsSync(path.join(docs, "how-do-i/payments/index.mdx"))).toBe(true);
  });

  it("links the render's video, captions and chapters under public/videos/<id>/ and points the page at site URLs", () => {
    writeRender("record-a-payment");
    const page = writePage("record-a-payment", "Record a payment", { screenshots: { "step-01.png": 5, "step-02.png": 50, "step-03.png": 50 } });
    runIndexStage({ pagesDir, outDir, helpApp, pages: [page], videoDir: path.join(outDir, "videos"), walkthroughs: [wf("record-a-payment", "Record a payment")] });

    const published = path.join(helpApp, "public", "videos", "record-a-payment");
    for (const ext of [".mp4", ".vtt", ".srt", ".chapters.vtt"]) expect(existsSync(path.join(published, `record-a-payment${ext}`))).toBe(true);
    // Hardlinked, not copied (same filesystem).
    expect(statSync(path.join(published, "record-a-payment.mp4")).ino).toBe(statSync(path.join(outDir, "videos/record-a-payment/record-a-payment.mp4")).ino);

    const f = fm("how-do-i/record-a-payment/index.mdx");
    expect(f.video).toBe("/videos/record-a-payment/record-a-payment.mp4");
    expect(f.vtt).toBe("/videos/record-a-payment/record-a-payment.vtt");
    expect(f.srt).toBe("/videos/record-a-payment/record-a-payment.srt");
    expect(f.chapters).toBe("/videos/record-a-payment/record-a-payment.chapters.vtt");
    // Poster: the largest screenshot, earliest on a tie.
    expect(f.poster).toBe("/screenshots/record-a-payment/step-02.png");
    expect(existsSync(path.join(helpApp, "public/screenshots/record-a-payment/step-02.png"))).toBe(true);
  });

  it("publishes only the path clips the page embeds and the walkthrough still has; removes the rest (M35)", () => {
    writeRender("record-a-payment", [".mp4", ".vtt", ".path-from-attendee.mp4", ".path-from-attendee.vtt", ".path-from-attendee.srt", ".path-failed.mp4", ".path-old.mp4"]);
    const page = writePage("record-a-payment", "Record a payment");
    // pages/build.ts embeds a clip only for a path whose capture passed: "failed" isn't embedded.
    const embed = (p: string) => `<VideoEmbed src={"/videos/record-a-payment/record-a-payment.path-${p}.mp4"} title={"x"} />`;
    writeFileSync(page.indexFile, `${readFileSync(page.indexFile, "utf8")}\n${embed("from-attendee")}\n\n${embed("old")}\n`);
    const withPaths = {
      ...wf("record-a-payment", "Record a payment"),
      steps: [{ id: "save", title: "Save", actions: [] }],
      paths: ["from-attendee", "failed"].map((id) => ({ id, title: id, when: "w", start: { page: "/x" }, steps: [], joins: "save" })),
    } as unknown as Walkthrough;
    const videoDir = path.join(outDir, "videos");
    const published = path.join(helpApp, "public", "videos", "record-a-payment");
    mkdirSync(published, { recursive: true });
    writeFileSync(path.join(published, "record-a-payment.path-stale.mp4"), "from an older build");
    runIndexStage({ pagesDir, outDir, helpApp, pages: [page], videoDir, walkthroughs: [withPaths] });
    for (const ext of [".path-from-attendee.mp4", ".path-from-attendee.vtt", ".path-from-attendee.srt"]) {
      expect(existsSync(path.join(published, `record-a-payment${ext}`))).toBe(true);
    }
    // Not embedded (capture failed), embedded but no longer a path, or left over: not published.
    for (const ext of [".path-failed.mp4", ".path-old.mp4", ".path-stale.mp4"]) expect(existsSync(path.join(published, `record-a-payment${ext}`))).toBe(false);
  });

  it("writes the page description from the summary with {{data}} filled in (M35)", () => {
    const page = writePage("record-a-payment", "Record a payment");
    const w = { ...wf("record-a-payment", "Record a payment"), summary: "Record a payment for {{who.name}}.", data: { who: { name: "Acme Pty Ltd" } } } as unknown as Walkthrough;
    runIndexStage({ pagesDir, outDir, helpApp, pages: [page], walkthroughs: [w] });
    expect(fm("how-do-i/record-a-payment/index.mdx").description).toBe("Record a payment for Acme Pty Ltd.");
  });

  it("drops media keys when there's no render, and removes published media once a page stops being publishable", () => {
    const page = writePage("record-a-payment", "Record a payment");
    runIndexStage({ pagesDir, outDir, helpApp, pages: [page], videoDir: path.join(outDir, "videos") });
    const f = fm("how-do-i/record-a-payment/index.mdx");
    expect(f.video).toBeUndefined();
    expect(f.srt).toBeUndefined();
    expect(f.chapters).toBeUndefined();

    writeRender("record-a-payment");
    runIndexStage({ pagesDir, outDir, helpApp, pages: [page], videoDir: path.join(outDir, "videos") });
    expect(existsSync(path.join(helpApp, "public/videos/record-a-payment/record-a-payment.mp4"))).toBe(true);

    const failing = writePage("record-a-payment", "Record a payment", { publishable: false });
    runIndexStage({ pagesDir, outDir, helpApp, pages: [failing], videoDir: path.join(outDir, "videos") });
    expect(existsSync(path.join(helpApp, "public/videos/record-a-payment"))).toBe(false);
    expect(existsSync(path.join(outDir, "videos/record-a-payment/record-a-payment.mp4"))).toBe(true); // the render itself is kept
  });

  it("never deletes renders when the render folder is the published folder", () => {
    // outDir = <helpApp>/public: the render dir *is* public/videos.
    const publicVideos = path.join(helpApp, "public", "videos");
    mkdirSync(path.join(publicVideos, "flow"), { recursive: true });
    writeFileSync(path.join(publicVideos, "flow", "flow.mp4"), "video");
    const failing = writePage("flow", "Flow", { publishable: false });
    runIndexStage({ pagesDir, outDir, helpApp, pages: [failing], videoDir: publicVideos });
    expect(existsSync(path.join(publicVideos, "flow", "flow.mp4"))).toBe(true);
  });

  it("writes procedures.json urls for nested pages", () => {
    const captureDir = path.join(dir, "capture");
    mkdirSync(captureDir, { recursive: true });
    writeFileSync(path.join(captureDir, "manifest.json"), JSON.stringify({ steps: [] }));
    writeFileSync(path.join(captureDir, "validation.json"), JSON.stringify({ ok: true, steps: [] }));
    const w = wf("record-a-payment", "Record a payment", "Payments");
    const page = writePage("record-a-payment", "Record a payment");
    const result = runIndexStage({ pagesDir, outDir, helpApp, pages: [page], procedureSources: [{ walkthrough: { ...w, start: {} } as Walkthrough, captureDir }] });
    expect(result.procedures?.[0].url).toBe("/how-do-i/payments/record-a-payment");
  });

  it("uses the configured product name when no walkthrough sets one, and plain 'Help' otherwise", () => {
    const page = writePage("a", "A");
    runIndexStage({ pagesDir, outDir, helpApp, pages: [page], walkthroughs: [{ ...wf("a", "A"), product: undefined }], productName: "Acme" });
    expect(fm("index.mdx").title).toBe("Acme help");
    runIndexStage({ pagesDir, outDir, helpApp, pages: [page], walkthroughs: [{ ...wf("a", "A"), product: undefined }] });
    expect(fm("index.mdx").title).toBe("Help");
  });
});
