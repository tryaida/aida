// M35: `{{data}}` resolved everywhere text is printed or spoken — pages, PDF, card, procedures,
// search index, video captions/chips/cards, narration, path title/when/note — and an unresolved
// placeholder in output-bound text is a validate error. Fictional Acme invoices app.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { displayWalkthrough, resolveDisplayText, unresolvedDisplayText, type Walkthrough } from "../../src/walkthrough/index.js";
import type { CaptureManifest, ManifestStep, ValidationResult } from "../../src/capture/index.js";
import { buildPage } from "../../src/pages/build.js";
import { pdfInputFromPage } from "../../src/pdf/input.js";
import { buildCardHtml, buildPageHtml } from "../../src/pdf/html.js";
import { buildProcedure } from "../../src/procedures/build.js";
import { buildSearchIndex } from "../../src/index-search/index.js";
import { buildTimeline } from "../../src/render/timeline.js";
import { narrationLinesOf } from "../../src/commands/voice.js";
import { validatePath } from "../../src/commands/validate.js";
import { checkWalkthroughText } from "../../src/qa/walkthrough-text.js";
import { checkPlaceholders } from "../../src/qa/placeholders.js";
import { runQa } from "../../src/qa/run.js";
import { pathClipLines } from "../../src/render/clip-lines.js";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const dirs: string[] = [];
function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

function acme(): Walkthrough {
  return {
    walkthrough: "chase-invoices",
    title: "Chase {{filter.status}} invoices",
    summary: "Find every {{filter.status}} invoice for {{customer.name}}.",
    data: { filter: { status: "Unpaid" }, customer: { name: "Acme Pty Ltd" }, batch: { name: "Chase {{run.id}}" }, count: 3 },
    start: { page: "/invoices", signed_in_as: "staff", persona: { role: "staff" } },
    intro: { title: "Chase {{filter.status}} invoices", say: "Let's chase {{customer.name}}." },
    outro: { recap: ["Filtered to {{filter.status}}"], say: "That's {{count}} reminders." },
    steps: [
      {
        id: "filter",
        title: "Choose {{filter.status}}",
        say: "Open Payment Status and choose {{filter.status}}.",
        page_text: "Open **Payment Status** and choose **{{filter.status}}**.",
        callouts: [{ id: "c1", box: { x: 1, y: 1, w: 5, h: 5 }, label: "{{filter.status}} only" }],
        actions: [],
      },
      {
        id: "name-batch",
        title: "Name the batch",
        say: "Type {{batch.name}}.",
        page_text: "Type **{{batch.name}}** as the batch name.",
        actions: [],
      },
    ],
    paths: [
      {
        id: "from-customer",
        title: "From {{customer.name}}'s page",
        when: "Use this when only {{customer.name}} owes money.",
        note: "Filters to {{filter.status}} automatically.",
        start: { page: "/customers/7" },
        steps: [{ id: "open-customer", title: "Open {{customer.name}}", say: "Open {{customer.name}}.", page_text: "Select **{{customer.name}}**.", actions: [] }],
        joins: "name-batch",
      },
    ],
  };
}

function mstep(id: string, image: string, url: string): ManifestStep {
  return {
    id,
    camera: "full",
    cameraBox: null,
    events: [{ type: "frame", image, transition: "cut" }],
    doc: { image, highlights: [{ x: 600, y: 300, w: 120, h: 40 }], callouts: [{ id: "c1", box: { x: 1, y: 1, w: 5, h: 5 } }] },
    impact: { urls: [url], requests: [] },
    checks: [],
  };
}

function writeRun(dir: string, steps: ManifestStep[], extra: Partial<ValidationResult> = {}): void {
  mkdirSync(join(dir, "frames"), { recursive: true });
  for (const s of steps) writeFileSync(join(dir, "frames", s.doc.image!), TINY_PNG);
  const manifest: CaptureManifest = { workflow: "chase-invoices", baseUrl: "http://127.0.0.1:3100", viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1, steps };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  const validation: ValidationResult = {
    workflow: "chase-invoices",
    ranAt: "2026-10-27T00:00:00.000Z",
    baseUrl: "http://127.0.0.1:3100",
    ok: true,
    steps: steps.map((s) => ({ id: s.id, title: s.id, checks: [], ok: true, ms: 1 })),
    dbChecks: [],
    problems: { console: [], page: [], server: [] },
    ...extra,
  };
  writeFileSync(join(dir, "validation.json"), JSON.stringify(validation));
}

function capture(flagged = false): string {
  const dir = tmpDir("aida-display-capture-");
  const diff = { path: "from-customer", main: [], pathWrites: [], onlyInPath: ["POST /x"], onlyInMain: [], message: "x" };
  writeRun(dir, [mstep("filter", "m1.png", "/invoices"), mstep("name-batch", "m2.png", "/invoices/batch")], flagged ? { pathDiffs: [diff] } : {});
  writeRun(join(dir, "paths", "from-customer"), [mstep("open-customer", "p1.png", "/customers/7"), mstep("name-batch", "p2.png", "/invoices/batch")]);
  return dir;
}

const RAW = /\{\{|\\\{\\\{/;

describe("resolveDisplayText", () => {
  it("fills in data, drops {{run.*}} (directly or through data) and leaves a placeholder with no data", () => {
    const data = { filter: { status: "Unpaid" }, batch: { name: "Chase {{run.id}}" }, n: 2 };
    expect(resolveDisplayText("Choose **{{filter.status}}**.", data)).toBe("Choose **Unpaid**.");
    expect(resolveDisplayText("{{ n }} left", data)).toBe("2 left");
    expect(resolveDisplayText("Type {{batch.name}}.", data)).toBe("Type Chase.");
    expect(resolveDisplayText("Batch {{run.id}} saved", data)).toBe("Batch saved");
    expect(resolveDisplayText("Hi {{missing.key}}", data)).toBe("Hi {{missing.key}}");
    // An object has no words: left for validate to report.
    expect(resolveDisplayText("{{filter}}", data)).toBe("{{filter}}");
  });

  it("resolves every output-bound field and leaves actions alone", () => {
    const wt = acme();
    wt.steps[0].actions = [{ do: "select", target: { label: "Payment Status" }, option: "{{filter.status}}" } as never];
    const d = displayWalkthrough(wt);
    expect(d.title).toBe("Chase Unpaid invoices");
    expect(d.summary).toBe("Find every Unpaid invoice for Acme Pty Ltd.");
    expect(d.intro).toMatchObject({ title: "Chase Unpaid invoices", say: "Let's chase Acme Pty Ltd." });
    expect(d.outro).toMatchObject({ recap: ["Filtered to Unpaid"], say: "That's 3 reminders." });
    expect(d.steps[0]).toMatchObject({ title: "Choose Unpaid", page_text: "Open **Payment Status** and choose **Unpaid**." });
    expect(d.steps[0].callouts?.[0].label).toBe("Unpaid only");
    expect(d.steps[1].page_text).toBe("Type **Chase** as the batch name.");
    expect(d.paths?.[0]).toMatchObject({ title: "From Acme Pty Ltd's page", when: "Use this when only Acme Pty Ltd owes money.", note: "Filters to Unpaid automatically." });
    expect(d.paths?.[0].steps[0].page_text).toBe("Select **Acme Pty Ltd**.");
    expect((d.steps[0].actions[0] as { option: string }).option).toBe("{{filter.status}}");
    expect(displayWalkthrough(d)).toBe(d); // idempotent
    expect(wt.title).toBe("Chase {{filter.status}} invoices"); // input untouched
  });
});

describe("validate: unresolved placeholders in output-bound text", () => {
  const yaml = (pageText: string, extra = "") => `walkthrough: chase-invoices
title: Chase invoices
start:
  page: /invoices
data:
  filter:
    status: Unpaid
steps:
  - id: filter
    title: Choose the status
    do: click "Payment Status" button
    page_text: ${pageText}
${extra}`;

  it("passes when the data has the value", () => {
    const dir = tmpDir("aida-display-validate-");
    writeFileSync(join(dir, "a.yaml"), yaml("'Open **Payment Status** and choose **{{filter.status}}**.'"));
    expect(validatePath(join(dir, "a.yaml"))[0].ok).toBe(true);
  });

  it("is an error on the field, for steps and for a path's title, when and note", () => {
    const dir = tmpDir("aida-display-validate-");
    const paths = `paths:
  - id: from-customer
    title: "From {{customer.name}}"
    when: "Use this for {{customer.name}}."
    start:
      page: /customers/7
    steps:
      - id: open-customer
        title: Open the customer
        do: click "Acme" link
    joins: filter
`;
    writeFileSync(join(dir, "a.yaml"), yaml("'Choose **{{filter.colour}}**.'", paths));
    const [r] = validatePath(join(dir, "a.yaml"));
    expect(r.ok).toBe(false);
    const byPath = new Map((r.errors ?? []).map((e) => [e.path, e]));
    expect(byPath.get("steps.0.page_text")?.message).toMatch(/unresolved template placeholder \{\{filter\.colour\}\}/);
    expect(byPath.get("steps.0.page_text")?.check).toBe("text:unresolved-placeholder");
    expect(byPath.get("steps.0.page_text")?.line).toBe(12);
    expect(byPath.get("paths.0.title")?.message).toContain("{{customer.name}}");
    expect(byPath.get("paths.0.when")).toBeDefined();
    // Reported once per field, not again as a bare name.
    expect((r.errors ?? []).filter((e) => e.path === "filter.colour")).toHaveLength(0);
  });

  it("never counts {{run.id}} as unresolved (states/validate.ts warns where it reaches the screen)", () => {
    const wt = acme();
    wt.steps[1].page_text = "Batch {{run.id}}";
    expect(unresolvedDisplayText(wt)).toEqual([]);
    expect(checkWalkthroughText(wt).filter((p) => p.check === "text:unresolved-placeholder")).toEqual([]);
  });

  it("measures caption line length on the words as shown", () => {
    const wt = acme();
    wt.data = { long: "x".repeat(60) };
    wt.steps[0].say = "{{long}}";
    wt.steps[0].caption = undefined;
    expect(checkWalkthroughText(wt).some((p) => p.check === "captions:line-length" && p.step === "filter")).toBe(true);
  });
});

describe("every output prints {{data}} filled in", { timeout: 60_000 }, () => {
  it("page (mdx + plain), PDF page, card, search index and procedures", async () => {
    const wf = acme();
    const result = await buildPage(wf, capture(true), tmpDir("aida-display-out-"));
    const mdx = readFileSync(result.indexFile, "utf8");
    const plain = readFileSync(result.plainFile, "utf8");
    for (const text of [mdx, plain]) {
      expect(text).not.toMatch(RAW);
      expect(text).toContain("Unpaid");
      expect(text).toContain("Acme Pty Ltd");
    }
    expect(plain).toContain("Open **Payment Status** and choose **Unpaid**.");
    expect(plain).toContain("### From Acme Pty Ltd's page");
    expect(plain).toContain("> **Note:** Filters to Unpaid automatically.");
    expect(mdx).toContain('title: "Chase Unpaid invoices"');

    const input = pdfInputFromPage(wf, result);
    expect(input.title).toBe("Chase Unpaid invoices");
    const html = buildPageHtml(input);
    expect(html).not.toMatch(/\{\{/);
    expect(html).toContain("<strong>Unpaid</strong>");
    const card = buildCardHtml(input.title, input.cardSteps, undefined, { paper: "A4" });
    expect(card).not.toMatch(/\{\{/);
    expect(card).toContain("Unpaid");

    const content = tmpDir("aida-display-content-");
    mkdirSync(join(content, "chase-invoices"));
    writeFileSync(join(content, "chase-invoices", "index.mdx"), mdx);
    const { entries } = buildSearchIndex(content);
    expect(JSON.stringify(entries)).not.toMatch(/\{\{/);
    expect(entries.some((e) => e.text.includes("choose Unpaid"))).toBe(true);

    const proc = buildProcedure(wf, capture(true), {})!;
    expect(JSON.stringify(proc)).not.toMatch(/\{\{/);
    expect(proc.title).toBe("Chase Unpaid invoices");
    expect(proc.steps[0].instruction).toBe("Open Payment Status and choose Unpaid.");
    expect(proc.paths?.[0].title).toBe("From Acme Pty Ltd's page");
  });

  it("video captions, chips, cards and narration (main and path clips)", () => {
    const wf = acme();
    const manifest: CaptureManifest = {
      workflow: "chase-invoices",
      baseUrl: "http://127.0.0.1:3100",
      viewport: { width: 1440, height: 810 },
      deviceScaleFactor: 1,
      steps: [mstep("filter", "m1.png", "/invoices"), mstep("name-batch", "m2.png", "/invoices/batch")],
    };
    const beat = { audioPath: "/tmp/x.wav", durationMs: 1000 };
    const tl = buildTimeline(wf, manifest, { intro: beat, filter: beat, "name-batch": beat, outro: beat }, { fps: 30 });
    expect(JSON.stringify({ c: tl.captions, ch: tl.chips, i: tl.intro, o: tl.outro, co: tl.callouts })).not.toMatch(/\{\{/);
    expect(tl.intro.titleHtml).toBe("Chase Unpaid invoices");
    expect(tl.chips[0].title).toBe("Choose Unpaid");
    expect(tl.captions.map((c) => c.text)).toContain("Open Payment Status and choose Unpaid.");
    expect(tl.callouts?.[0].items[0].label).toBe("Unpaid only");

    const lines = narrationLinesOf(wf);
    expect(JSON.stringify(lines)).not.toMatch(/\{\{/);
    expect(lines.find((l) => l.id === "filter")?.text).toBe("Open Payment Status and choose Unpaid.");
    expect(lines.find((l) => l.id === "from-customer/open-customer")?.text).toBe("Open Acme Pty Ltd.");
    expect(pathClipLines(wf).map((l) => l.text)).toEqual([
      "Another way: From Acme Pty Ltd's page.",
      "Open Acme Pty Ltd.",
      "Then continue from step 2: Name the batch.",
    ]);
  });
});

describe("QA: raw placeholders in reader-facing files", () => {
  it("fails on {{x}} and on the MDX-escaped form, passes clean text", async () => {
    expect(checkPlaceholders("Choose **Unpaid**.").ok).toBe(true);
    expect(checkPlaceholders("Choose **{{filter.status}}**.").problems[0]).toContain("{{filter.status}}");
    expect(checkPlaceholders("Choose **\\{\\{filter.status\\}\\}**.").ok).toBe(false);
    const dir = tmpDir("aida-display-qa-");
    writeFileSync(join(dir, "index.mdx"), "# Title\n\nChoose \\{\\{filter.status\\}\\}.\n");
    const report = await runQa(dir);
    expect(report.checks.find((c) => c.check === "text:placeholder")?.ok).toBe(false);
  });
});

describe("who the guide is for (M35 review)", () => {
  it("prints `for` with data filled in on the page, procedures and video card; reports it unresolved", async () => {
    const wf = { ...acme(), for: "{{team.name}}", data: { ...acme().data, team: { name: "Accounts staff" } } };
    expect(displayWalkthrough(wf).for).toBe("Accounts staff");
    const result = await buildPage(wf, capture(), tmpDir("aida-display-out-"));
    const plain = readFileSync(result.plainFile, "utf8");
    expect(plain).toContain("This guide is for accounts staff.");
    expect(readFileSync(result.indexFile, "utf8")).not.toMatch(RAW);
    expect(buildProcedure(wf, capture(), {})!.for).toBe("Accounts staff");
    const missing = { ...acme(), for: "{{team.name}}" };
    expect(unresolvedDisplayText(missing)).toEqual([{ path: "for", placeholder: "team.name", text: "{{team.name}}", step: undefined }]);
  });
});

describe("reserved step ids (M35 review)", () => {
  it("rejects a main or path step with id intro or outro", () => {
    const dir = tmpDir("aida-display-reserved-");
    const file = join(dir, "a.yaml");
    writeFileSync(
      file,
      `walkthrough: chase-invoices
title: Chase invoices
start:
  page: /invoices
steps:
  - id: intro
    title: Open invoices
    do: click "Invoices" link
  - id: save
    title: Save
    do: click "Save" button
paths:
  - id: from-customer
    title: From the customer
    when: Use this for one customer.
    start:
      page: /customers/7
    steps:
      - id: outro
        title: Open the customer
        do: click "Acme" link
    joins: save
`,
    );
    const [r] = validatePath(file);
    expect(r.ok).toBe(false);
    const paths = (r.errors ?? []).map((e) => e.path);
    expect(paths).toContain("steps.0.id");
    expect(paths).toContain("paths.0.steps.0.id");
    expect((r.errors ?? []).find((e) => e.path === "steps.0.id")?.message).toMatch(/reserved for the video's title cards/);
  });
});
