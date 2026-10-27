import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEditCommand } from "../../src/commands/edit.js";
import { loadWalkthroughFile } from "../../src/walkthrough/loader.js";
import { cleanupTmpDirs, setupHelpApp } from "./helpers.js";

afterEach(() => {
  cleanupTmpDirs();
});

describe("runEditCommand insertStep", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("parses --after/--id/--do/--say flags and inserts the step", () => {
    const { walkthroughFile } = setupHelpApp();

    const code = runEditCommand(
      "insertStep",
      [
        walkthroughFile,
        "--after",
        "open-competitors",
        "--id",
        "confirm-page",
        "--do",
        'click "Add New Competitor" button',
        "--say",
        "Click it.",
      ],
      { by: "agent", json: true },
    );

    expect(code).toBe(0);
    const wt = loadWalkthroughFile(walkthroughFile);
    const ids = wt.steps.map((s) => s.id);
    expect(ids).toContain("confirm-page");
    expect(ids.indexOf("confirm-page")).toBe(ids.indexOf("open-competitors") + 1);
  });

  it("parses --at-start as a boolean flag with no value", () => {
    const { walkthroughFile } = setupHelpApp();

    const code = runEditCommand(
      "insertStep",
      [walkthroughFile, "--at-start", "--id", "very-first", "--do", 'click "X" button'],
      { by: "agent", json: true },
    );

    expect(code).toBe(0);
    const wt = loadWalkthroughFile(walkthroughFile);
    expect(wt.steps[0].id).toBe("very-first");
  });

  it("fails cleanly (exit 1, no throw) on an unknown flag", () => {
    const { walkthroughFile } = setupHelpApp();
    const code = runEditCommand(
      "insertStep",
      [walkthroughFile, "--after", "open-competitors", "--id", "x", "--bogus", "y"],
      { by: "agent", json: true },
    );
    expect(code).toBe(1);
    const payload = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/unknown flag/);
  });

  it("fails cleanly when --id is missing", () => {
    const { walkthroughFile } = setupHelpApp();
    const code = runEditCommand("insertStep", [walkthroughFile, "--after", "open-competitors"], {
      by: "agent",
      json: true,
    });
    expect(code).toBe(1);
    const payload = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(payload.error).toMatch(/--id/);
  });

  it("parses --title/--chapter and --camera full", () => {
    const { walkthroughFile } = setupHelpApp();
    const code = runEditCommand(
      "insertStep",
      [
        walkthroughFile,
        "--after",
        "open-competitors",
        "--id",
        "with-extras",
        "--do",
        'click "Add New Competitor" button',
        "--title",
        "Open the form",
        "--chapter",
        "Add the competitor",
        "--camera",
        "full",
      ],
      { by: "agent", json: true },
    );
    expect(code).toBe(0);
    const wt = loadWalkthroughFile(walkthroughFile);
    const step = wt.steps.find((s) => s.id === "with-extras");
    expect(step?.title).toBe("Open the form");
    expect(step?.chapter).toBe("Add the competitor");
    expect(step?.camera).toBe("full");
  });

  it("parses --camera as a bare target JSON, wrapping it as { focus }", () => {
    const { walkthroughFile } = setupHelpApp();
    const code = runEditCommand(
      "insertStep",
      [
        walkthroughFile,
        "--after",
        "open-competitors",
        "--id",
        "with-camera-focus",
        "--do",
        'click "Add New Competitor" button',
        "--camera",
        '{"role":"button","name":"Add New Competitor"}',
      ],
      { by: "agent", json: true },
    );
    expect(code).toBe(0);
    const wt = loadWalkthroughFile(walkthroughFile);
    const step = wt.steps.find((s) => s.id === "with-camera-focus");
    expect(step?.camera).toEqual({ focus: { role: "button", name: "Add New Competitor" } });
  });

  it("fails cleanly on an invalid --camera value", () => {
    const { walkthroughFile } = setupHelpApp();
    const code = runEditCommand(
      "insertStep",
      [walkthroughFile, "--after", "open-competitors", "--id", "x", "--camera", "not json"],
      { by: "agent", json: true },
    );
    expect(code).toBe(1);
    const payload = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/--camera/);
  });
});

describe("runEditCommand setData", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("sets a dotted-path data value", () => {
    const { walkthroughFile } = setupHelpApp();
    const code = runEditCommand("setData", [walkthroughFile, "competitor.firstName", "Priya"], {
      by: "agent",
      json: true,
    });
    expect(code).toBe(0);
    const wt = loadWalkthroughFile(walkthroughFile);
    expect((wt.data as { competitor: { firstName: string } }).competitor.firstName).toBe("Priya");
  });

  it("fails cleanly (exit 1) when the edit would leave a template unresolved", () => {
    const { walkthroughFile } = setupHelpApp();
    const code = runEditCommand("setData", [walkthroughFile, "competitor", "null"], { by: "agent", json: true });
    expect(code).toBe(1);
    const payload = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(payload.ok).toBe(false);
    expect(payload.invalid).toBe(true);
  });
});

describe("runEditCommand addCallout/addBlur (CLI parity for the Studio's callout/blur actions)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("addCallout via CLI JSON args round-trips through the walkthrough file", () => {
    const { walkthroughFile } = setupHelpApp();
    const code = runEditCommand(
      "addCallout",
      [walkthroughFile, "check-show", JSON.stringify({ id: "c1", box: { x: 1, y: 2, w: 3, h: 4 }, label: "Here" })],
      { by: "agent", json: true },
    );
    expect(code).toBe(0);
    const wt = loadWalkthroughFile(walkthroughFile);
    expect(wt.steps.find((s) => s.id === "check-show")!.callouts).toEqual([
      { id: "c1", box: { x: 1, y: 2, w: 3, h: 4 }, label: "Here" },
    ]);
  });

  it("addBlur, then removeBlur via CLI", () => {
    const { walkthroughFile } = setupHelpApp();
    runEditCommand("addBlur", [walkthroughFile, "check-show", JSON.stringify({ id: "b1", box: { x: 0, y: 0, w: 5, h: 5 } })], {
      by: "agent",
      json: true,
    });
    let wt = loadWalkthroughFile(walkthroughFile);
    expect(wt.steps.find((s) => s.id === "check-show")!.blur).toHaveLength(1);

    const code = runEditCommand("removeBlur", [walkthroughFile, "check-show", "b1"], { by: "agent", json: true });
    expect(code).toBe(0);
    wt = loadWalkthroughFile(walkthroughFile);
    expect(wt.steps.find((s) => s.id === "check-show")!.blur ?? []).toHaveLength(0);
  });

  it("fails cleanly (exit 1) on malformed callout JSON", () => {
    const { walkthroughFile } = setupHelpApp();
    const code = runEditCommand("addCallout", [walkthroughFile, "check-show", "{not json"], { by: "agent", json: true });
    expect(code).toBe(1);
    const payload = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(payload.ok).toBe(false);
  });
});
