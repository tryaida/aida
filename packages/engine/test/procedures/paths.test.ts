// M33: procedures, the help chat and outline drift know every way in (decision 34).
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { Walkthrough } from "../../src/walkthrough/index.js";
import type { CaptureManifest, ManifestStep, ValidationResult } from "../../src/capture/index.js";
import { buildProcedure, type Procedure } from "../../src/procedures/index.js";
import { retrieve } from "../../src/chat/retrieve.js";
import { buildContextBlock, buildCitations } from "../../src/chat/prompt.js";
import { cardLabels, computeDrift, seenNames } from "../../src/outline/drift.js";
import { listWalkthroughs } from "../../src/impact/walkthroughs.js";

const dirs: string[] = [];
function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

const wf: Walkthrough = {
  walkthrough: "record-payment",
  title: "Record a payment",
  start: { page: "/bookings/12", signed_in_as: "staff", persona: { role: "staff" } },
  steps: [
    { id: "open", title: "Open the payment form", page_text: "Select **Record payment**.", actions: [] },
    { id: "save", title: "Save the payment", page_text: "Select **Save**.", actions: [] },
  ],
  paths: [
    {
      id: "from-attendee",
      title: "From the attendee's page",
      when: "Use this when the attendee pays for several bookings at once.",
      start: { page: "/attendees/7" },
      steps: [{ id: "open-attendee", title: "Open the attendee's payments", page_text: "Select **Pay for attendee**.", actions: [] }],
      joins: "save",
      note: "Paying here spreads the money across the attendee's bookings.",
    },
    {
      id: "from-payments",
      title: "From Payments",
      when: "Use this when you don't have the booking open.",
      start: { page: "/payments" },
      steps: [{ id: "open-payments", title: "Open Payments", actions: [] }],
      joins: "save",
    },
  ],
};

function step(id: string, seen: string[] = []): ManifestStep {
  return { id, camera: "full", cameraBox: null, events: [], doc: { image: null, highlights: [] }, impact: { urls: [], requests: [] }, checks: [], ...(seen.length ? { seen } : {}) };
}

function writeRun(dir: string, steps: ManifestStep[], ok: boolean, extra: Partial<ValidationResult> = {}): void {
  mkdirSync(dir, { recursive: true });
  const manifest: CaptureManifest = { workflow: "record-payment", baseUrl: "http://127.0.0.1:3100", viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1, steps };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  const validation: ValidationResult = {
    workflow: "record-payment",
    ranAt: "2026-10-27T00:00:00.000Z",
    baseUrl: "",
    ok,
    steps: steps.map((s) => ({ id: s.id, title: s.id, checks: [], ok, ms: 1 })),
    dbChecks: [],
    problems: { console: [], page: [], server: [] },
    ...extra,
  };
  writeFileSync(join(dir, "validation.json"), JSON.stringify(validation));
}

const diff = { path: "from-attendee", main: [], pathWrites: [], onlyInPath: [], onlyInMain: [], message: "x" };

describe("procedures: paths", () => {
  it("lists each passing path with its start page, opening steps and the main step it joins; leaves failed paths out", () => {
    const captureDir = tmpDir("aida-proc-paths-");
    writeRun(captureDir, [step("open"), step("save")], true, { pathDiffs: [diff] });
    writeRun(join(captureDir, "paths", "from-attendee"), [step("open-attendee"), step("save")], true);
    writeRun(join(captureDir, "paths", "from-payments"), [step("open-payments"), step("save")], false);
    const proc = buildProcedure(wf, captureDir, {})!;
    expect(proc.paths).toEqual([
      {
        id: "from-attendee",
        title: "From the attendee's page",
        when: "Use this when the attendee pays for several bookings at once.",
        start: { page: "/attendees/7" },
        steps: [{ n: 1, title: "Open the attendee's payments", instruction: "Select Pay for attendee." }],
        joinsAt: 2,
        joinsTitle: "Save the payment",
        note: "Paying here spreads the money across the attendee's bookings.",
      },
    ]);
  });

  it("lists a path that runs to its own end with all its steps and no step to continue from (decision 37)", () => {
    const captureDir = tmpDir("aida-proc-paths-");
    const alone: Walkthrough = {
      ...wf,
      paths: [
        {
          id: "from-list",
          title: "From the list",
          when: "Use this when you're on the list.",
          start: { page: "/payments" },
          steps: [
            { id: "list-open", title: "Open the form", actions: [] },
            { id: "list-save", title: "Record it", actions: [{ do: "expect", target: { text: "Payment recorded" } }] },
          ],
        },
      ],
    };
    writeRun(captureDir, [step("open"), step("save")], true);
    writeRun(join(captureDir, "paths", "from-list"), [step("list-open"), step("list-save")], true);
    const proc = buildProcedure(alone, captureDir, {})!;
    expect(proc.paths).toHaveLength(1);
    expect(proc.paths![0].steps.map((s) => s.title)).toEqual(["Open the form", "Record it"]);
    expect(proc.paths![0]).not.toHaveProperty("joinsAt");
    const retrieved = { pages: [{ slug: "record-payment", title: "Record a payment", url: "/record-payment", sections: [], procedure: proc }] } as never;
    const context = buildContextBlock(retrieved, [{ n: 1, title: "Record a payment", url: "/record-payment" }] as never);
    expect(context).toContain("That's the whole task this way.");
    expect(context).not.toMatch(/continue from step/);
  });

  it("copies a path step's annotated page screenshot, never a raw frame", () => {
    const captureDir = tmpDir("aida-proc-paths-");
    const pagesDir = tmpDir("aida-proc-pages-");
    const publicDir = tmpDir("aida-proc-public-");
    writeRun(captureDir, [step("open"), step("save")], true);
    const shot = { ...step("open-attendee"), doc: { image: "p1.png", highlights: [] } };
    writeRun(join(captureDir, "paths", "from-attendee"), [shot, step("save")], true);
    mkdirSync(join(pagesDir, "record-payment", "screenshots", "paths"), { recursive: true });
    writeFileSync(join(pagesDir, "record-payment", "screenshots", "paths", "from-attendee-step-01.png"), "png");
    const proc = buildProcedure({ ...wf, paths: [wf.paths![0]] }, captureDir, { pagesDir, publicDir })!;
    expect(proc.paths?.[0].steps[0].screenshot).toBe("/screenshots/record-payment/paths/from-attendee-step-01.png");
    expect(existsSync(join(publicDir, "screenshots", "record-payment", "paths", "from-attendee-step-01.png"))).toBe(true);
    expect(proc.paths?.[0].note).toBeUndefined(); // not flagged: the note isn't shown
  });
});

const procedure: Procedure = {
  id: "record-payment",
  title: "Record a payment",
  url: "/how-do-i/record-payment",
  start: { page: "/bookings/12", role: "staff" },
  steps: [
    { n: 1, title: "Open the payment form", instruction: "Select Record payment." },
    { n: 2, title: "Save the payment", instruction: "Select Save." },
  ],
  paths: [
    {
      id: "from-attendee",
      title: "From the attendee's page",
      when: "Use this when the attendee pays for several bookings at once.",
      start: { page: "/attendees/7" },
      steps: [{ n: 1, title: "Open the attendee's payments", instruction: "Select Pay for attendee." }],
      joinsAt: 2,
      joinsTitle: "Save the payment",
    },
  ],
};

describe("help chat: paths", () => {
  const entries = [
    { url: "/how-do-i/record-payment", title: "Record a payment", text: "Record a payment against a booking." },
    { url: "/how-do-i/record-payment#other-ways-to-do-this", title: "Record a payment", heading: "Other ways to do this", text: "" },
    { url: "/how-do-i/record-payment#from-the-attendees-page", title: "Record a payment", heading: "From the attendee's page", text: "Use this when the attendee pays." },
  ];

  it("prefers the path that starts on the reader's screen and tells the model to lead with it", () => {
    const context = retrieve("how do I record a payment", entries, [procedure], { currentPath: "/attendees/7" });
    expect(context.pages[0].currentPathId).toBe("from-attendee");
    const block = buildContextBlock(context, buildCitations(context));
    expect(block).toContain("Other way: From the attendee's page, starting on /attendees/7 (the reader is on this screen now: lead with this way).");
    expect(block).toContain("  Then continue from step 2 (Save the payment).");
    // The path's section isn't repeated: the procedure carries it in full.
    expect(block).not.toContain("From the attendee's page: Use this when");
  });

  it("skips path sections by anchor, keeping a main section that shares a path's title", () => {
    const sections = [
      { url: "/how-do-i/record-payment#from-the-attendees-page", title: "Record a payment", heading: "From the attendee's page", text: "A main-section note the reader needs." },
      { url: "/how-do-i/record-payment#other-ways-to-do-this", title: "Record a payment", heading: "Other ways to do this", text: "" },
      { url: "/how-do-i/record-payment#from-the-attendees-page-1", title: "Record a payment", heading: "From the attendee's page", text: "Use this when the attendee pays." },
    ];
    const context = { pages: [{ url: "/how-do-i/record-payment", title: "Record a payment", score: 1, sections, procedure }], topScore: 1 };
    const block = buildContextBlock(context, buildCitations(context));
    expect(block).toContain("A main-section note the reader needs.");
    expect(block).not.toContain("From the attendee's page: Use this when the attendee pays.");
  });

  it("finds the walkthrough from a path's start page when nothing else matches", () => {
    const context = retrieve("zzzz", entries, [procedure], { currentPath: "/attendees/7" });
    expect(context.pages[0]).toMatchObject({ url: "/how-do-i/record-payment", currentPathId: "from-attendee" });
  });

  it("doesn't mark a path when the reader is on the main start page", () => {
    const context = retrieve("record a payment", entries, [procedure], { currentPath: "/bookings/12" });
    expect(context.pages[0].currentPathId).toBeUndefined();
  });
});

describe("outline drift and affected: paths", () => {
  it("counts quoted names in a card's paths as labels, and finds labels on a path's screens", () => {
    const card = { id: "record-payment", title: "Record a payment", status: "captured" as const, paths: ['from the "Payments" screen', "from the attendee"] };
    expect(cardLabels(card)).toEqual(["Payments"]);
    const main = { workflow: "x", baseUrl: "", viewport: { width: 1, height: 1 }, deviceScaleFactor: 1, steps: [step("open", ["Record payment"])] };
    const path = { ...main, steps: [step("open-payments", ["Payments"])] };
    expect(computeDrift(card, seenNames(main), "t").drift).toHaveLength(1);
    expect(computeDrift(card, [...seenNames(main), ...seenNames(path)], "t").drift).toHaveLength(0);
  });

  it("aida affected reads each path's manifest", () => {
    const root = tmpDir("aida-affected-paths-");
    mkdirSync(join(root, "walkthroughs"));
    writeFileSync(
      join(root, "walkthroughs", "record-payment.yaml"),
      `walkthrough: record-payment\ntitle: Record a payment\nstart: { page: /bookings/12 }\nsteps:\n  - id: open\n    do: click "Record payment" button\n  - id: save\n    do: click "Save" button\npaths:\n  - id: from-payments\n    title: From Payments\n    when: Use this from the Payments screen.\n    start: { page: /payments }\n    steps:\n      - id: open-payments\n        do: click "New payment" button\n    joins: save\n`,
    );
    const captureDir = join(root, ".build", "record-payment", "capture");
    writeRun(captureDir, [step("open"), step("save")], true);
    writeRun(join(captureDir, "paths", "from-payments"), [{ ...step("open-payments"), impact: { urls: ["/payments"], requests: [] } }, step("save")], true);
    const [entry] = listWalkthroughs(join(root, "walkthroughs"), join(root, ".build"));
    expect(entry.pathManifests?.map((p) => p.pathId)).toEqual(["from-payments"]);
    expect(entry.pathManifests?.[0].manifest.steps[0].impact.urls).toEqual(["/payments"]);
  });
});
