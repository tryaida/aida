import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../../src/config/types.js";
import type { Walkthrough } from "../../src/walkthrough/index.js";
import type { CaptureRunResult } from "../../src/capture/runner.js";
import { runCapture } from "../../src/capture/runner.js";
import { startFixtureServer, type FixtureServer } from "./fixture-server.js";

// M46: capture records a small description of each action's element for in-app tours. One
// walkthrough covers every kind of target, a masked field, personal data on screen, a config
// mask selector reaching a hint by every route, generated and record ids; it runs twice to prove
// the manifest stays identical.
const TIMEOUT = 120_000;
const dirs: string[] = [];
let server: FixtureServer;
let first: CaptureRunResult;
let second: CaptureRunResult;

const walkthrough: Walkthrough = {
  walkthrough: "tour-hints",
  title: "Tour hints",
  start: { page: "/tour-hints.html" },
  data: { person: { email: "ada@example.com" } },
  steps: [
    { id: "role", actions: [{ do: "click", target: { role: "button", name: "Save" } }] },
    {
      id: "masked-label",
      mask: ["Email"],
      actions: [
        { do: "click", target: { label: "Email" } },
        { do: "type", target: { label: "Email" }, text: "{{person.email}}" },
      ],
    },
    { id: "placeholder", actions: [{ do: "click", target: { placeholder: "Search things" } }] },
    { id: "text", actions: [{ do: "click", target: { text: "Archived items" } }] },
    { id: "css", actions: [{ do: "click", target: { css: "[data-kind=chip]" } }] },
    { id: "within", actions: [{ do: "click", target: { role: "button", name: "Delete", within: { role: "row", name: "Widget B" } } }] },
    { id: "personal", actions: [{ do: "click", target: { text: "Contact sophie.harrington@gmail.com" } }] },
    { id: "mask-selector", actions: [{ do: "click", target: { role: "button", name: "Reveal Acme account" } }] },
    { id: "select", actions: [{ do: "select", target: { label: "Colour" }, option: "Blue" }] },
    { id: "link", actions: [{ do: "point", target: { role: "link", name: "Next page" } }, { do: "expect", target: { text: "Things" } }] },
    { id: "masked-row", actions: [{ do: "click", target: { role: "button", name: "Remove", nth: 0 } }] },
    { id: "masked-link", actions: [{ do: "point", target: { role: "link", name: "Jane Realperson" } }] },
    { id: "masked-nick", actions: [{ do: "click", target: { label: "Jane's nickname" } }] },
    { id: "masked-ref", actions: [{ do: "click", target: { role: "button", name: "Account 7731" } }] },
    { id: "record-ids", actions: [{ do: "click", target: { role: "button", name: "Discard" } }] },
    { id: "mask-by-label", mask: ["Phone"], actions: [{ do: "type", target: { placeholder: "Your phone" }, text: "0491 570 006" }] },
  ],
};

function config(baseUrl: string): ResolvedConfig {
  return {
    app: { baseUrl },
    configDir: tmpdir(),
    walkthroughsDir: tmpdir(),
    outDir: tmpdir(),
    buildDir: tmpdir(),
    viewport: { width: 1024, height: 768 },
    deviceScaleFactor: 1,
    mask: { selectors: [".secret-zone"] },
  };
}

function outDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-tour-hints-"));
  dirs.push(dir);
  return dir;
}

beforeAll(async () => {
  server = await startFixtureServer();
  first = await runCapture({ walkthrough, config: config(server.url), outDir: outDir() });
  second = await runCapture({ walkthrough, config: config(server.url), outDir: outDir() });
}, TIMEOUT * 2);

afterAll(async () => {
  await server?.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function hintsOf(stepId: string, action = 0) {
  const step = first.manifest.steps.find((s) => s.id === stepId);
  return step?.tour?.actions?.find((a) => a.action === action);
}

describe("tour hints in the capture manifest", () => {
  it("passes, and every step records the screen it ran on", () => {
    expect(first.validation.ok).toBe(true);
    for (const step of first.manifest.steps) expect(step.tour?.path).toBe("/tour-hints.html");
  });

  it("describes a role + name target with its test id and stable id, and where it was", () => {
    expect(hintsOf("role")).toMatchObject({
      action: 0,
      path: "/tour-hints.html",
      target: { tag: "button", role: "button", name: "Save", testId: "save", id: "save-btn", type: "button" },
      at: { boxes: [{ x: expect.any(Number), y: expect.any(Number), w: expect.any(Number), h: expect.any(Number) }], scroll: { x: 0, y: expect.any(Number) } },
    });
    expect(hintsOf("role")!.masked).toBeUndefined();
    // The label is where a field's words come from: its box is kept too.
    expect(hintsOf("select")!.at!.boxes).toHaveLength(2);
  });

  it("keeps a masked field's label but nothing shown inside it", () => {
    for (const action of [0, 1]) {
      const h = hintsOf("masked-label", action)!;
      expect(h.target).toMatchObject({ tag: "input", role: "textbox", name: "Email", label: "Email", id: "email", nameAttr: "email", type: "text" });
      expect(h.target.placeholder).toBeUndefined();
    }
  });

  it("describes placeholder, text, css and select targets", () => {
    expect(hintsOf("placeholder")!.target).toEqual({ tag: "input", role: "searchbox", name: "Search things", placeholder: "Search things", type: "search" });
    expect(hintsOf("text")!.target).toEqual({ tag: "span", name: "Archived items" });
    // `:r1:` is a generated id: left out.
    expect(hintsOf("css")!.target).toEqual({ tag: "div", role: "button", name: "Blue chip" });
    expect(hintsOf("select")!.target).toEqual({ tag: "select", role: "combobox", name: "Colour", label: "Colour", id: "colour", nameAttr: "colour" });
  });

  it("records the nearest named container for a `within` target", () => {
    expect(hintsOf("within")!.target).toEqual({
      tag: "button",
      role: "button",
      name: "Delete",
      type: "button",
      within: { tag: "tr", role: "row", name: "Widget B Delete" },
    });
  });

  it("records a link's pathname without its query", () => {
    expect(hintsOf("link")!.target).toEqual({ tag: "a", role: "link", name: "Next page", href: "/success.html" });
    // The expect that follows has no element to act on: nothing recorded for it.
    expect(hintsOf("link", 1)).toBeUndefined();
  });

  it("leaves out personal data and anything a config mask selector hides", () => {
    expect(hintsOf("personal")!.target).toEqual({ tag: "button", role: "button", id: "contact", type: "button" });
    expect(hintsOf("mask-selector")!.target).toEqual({ tag: "button", role: "button", id: "reveal", type: "button" });
    // (`targets`/`checks` hold the walkthrough's own words; the hints come from the page.)
    const json = JSON.stringify(first.manifest.steps.map((s) => s.tour));
    expect(json).not.toContain("gmail");
    expect(json).not.toContain("Reveal");
  });

  it("keeps no word a config mask selector hides, by any route: inside, a container, a label, a reference", () => {
    // The row's masked cell: its name would be "Jane Realperson Remove". The row goes; the button stays.
    expect(hintsOf("masked-row")!.target).toEqual({ tag: "button", role: "button", name: "Remove", type: "button" });
    expect(hintsOf("masked-row")!.masked).toBeUndefined();
    // The link's only words are masked, and its path names a record: nothing identifying is left.
    expect(hintsOf("masked-link")).toBeUndefined();
    expect(hintsOf("masked-nick")!.target).toEqual({ tag: "input", role: "textbox", id: "nick", nameAttr: "nick", type: "text" });
    expect(hintsOf("masked-ref")!.target).toEqual({ tag: "button", role: "button", id: "acct", type: "button" });
    expect(hintsOf("masked-ref")!.masked).toBe(true);
    const json = JSON.stringify(first.manifest.steps.map((s) => s.tour));
    expect(json).not.toContain("Realperson");
    expect(json).not.toContain("7731");
    expect(json).not.toContain("nickname");
  });

  it("keeps no id, test id or name attribute that names a record", () => {
    expect(hintsOf("record-ids")!.target).toEqual({ tag: "button", role: "button", name: "Discard", type: "button" });
  });

  it("treats a field as masked when the step's mask names its label, however the action found it", () => {
    const h = hintsOf("mask-by-label")!;
    expect(h.masked).toBe(true);
    expect(h.target).toEqual({ tag: "input", role: "textbox", name: "Phone", label: "Phone", id: "tel", nameAttr: "tel", type: "text" });
  });

  it("records the same hints on a second run", () => {
    // Only the hints: how many typing frames a run films depends on the clock (capture.maxTypeMs).
    expect(JSON.stringify(second.manifest.steps.map((s) => s.tour))).toBe(JSON.stringify(first.manifest.steps.map((s) => s.tour)));
  });

  it("records nothing when the run records nothing", async () => {
    const r = await runCapture({ walkthrough: { ...walkthrough, steps: walkthrough.steps.slice(0, 1) }, config: config(server.url), outDir: outDir(), record: false });
    expect(r.manifest.steps[0]?.tour).toBeUndefined();
  }, TIMEOUT);
});
