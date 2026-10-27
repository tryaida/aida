import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CaptureManifest, ManifestStep } from "../../src/capture/types.js";
import { targetNames } from "../../src/capture/target-names.js";
import {
  addCard,
  cardLabels,
  describeDrift,
  checkOutline,
  computeDrift,
  labelMatches,
  noteCard,
  outlinePath,
  parseMarkdownCards,
  parseOutline,
  readOrCreateOutline,
  readOutline,
  recordCaptureDrift,
  seenNames,
  setDrift,
  updateOutline,
  writeOutline,
  type OutlineCard,
} from "../../src/outline/index.js";
import { loadWalkthroughText, type Walkthrough } from "../../src/walkthrough/index.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function project(): { dir: string; config: { configDir: string; walkthroughsDir: string; buildDir: string } } {
  const dir = mkdtempSync(join(tmpdir(), "aida-outline-"));
  dirs.push(dir);
  mkdirSync(join(dir, "walkthroughs"));
  return { dir, config: { configDir: dir, walkthroughsDir: join(dir, "walkthroughs"), buildDir: join(dir, ".build") } };
}

const card = (over: Partial<OutlineCard> = {}): OutlineCard => ({ id: "add-session", title: "Add a session", status: "planned", ...over });

function step(id: string, targets?: string[], seen?: string[]): ManifestStep {
  return {
    id,
    camera: "full",
    cameraBox: null,
    events: [],
    doc: { image: null, highlights: [] },
    impact: { urls: [], requests: [] },
    checks: [],
    ...(targets ? { targets } : {}),
    ...(seen ? { seen } : {}),
  };
}

function manifest(steps: ManifestStep[]): CaptureManifest {
  return { workflow: "add-session", baseUrl: "http://127.0.0.1", viewport: { width: 1, height: 1 }, deviceScaleFactor: 1, steps };
}

const WALKTHROUGH = `walkthrough: add-session
title: Add a session
steps:
  - id: open
    actions:
      - do: click
        target: { role: link, name: Sessions }
  - id: add
    actions:
      - do: click
        target: { role: button, name: Add session }
      - do: expect
        target: { text: "Session for {{run.id}}" }
`;
const wt = (): Walkthrough => loadWalkthroughText(WALKTHROUGH, "add-session.yaml");
const passed = { steps: [{ id: "open", title: undefined, checks: [], ok: true, ms: 1 }, { id: "add", title: undefined, checks: [], ok: true, ms: 1 }] };

describe("outline schema", () => {
  it("accepts cards, defaults status to planned and turns a single note into a list", () => {
    const { outline } = parseOutline(`cards:\n  - id: add-session\n    title: Add a session\n    notes: one note\n`);
    expect(outline.cards[0]).toMatchObject({ id: "add-session", status: "planned", notes: ["one note"] });
  });

  it("rejects a non-kebab id, an unknown status, an unknown key and duplicate ids, with line numbers", () => {
    expect(() => parseOutline(`cards:\n  - id: Add Session\n    title: t\n`, "o.yaml")).toThrow(/o\.yaml:2: card ids are kebab-case/);
    expect(() => parseOutline(`cards:\n  - id: a\n    title: t\n    status: done\n`)).toThrow(/status/);
    expect(() => parseOutline(`cards:\n  - id: a\n    title: t\n    colour: red\n`)).toThrow(/colour/);
    expect(() => parseOutline(`cards:\n  - { id: a, title: t }\n  - { id: a, title: u }\n`)).toThrow(/duplicate card id "a"/);
  });

  it("checks drift entries", () => {
    expect(() => parseOutline(`cards:\n  - id: a\n    title: t\n    drift:\n      - { expected: X, at: now, source: robot }\n`)).toThrow(/source/);
  });

  it("puts outline.yaml next to the walkthroughs dir unless config says otherwise", () => {
    expect(outlinePath({ configDir: "/p/help", walkthroughsDir: "/p/help/walkthroughs" })).toBe("/p/help/outline.yaml");
    expect(outlinePath({ configDir: "/p/help", walkthroughsDir: "/p/help/walkthroughs", outline: "plan/cards.yaml" })).toBe("/p/help/plan/cards.yaml");
  });
});

describe("import from the plan skill's markdown cards", () => {
  it("reads titles, for/section, purpose, labels and ids, and ignores prose around the list", () => {
    const md = [
      "## Outline",
      "",
      "```",
      "- Add a new competitor and their first entry",
      "  for: office staff · section: Competitors · from Competitors page to a submitted entry",
      "- Record a \"Cash\" payment",
      "  id: record-payment · for: office staff · section: Payments · labels: \"Record payment\", \"Save\"",
      "```",
      "",
      "Cut: exports (rarely used).",
    ].join("\n");
    const cards = parseMarkdownCards(md);
    expect(cards).toEqual([
      {
        id: "add-a-new-competitor-and-their-first-entry",
        title: "Add a new competitor and their first entry",
        for: "office staff",
        section: "Competitors",
        purpose: "from Competitors page to a submitted entry",
        status: "planned",
      },
      { id: "record-payment", title: 'Record a "Cash" payment', for: "office staff", section: "Payments", labels: ["Record payment", "Save"], status: "planned" },
    ]);
    expect(cardLabels(cards[1])).toEqual(["Record payment", "Save", "Cash"]);
  });

  it("reads paths: the other screens a task starts from (M31, for M33)", () => {
    const md = "- Record a payment\n  for: office staff · section: Payments\n  paths: from the booking, from the attendee, from Payments";
    expect(parseMarkdownCards(md)[0].paths).toEqual(["from the booking", "from the attendee", "from Payments"]);
  });
});

describe("drift computation", () => {
  const seen = [
    { name: "Sessions", step: "open" },
    { name: "Add session", step: "add" },
    { name: "Register", step: "add" },
  ];

  it("matches exactly and case-insensitively, and inside a longer name", () => {
    expect(labelMatches("Add session", "Add session")).toBe(true);
    expect(labelMatches("add SESSION", "Add session")).toBe(true);
    expect(labelMatches("Add session", "+ Add session")).toBe(true);
    expect(labelMatches("Register again", "Register")).toBe(false);
    const r = computeDrift(card({ labels: ["add session", "Sessions"] }), seen, "t1");
    expect(r.drift).toEqual([]);
  });

  it("records an unmatched label with the closest name and its step", () => {
    const r = computeDrift(card({ labels: ["Save session", "Register again"] }), seen, "t1");
    expect(r.drift).toEqual([
      { expected: "Save session", seen: "Add session", step: "add", at: "t1", source: "capture" },
      { expected: "Register again", seen: "Register", step: "add", at: "t1", source: "capture" },
    ]);
    expect(r.added).toHaveLength(2);
  });

  it("counts quoted strings in the title and purpose as labels", () => {
    const r = computeDrift(card({ title: 'Add a session with "Save session"', purpose: 'then "Sessions"' }), seen, "t1");
    expect(r.drift.map((d) => d.expected)).toEqual(["Save session"]);
  });

  it("leaves seen out when nothing on screen is close", () => {
    const r = computeDrift(card({ labels: ["Export to spreadsheet"] }), seen, "t1");
    expect(r.drift[0]).toEqual({ expected: "Export to spreadsheet", at: "t1", source: "capture" });
    // Loosely alike ("Sessions" vs "Session notes") isn't close enough to suggest a rename.
    expect(computeDrift(card({ labels: ["Session notes"] }), seen, "t1").drift[0].seen).toBeUndefined();
  });

  it("never suggests a walkthrough's own target string as the card's real name", () => {
    const targetsOnly = seen.map((s) => ({ ...s, source: "target" as const }));
    const r = computeDrift(card({ labels: ["Save session"] }), targetsOnly, "t1");
    expect(r.drift).toEqual([{ expected: "Save session", at: "t1", source: "capture" }]);
  });

  it("skips {{...}} templates inside quoted labels", () => {
    expect(cardLabels(card({ title: 'Find "{{competitor.name}}" and click "Edit"', labels: ["{{x}}"] }))).toEqual(["Edit"]);
  });

  it("keeps the first time, clears a label that appears later, and keeps unmatched writer notes", () => {
    const before = card({
      labels: ["Save session"],
      drift: [
        { expected: "Save session", seen: "Add sessions", at: "t0", source: "capture" },
        { expected: "Register again", at: "t0", source: "writer" },
        { expected: "Sessions", at: "t0", source: "writer" },
      ],
    });
    const r = computeDrift(before, seen, "t1");
    expect(r.drift).toEqual([
      { expected: "Register again", at: "t0", source: "writer" },
      { expected: "Save session", seen: "Add session", step: "add", at: "t0", source: "capture" },
    ]);
    expect(r.cleared.map((d) => d.expected)).toEqual(["Sessions"]);
    const later = computeDrift({ ...before, drift: r.drift }, [...seen, { name: "Save session", step: "add" }], "t2");
    expect(later.drift.map((d) => d.expected)).toEqual(["Register again"]);
    expect(later.cleared.map((d) => d.expected)).toEqual(["Save session"]);
  });
});

describe("drift from what was on screen (manifest seen)", () => {
  // The step clicks `name: "Save"` (Playwright substring-matched "Save session") and reaches the
  // "Session details" heading by `goto`, so neither name is among the walkthrough's target strings.
  const m = manifest([step("open", ["Sessions"], ["Sessions", "Session details"]), step("save", ["Save"], ["Save session", "Session details"])]);

  it("prefers seen over targets", () => {
    expect(seenNames(m).map((s) => [s.name, s.step, s.source])).toEqual([
      ["Sessions", "open", "screen"],
      ["Session details", "open", "screen"],
      ["Save session", "save", "screen"],
      ["Session details", "save", "screen"],
    ]);
  });

  it("matches a heading reached by goto, and a full label the walkthrough only targets in part", () => {
    const r = computeDrift(card({ labels: ["Session details", "Save session"] }), seenNames(m), "t1");
    expect(r.drift).toEqual([]);
  });

  it("falls back to targets for an old manifest, flagging without a rename suggestion", () => {
    const old = manifest([step("open", ["Sessions"]), step("save", ["Save"])]);
    const r = computeDrift(card({ labels: ["Session details", "Save session", "Sessions"] }), seenNames(old), "t1");
    expect(r.drift).toEqual([
      { expected: "Session details", at: "t1", source: "capture" },
      { expected: "Save session", at: "t1", source: "capture" },
    ]);
    expect(describeDrift(r.drift[0])).toBe('"Session details" (not seen on any captured screen)');
  });

  it("suggests the closest real name when it's close", () => {
    const r = computeDrift(card({ labels: ["Save sessions"] }), seenNames(m), "t1");
    expect(r.drift).toEqual([{ expected: "Save sessions", seen: "Save session", step: "save", at: "t1", source: "capture" }]);
  });
});

describe("target names in the manifest", () => {
  it("collects names, labels, text, options and nested targets, skipping templates and regexes", () => {
    expect(
      targetNames([
        { do: "click", target: { role: "button", name: "Add session", within: { role: "dialog", name: "New session" } } },
        { do: "type", target: { label: "Title" }, text: "Hello" },
        { do: "select", target: { label: "Room" }, option: "Main hall" },
        { do: "expect", target: { text: "/Saved .*/" } },
        // locate.ts takes no regex flags: "/Done/i" is the literal text "/Done/i".
        { do: "expect", target: { text: "/Done/i" } },
        { do: "expect", target: { text: "Session {{run.id}}" } },
        { do: "waitFor", target: { placeholder: "Search" }, highlight: { role: "region", name: "Results" } },
        { do: "goto", path: "/x" },
      ]),
    ).toEqual(["Add session", "New session", "Title", "Room", "Main hall", "/Done/i", "Search", "Results"]);
  });
});

const COMMENTED = `# Outline for the pilot. Keep cards short.
cards:
  # Staff tasks first.
  - id: add-session # renamed from new-session
    title: Add a session
    labels: ["Save session"]
    status: planned # not written yet
`;

describe("writes keep comments", () => {
  it("adds a card, records drift and notes without losing comments", () => {
    const { dir, config } = project();
    const file = outlinePath(config);
    writeFileSync(file, COMMENTED);
    const loaded = readOutline(file)!;
    addCard(loaded.doc, card({ id: "record-payment", title: "Record a payment", labels: ["Record payment"] }));
    setDrift(loaded.doc, "add-session", [{ expected: "Save session", seen: "Add session", at: "t1", source: "capture" }]);
    writeOutline(loaded);
    updateOutline(file, (l) => noteCard(l!, "add-session", 'No "Register again" button on this page'));
    const text = readFileSync(file, "utf8");
    for (const c of ["# Outline for the pilot. Keep cards short.", "# Staff tasks first.", "# renamed from new-session", "# not written yet"]) {
      expect(text).toContain(c);
    }
    const { outline } = parseOutline(text);
    expect(outline.cards.map((c) => c.id)).toEqual(["add-session", "record-payment"]);
    expect(outline.cards[0].notes).toEqual(['No "Register again" button on this page']);
    expect(outline.cards[0].drift?.map((d) => [d.expected, d.source])).toEqual([
      ["Save session", "capture"],
      ["Register again", "writer"],
    ]);
    expect(dir).toBeTruthy();
  });

  it("starts a new file with a header comment", () => {
    const { config } = project();
    const loaded = readOrCreateOutline(outlinePath(config));
    addCard(loaded.doc, card());
    writeOutline(loaded);
    const text = readFileSync(outlinePath(config), "utf8");
    expect(text).toMatch(/^# Outline cards/);
    expect(parseOutline(text).outline.cards[0].id).toBe("add-session");
  });
});

describe("recordCaptureDrift (the capture insertion)", () => {
  it("is a no-op when there's no outline file", () => {
    const { config } = project();
    expect(recordCaptureDrift({ config, walkthrough: wt(), manifest: manifest([step("open", ["Sessions"])]), validation: passed })).toBeNull();
    expect(existsSync(outlinePath(config))).toBe(false);
  });

  it("records drift, marks the card captured, then clears it once the label shows up", () => {
    const { config } = project();
    writeFileSync(outlinePath(config), COMMENTED);
    const now = new Date("2026-10-26T00:00:00Z");
    const line = recordCaptureDrift({
      config,
      walkthrough: wt(),
      manifest: manifest([step("open", ["Sessions"], ["Sessions"]), step("add", ["Add session"], ["Add session", "New session"])]),
      validation: passed,
      now,
    });
    expect(line).toBe('outline: add-session: 1 name on the card differs from the screen: "Save session" (saw "Add session" at step add)');
    let c = readOutline(outlinePath(config))!.outline.cards[0];
    expect(c.status).toBe("captured");
    expect(c.drift).toEqual([{ expected: "Save session", seen: "Add session", step: "add", at: now.toISOString(), source: "capture" }]);
    expect(readFileSync(outlinePath(config), "utf8")).toContain("# not written yet");

    const cleared = recordCaptureDrift({ config, walkthrough: wt(), manifest: manifest([step("add", ["Save session"])]), validation: passed });
    expect(cleared).toMatch(/matches the screen now \(1 difference cleared\)/);
    c = readOutline(outlinePath(config))!.outline.cards[0];
    expect(c.drift).toBeUndefined();
  });

  it("leaves the card alone when the capture failed, and never throws on a broken outline", () => {
    const { config } = project();
    writeFileSync(outlinePath(config), COMMENTED);
    const failed = { steps: [{ ...passed.steps[0] }, { ...passed.steps[1], ok: false }] };
    expect(recordCaptureDrift({ config, walkthrough: wt(), manifest: manifest([step("add", [])]), validation: failed })).toBeNull();
    expect(readFileSync(outlinePath(config), "utf8")).toBe(COMMENTED);
    writeFileSync(outlinePath(config), "cards:\n  - id: Bad Id\n    title: t\n");
    expect(recordCaptureDrift({ config, walkthrough: wt(), manifest: manifest([]), validation: passed })).toMatch(/^outline: not updated: /);
  });
});

describe("checkOutline", () => {
  it("uses the latest manifest on disk, falling back to the walkthrough's targets for an older manifest", () => {
    const { config } = project();
    writeFileSync(outlinePath(config), COMMENTED.replace("status: planned", "status: planned\n  - id: export-list\n    title: Export the list\n    status: planned"));
    writeFileSync(join(config.walkthroughsDir, "add-session.yaml"), WALKTHROUGH);
    const captureDir = join(config.buildDir, "add-session", "capture");
    mkdirSync(captureDir, { recursive: true });
    // An older manifest: no `targets`, so names come from the walkthrough's steps.
    writeFileSync(join(captureDir, "manifest.json"), JSON.stringify(manifest([step("open"), step("add")])));
    writeFileSync(join(captureDir, "validation.json"), JSON.stringify(passed));
    const result = checkOutline(config, []);
    expect(result.cards.map((c) => [c.id, c.status, c.state])).toEqual([
      ["add-session", "captured", "checked"],
      ["export-list", "planned", "not-written"],
    ]);
    // Only the walkthrough's own target strings as evidence: flagged, but no rename suggested.
    expect(result.cards[0].drift[0]).toEqual({ expected: "Save session", at: expect.any(String), source: "capture" });
    expect(() => checkOutline(config, ["nope"])).toThrow(/no card "nope"/);
  });

  it("returns nothing (and writes nothing) without an outline file", () => {
    const { config } = project();
    expect(checkOutline(config, [])).toMatchObject({ exists: false, cards: [] });
    expect(existsSync(outlinePath(config))).toBe(false);
  });
});
