import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CaptureManifest, ManifestStep, ValidationResult } from "../../src/capture/types.js";
import type { Walkthrough } from "../../src/walkthrough/index.js";
import { buildTours, tourIds, TOUR_VERSION } from "../../src/tours/index.js";
import type { Tour } from "../../src/tours/index.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "aida-tours-"));
  dirs.push(d);
  return d;
}

const wf: Walkthrough = {
  walkthrough: "add-a-thing",
  title: "Add a thing for {{org}}",
  section: "Things",
  start: { page: "/things" },
  data: { org: "Acme", thing: { name: "Acme widget" }, login: { pin: "4321" }, person: { email: "jo@example.com" } },
  steps: [
    { id: "open", title: "Open the form", page_text: "Select **New thing**.", actions: [{ do: "click", target: { role: "link", name: "New thing" } }] },
    {
      id: "fill",
      title: "Fill it in",
      mask: ["Email"],
      actions: [
        { do: "type", target: { label: "Name" }, text: "{{thing.name}} {{run.id}}" },
        { do: "type", target: { label: "Email" }, text: "{{person.email}}" },
        { do: "type", target: { label: "PIN" }, text: "{{login.pin}}" },
        { do: "select", target: { label: "Colour" }, option: "Blue" },
        { do: "click", target: { role: "button", name: "Create" } },
        { do: "waitFor", target: { role: "heading", name: "Created" } },
      ],
    },
    { id: "menu", title: "Open the menu", devices: ["phone"], actions: [{ do: "click", target: { role: "button", name: "Menu" } }] },
    { id: "check", title: "Check it", actions: [{ do: "expect", target: { role: "heading", name: "Created" } }] },
  ],
};

function mStep(stepIndex: number, tour?: ManifestStep["tour"]): ManifestStep {
  return {
    id: wf.steps[stepIndex]!.id,
    stepIndex,
    camera: "full",
    cameraBox: null,
    events: [],
    doc: { image: null, highlights: [] },
    impact: { urls: [], requests: [] },
    checks: [],
    ...(tour ? { tour } : {}),
  };
}

const steps: ManifestStep[] = [
  mStep(0, { path: "/things", actions: [{ action: 0, path: "/things", target: { tag: "a", role: "link", name: "New thing", href: "/things/new" } }] }),
  mStep(1, {
    path: "/things/new",
    actions: [
      { action: 0, path: "/things/new", target: { tag: "input", role: "textbox", name: "Name", label: "Name", id: "thing-name" } },
      { action: 1, path: "/things/new", target: { tag: "input", role: "textbox", name: "Email", label: "Email" } },
      { action: 2, path: "/things/new", target: { tag: "input", role: "textbox", name: "PIN", label: "PIN" } },
      { action: 3, path: "/things/new", target: { tag: "select", role: "combobox", name: "Colour", label: "Colour" } },
      { action: 4, path: "/things/new", target: { tag: "button", role: "button", name: "Create" } },
    ],
  }),
  // step 2 is phone-only: absent from the desktop capture
  mStep(3, { path: "/things/9f8e7d6c5b4a39281706" }),
];

function writeCapture(dir: string, opts: { manifest?: Partial<CaptureManifest>; ok?: boolean } = {}): string {
  mkdirSync(dir, { recursive: true });
  const manifest: CaptureManifest = { workflow: wf.walkthrough, baseUrl: "http://localhost:3000", viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, device: "desktop", steps, ...opts.manifest };
  const validation: ValidationResult = {
    workflow: wf.walkthrough,
    ranAt: "2026-01-01T00:00:00.000Z",
    baseUrl: "http://localhost:3000",
    ok: opts.ok ?? true,
    steps: manifest.steps.map((s) => ({ id: s.id, title: undefined, checks: [], ok: true, ms: 1 })),
    dbChecks: [],
    problems: { console: [], page: [], server: [] },
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "validation.json"), JSON.stringify(validation));
  return dir;
}

function readTour(publicDir: string, id: string): Tour {
  return JSON.parse(readFileSync(join(publicDir, "tours", `${id}.json`), "utf8")) as Tour;
}

/** A capture of `w` from hand-written manifest steps (`stepIndex` = position). */
function captureOf(dir: string, w: Walkthrough, mSteps: Partial<ManifestStep>[]): string {
  const full = mSteps.map((m, i) => ({ ...mStep(0), id: w.steps[i]!.id, stepIndex: i, ...m }));
  return writeCapture(dir, { manifest: { workflow: w.walkthrough, steps: full } });
}

function buildOne(w: Walkthrough, mSteps: Partial<ManifestStep>[], opts: { knownRoutes?: string[]; basePath?: string } = {}): { tour?: Tour; skipped: { id: string; reason: string }[] } {
  const root = tmp();
  const publicDir = join(root, "public");
  const result = buildTours({ sources: [{ wf: w, captureDir: captureOf(join(root, "capture"), w, mSteps) }], publicDir, ...opts });
  return { tour: result.written.includes(w.walkthrough) ? readTour(publicDir, w.walkthrough) : undefined, skipped: result.skipped };
}


describe("buildTours", () => {
  it("writes a small, versioned tour from a passing capture's hints", () => {
    const root = tmp();
    const publicDir = join(root, "public");
    const captureDir = writeCapture(join(root, "capture"));
    const result = buildTours({ sources: [{ wf, captureDir }], publicDir, knownRoutes: ["/things/new", "/things/[id]"] });
    expect(result).toEqual({ written: ["add-a-thing"], skipped: [], ids: ["add-a-thing"] });

    const tour = readTour(publicDir, "add-a-thing");
    expect(tour).toMatchObject({
      version: TOUR_VERSION,
      id: "add-a-thing",
      title: "Add a thing for Acme",
      guideUrl: expect.stringMatching(/^\/.*add-a-thing$/),
      start: { path: "/things", pattern: "/things" },
    });
    expect(tour.steps.map((s) => s.id)).toEqual(["open", "fill", "check"]); // the phone-only step is left out
    expect(tour.steps[0]).toEqual({
      id: "open",
      title: "Open the form",
      text: "Select New thing.",
      screen: "/things",
      actions: [{ kind: "click", target: { tag: "a", role: "link", name: "New thing", href: "/things/new" }, advance: "click" }],
    });
    // knownRoutes: the literal "/things/new" route beats "/things/[id]".
    expect(tour.steps[1]!.screen).toBe("/things/new");
    const fill = tour.steps[1]!.actions;
    expect(fill.map((a) => [a.kind, a.advance])).toEqual([
      ["type", "change"],
      ["type", "change"],
      ["type", "change"],
      ["select", "change"],
      ["click", "click"],
    ]);
    // Demo values are examples: `{{data}}` resolved, `{{run.*}}` dropped; none for a masked or
    // secret-looking field.
    expect(fill[0]!.example).toBe("Acme widget");
    expect(fill[1]!.example).toBeUndefined();
    expect(fill[2]!.example).toBeUndefined();
    expect(fill[3]!.example).toBe("Blue");
    // A checks-only step is read-and-continue; its screen is a pattern with the record id as `*`.
    expect(tour.steps[2]).toMatchObject({ id: "check", actions: [], screen: "/things/*" });
    expect(readFileSync(join(publicDir, "tours", "add-a-thing.json"), "utf8").length).toBeLessThan(2500);
  });

  it("skips, with a reason, a capture that failed or predates tours, and prunes its old tour", () => {
    const root = tmp();
    const publicDir = join(root, "public");
    const good = writeCapture(join(root, "capture"));
    buildTours({ sources: [{ wf, captureDir: good }], publicDir });
    expect(existsSync(join(publicDir, "tours", "add-a-thing.json"))).toBe(true);

    const failed = writeCapture(join(root, "failed"), { ok: false });
    const r1 = buildTours({ sources: [{ wf, captureDir: failed }], publicDir });
    expect(r1).toEqual({ written: [], skipped: [{ id: "add-a-thing", reason: "no passing capture" }], ids: [] });

    const old = writeCapture(join(root, "old"), { manifest: { steps: steps.map(({ tour: _t, ...s }) => s) } });
    const r2 = buildTours({ sources: [{ wf, captureDir: old }], publicDir });
    expect(r2.skipped).toEqual([{ id: "add-a-thing", reason: "captured before tours existed: capture it again" }]);

    const readOnly: Walkthrough = { ...wf, walkthrough: "see-things", steps: [wf.steps[3]!] };
    const ro = writeCapture(join(root, "ro"), { manifest: { workflow: "see-things", steps: [{ ...mStep(3, { path: "/things" }), stepIndex: 0 }] } });
    const r3 = buildTours({ sources: [{ wf: readOnly, captureDir: ro }], publicDir });
    expect(r3.skipped).toEqual([{ id: "see-things", reason: "no step has an element to point at" }]);
  });

  it("removes tours for walkthroughs no longer publishable or deleted, and keeps the rest", () => {
    const root = tmp();
    const publicDir = join(root, "public");
    mkdirSync(join(publicDir, "tours"), { recursive: true });
    for (const id of ["kept", "unpublished", "deleted"]) writeFileSync(join(publicDir, "tours", `${id}.json`), "{}");
    const captureDir = writeCapture(join(root, "capture"));
    const result = buildTours({
      sources: [{ wf, captureDir }],
      publicDir,
      attemptedIds: ["add-a-thing", "unpublished"],
      validIds: ["add-a-thing", "unpublished", "kept"],
    });
    expect(result.written).toEqual(["add-a-thing"]);
    expect(result.skipped).toEqual([{ id: "unpublished", reason: "not publishable" }]);
    expect(result.ids).toEqual(["add-a-thing", "kept"]);
    expect(tourIds(publicDir)).toEqual(["add-a-thing", "kept"]);
  });

  it("gives a start path with a record id no link-worthy pattern, and refuses ids tour.js would", () => {
    const root = tmp();
    const publicDir = join(root, "public");
    const captureDir = writeCapture(join(root, "capture"));
    buildTours({ sources: [{ wf: { ...wf, start: { page: "/things/42/edit" } }, captureDir }], publicDir });
    expect(readTour(publicDir, "add-a-thing").start).toEqual({ path: "/things/42/edit", pattern: "/things/*/edit" });

    const bad = buildTours({ sources: [{ wf: { ...wf, walkthrough: "Bad_Id" }, captureDir }], publicDir });
    expect(bad.skipped[0]!.reason).toMatch(/isn't lower-case/);
  });
});

describe("buildTours: blur per screen, as the video applies it", () => {
  const people: Walkthrough = {
    walkthrough: "tidy-people",
    title: "Tidy people",
    start: { page: "/people" },
    steps: [
      { id: "show", title: "Show them", blur: [{ id: "names", target: { css: ".names" } }], actions: [{ do: "click", target: { role: "button", name: "Show" } }] },
      {
        id: "tidy",
        title: "Tidy up",
        actions: [
          { do: "click", target: { role: "link", name: "Account" } },
          { do: "click", target: { role: "button", name: "Delete", within: { role: "row", name: "Jane" } } },
          { do: "click", target: { role: "button", name: "Archive" } },
          { do: "click", target: { role: "button", name: "Done" } },
        ],
      },
    ],
  };
  const showStep: Partial<ManifestStep> = {
    doc: { image: null, highlights: [], blur: [{ id: "names", box: { x: 0, y: 100, w: 400, h: 40 } }] },
    tour: { path: "/people", scroll: { x: 0, y: 0 }, actions: [{ action: 0, path: "/people", target: { tag: "button", role: "button", name: "Show" }, at: { boxes: [{ x: 500, y: 10, w: 60, h: 30 }] } }] },
  };
  // The second step blurs nothing itself: only the first step's box, on the same screen, hides
  // these words in the video.
  const tidyStep = (link: { x: number; y: number }): Partial<ManifestStep> => ({
    tour: {
      path: "/people",
      scroll: { x: 0, y: 0 },
      actions: [
        { action: 0, path: "/people", target: { tag: "a", role: "link", name: "Account 7731", testId: "account-link" }, at: { boxes: [{ ...link, w: 100, h: 20 }] } },
        {
          action: 1,
          path: "/people",
          target: { tag: "button", role: "button", name: "Delete", within: { tag: "tr", role: "row", name: "Jane Realperson Delete" } },
          at: { boxes: [{ x: 450, y: 300, w: 60, h: 24 }], within: [{ x: 0, y: 105, w: 600, h: 30 }] },
        },
        // No position recorded (an older manifest): on a screen with blur, its words go.
        { action: 2, path: "/people", target: { tag: "button", role: "button", name: "Archive", id: "archive" } },
        { action: 3, path: "/people", target: { tag: "button", role: "button", name: "Done" }, at: { boxes: [{ x: 500, y: 600, w: 60, h: 24 }] } },
      ],
    },
  });

  it("takes out words another step's blur hides on the same screen", () => {
    const { tour } = buildOne(people, [showStep, tidyStep({ x: 10, y: 110 })]);
    const tidy = tour!.steps[1]!.actions.map((a) => a.target);
    expect(tidy).toEqual([
      { tag: "a", role: "link", testId: "account-link" },
      { tag: "button", role: "button", name: "Delete" },
      { tag: "button", role: "button", id: "archive" },
      { tag: "button", role: "button", name: "Done" },
    ]);
    const json = JSON.stringify(tour);
    expect(json).not.toContain("7731");
    expect(json).not.toContain("Realperson");
    // What capture kept for the build never reaches the tour file.
    expect(json).not.toMatch(/"at"|"masked"|"scroll"|"boxes"/);
  });

  it("keeps words clear of the blur, and blurs a band on a screen that scrolls", () => {
    const clear = buildOne(people, [showStep, tidyStep({ x: 10, y: 400 })]).tour!;
    expect(clear.steps[1]!.actions[0]!.target).toEqual({ tag: "a", role: "link", name: "Account 7731", testId: "account-link" });
    // The same screen scrolled while filming: the box becomes a full-height band at its x.
    const scrolled = buildOne(people, [{ ...showStep, events: [{ type: "scrollFrames", images: [] }] }, tidyStep({ x: 10, y: 400 })]).tour!;
    expect(scrolled.steps[1]!.actions[0]!.target).toEqual({ tag: "a", role: "link", testId: "account-link" });
    expect(scrolled.steps[1]!.actions[3]!.target.name).toBe("Done");
  });
});

describe("buildTours: examples for masked fields", () => {
  const signUp: Walkthrough = {
    walkthrough: "sign-up",
    title: "Sign up",
    start: { page: "/join" },
    data: { me: { email: "jo@example.com", name: "Jo Bloggs", phone: "0491 570 006" } },
    steps: [
      {
        id: "fill",
        title: "Fill it in",
        mask: ["Email", "Phone"],
        actions: [
          // Reached by placeholder, not by the label the mask names.
          { do: "type", target: { placeholder: "you@work" }, text: "{{me.email}}" },
          { do: "type", target: { label: "Name" }, text: "{{me.name}}" },
          { do: "type", target: { css: "#tel" }, text: "{{me.phone}}" },
          { do: "type", target: { css: "#nick" }, text: "Jo" },
        ],
      },
      {
        id: "more",
        title: "More",
        actions: [
          { do: "type", target: { label: "Team" }, text: "Acme" },
          { do: "type", target: { label: "Code" }, text: "Blue" },
        ],
      },
    ],
  };
  const mSteps: Partial<ManifestStep>[] = [
    {
      tour: {
        path: "/join",
        actions: [
          { action: 0, path: "/join", target: { tag: "input", role: "textbox", name: "Email", label: "Email", type: "email" } },
          { action: 1, path: "/join", target: { tag: "input", role: "textbox", name: "Name", label: "Name" } },
          { action: 2, path: "/join", target: { tag: "input", role: "textbox", name: "Phone number", label: "Phone number" } },
          // Nothing to compare a mask against: in doubt, no example.
          { action: 3, path: "/join", target: { tag: "input", role: "textbox", nameAttr: "nick" } },
        ],
      },
    },
    {
      tour: {
        path: "/join",
        actions: [
          { action: 0, path: "/join", target: { tag: "input", role: "textbox", name: "Team", label: "Team" } },
          // Capture saw masking hide something of it (a config mask selector).
          { action: 1, path: "/join", target: { tag: "input", role: "textbox", name: "Code", label: "Code" }, masked: true },
        ],
      },
    },
  ];

  it("shows no example for a field a mask names, however the action reaches it, or when in doubt", () => {
    const { tour } = buildOne(signUp, mSteps);
    expect(tour!.steps[0]!.actions.map((a) => a.example)).toEqual([undefined, "Jo Bloggs", undefined, undefined]);
    expect(tour!.steps[1]!.actions.map((a) => a.example)).toEqual(["Acme", undefined]);
  });
});

describe("buildTours: record ids, demo values and screens", () => {
  const customers: Walkthrough = {
    walkthrough: "open-customer",
    title: "Open a customer",
    start: { page: "/teams/acme-co/customers" },
    data: { org: "Acme Co", customer: { name: "Jane Smith" } },
    steps: [
      { id: "open", title: "Open her", actions: [{ do: "click", target: { role: "link", name: "{{customer.name}}" } }] },
      { id: "edit", title: "Edit", actions: [{ do: "click", target: { role: "button", name: "Edit" } }] },
    ],
  };
  const mSteps: Partial<ManifestStep>[] = [
    {
      tour: {
        path: "/teams/acme-co/customers",
        actions: [
          {
            action: 0,
            path: "/teams/acme-co/customers",
            target: { tag: "a", role: "link", name: "Jane Smith", id: "customer-jane-smith", testId: "open-jane-smith", href: "/teams/acme-co/customers/jane-smith" },
          },
        ],
      },
    },
    { tour: { path: "/teams/acme-co/customers/jane-smith", actions: [{ action: 0, path: "/teams/acme-co/customers/jane-smith", target: { tag: "button", role: "button", name: "Edit", testId: "edit" } }] } },
  ];

  it("drops ids holding a demo value and stores links and screens as patterns", () => {
    const { tour } = buildOne(customers, mSteps);
    expect(tour!.steps[0]!.actions[0]!.target).toEqual({ tag: "a", role: "link", name: "Jane Smith", href: "/teams/*/customers/*" });
    expect(tour!.steps.map((s) => s.screen)).toEqual(["/teams/*/customers", "/teams/*/customers/*"]);
    expect(tour!.start).toEqual({ path: "/teams/acme-co/customers", pattern: "/teams/*/customers" });
    expect(tour!.steps[1]!.actions[0]!.target.testId).toBe("edit");
  });

  it("uses the app's own routes when known", () => {
    const { tour } = buildOne(customers, mSteps, { knownRoutes: ["/teams/[team]/customers", "/teams/[team]/customers/[slug]"] });
    expect(tour!.steps[0]!.actions[0]!.target.href).toBe("/teams/*/customers/*");
  });
});

describe("buildTours: base path", () => {
  const things: Walkthrough = {
    walkthrough: "add-thing",
    title: "Add a thing",
    start: { page: "/things" },
    steps: [
      { id: "open", title: "Open the form", actions: [{ do: "click", target: { role: "link", name: "New thing" } }] },
      { id: "save", title: "Save", actions: [{ do: "click", target: { role: "button", name: "Save" } }] },
    ],
  };
  const under = (prefix: string): Partial<ManifestStep>[] => [
    { tour: { path: `${prefix}/things`, actions: [{ action: 0, path: `${prefix}/things`, target: { tag: "a", role: "link", name: "New thing", href: `${prefix}/things/new` } }] } },
    { tour: { path: `${prefix}/things/new`, actions: [{ action: 0, path: `${prefix}/things/new`, target: { tag: "button", role: "button", name: "Save" } }] } },
  ];

  it("makes every screen, link and the start relative to the base path", () => {
    const { tour } = buildOne(things, under("/app"), { basePath: "/app/" });
    expect(tour!.start).toEqual({ path: "/things", pattern: "/things" });
    expect(tour!.steps.map((s) => s.screen)).toEqual(["/things", "/things/new"]);
    expect(tour!.steps[0]!.actions[0]!.target.href).toBe("/things/new");
  });

  it("changes nothing without one, and skips a walkthrough that leaves it", () => {
    expect(buildOne(things, under("")).tour!.steps.map((s) => s.screen)).toEqual(["/things", "/things/new"]);
    const out = buildOne(things, [under("/app")[0]!, under("/elsewhere")[1]!], { basePath: "/app" });
    expect(out.tour).toBeUndefined();
    expect(out.skipped[0]!.reason).toMatch(/outside the app's base path/);
  });
});
