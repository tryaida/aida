import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  addBlur,
  addCallout,
  removeBlur,
  removeCallout,
  reorderCallouts,
  updateBlur,
  updateCallout,
} from "../../src/edit/callouts.js";
import { undo } from "../../src/edit/history.js";
import { EditLockedError, EditValidationError } from "../../src/edit/types.js";
import { lock } from "../../src/edit/locks.js";
import { loadWalkthroughFile } from "../../src/walkthrough/loader.js";
import { cleanupTmpDirs, setupHelpApp } from "./helpers.js";

afterEach(() => {
  cleanupTmpDirs();
});

describe("addCallout / updateCallout / removeCallout", () => {
  it("adds a box-pinned callout, preserving comments/formatting elsewhere", () => {
    const { walkthroughFile } = setupHelpApp();
    const before = readFileSync(walkthroughFile, "utf8");

    const result = addCallout(
      walkthroughFile,
      "check-show",
      { id: "c1", box: { x: 10, y: 20, w: 30, h: 40 }, label: "Click here" },
      { by: "person" },
    );
    expect(result.after.id).toBe("c1");

    const wt = loadWalkthroughFile(walkthroughFile);
    const step = wt.steps.find((s) => s.id === "check-show")!;
    expect(step.callouts).toHaveLength(1);
    expect(step.callouts![0]).toMatchObject({ id: "c1", box: { x: 10, y: 20, w: 30, h: 40 }, label: "Click here" });

    // Unrelated content untouched.
    const after = readFileSync(walkthroughFile, "utf8");
    const routesLine = before.split("\n").find((l) => l.includes("/dashboard/competitors"));
    expect(after.split("\n")).toContain(routesLine);
  });

  it("rejects adding a target+box callout (exactly one is allowed)", () => {
    const { walkthroughFile } = setupHelpApp();
    expect(() =>
      addCallout(walkthroughFile, "check-show", {
        id: "c1",
        box: { x: 0, y: 0, w: 1, h: 1 },
        target: { role: "button" },
      } as never),
    ).toThrow(EditValidationError);
  });

  it("rejects a duplicate callout id", () => {
    const { walkthroughFile } = setupHelpApp();
    addCallout(walkthroughFile, "check-show", { id: "c1", box: { x: 0, y: 0, w: 1, h: 1 } });
    expect(() => addCallout(walkthroughFile, "check-show", { id: "c1", box: { x: 1, y: 1, w: 1, h: 1 } })).toThrow(
      /already exists/,
    );
  });

  it("updateCallout patches label without disturbing the box", () => {
    const { walkthroughFile } = setupHelpApp();
    addCallout(walkthroughFile, "check-show", { id: "c1", box: { x: 10, y: 20, w: 30, h: 40 } });
    updateCallout(walkthroughFile, "check-show", "c1", { label: "New label" });

    const wt = loadWalkthroughFile(walkthroughFile);
    const callout = wt.steps.find((s) => s.id === "check-show")!.callouts![0];
    expect(callout.label).toBe("New label");
    expect(callout.box).toEqual({ x: 10, y: 20, w: 30, h: 40 });
  });

  it("updateCallout re-pinning from box to target clears the box", () => {
    const { walkthroughFile } = setupHelpApp();
    addCallout(walkthroughFile, "check-show", { id: "c1", box: { x: 10, y: 20, w: 30, h: 40 } });
    updateCallout(walkthroughFile, "check-show", "c1", { target: { role: "button", name: "Save" } });

    const wt = loadWalkthroughFile(walkthroughFile);
    const callout = wt.steps.find((s) => s.id === "check-show")!.callouts![0];
    expect(callout.target).toEqual({ role: "button", name: "Save" });
    expect(callout.box).toBeUndefined();
  });

  it("removeCallout removes it, and undo restores it", () => {
    const { helpRoot, walkthroughFile } = setupHelpApp();
    addCallout(walkthroughFile, "check-show", { id: "c1", box: { x: 10, y: 20, w: 30, h: 40 } }, { by: "person" });
    removeCallout(walkthroughFile, "check-show", "c1", { by: "person" });

    let wt = loadWalkthroughFile(walkthroughFile);
    expect(wt.steps.find((s) => s.id === "check-show")!.callouts ?? []).toHaveLength(0);

    undo(helpRoot, "person");
    wt = loadWalkthroughFile(walkthroughFile);
    expect(wt.steps.find((s) => s.id === "check-show")!.callouts).toHaveLength(1);
  });

  it("reorderCallouts changes numbering order", () => {
    const { walkthroughFile } = setupHelpApp();
    addCallout(walkthroughFile, "check-show", { id: "a", box: { x: 0, y: 0, w: 1, h: 1 } });
    addCallout(walkthroughFile, "check-show", { id: "b", box: { x: 1, y: 1, w: 1, h: 1 } });

    reorderCallouts(walkthroughFile, "check-show", ["b", "a"]);
    const wt = loadWalkthroughFile(walkthroughFile);
    expect(wt.steps.find((s) => s.id === "check-show")!.callouts!.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("an agent edit is rejected on a locked step, a person edit is allowed", () => {
    const { walkthroughFile } = setupHelpApp();
    lock(walkthroughFile, "step:add-competitor-and-entry:check-show");

    expect(() => addCallout(walkthroughFile, "check-show", { id: "c1", box: { x: 0, y: 0, w: 1, h: 1 } }, { by: "agent" })).toThrow(
      EditLockedError,
    );
    expect(() =>
      addCallout(walkthroughFile, "check-show", { id: "c1", box: { x: 0, y: 0, w: 1, h: 1 } }, { by: "person" }),
    ).not.toThrow();
  });
});

describe("addBlur / updateBlur / removeBlur", () => {
  it("adds, updates and removes a blur box", () => {
    const { walkthroughFile } = setupHelpApp();
    addBlur(walkthroughFile, "check-show", { id: "b1", box: { x: 5, y: 5, w: 50, h: 20 } }, { by: "person" });

    let wt = loadWalkthroughFile(walkthroughFile);
    expect(wt.steps.find((s) => s.id === "check-show")!.blur).toHaveLength(1);

    updateBlur(walkthroughFile, "check-show", "b1", { box: { x: 6, y: 6, w: 50, h: 20 } });
    wt = loadWalkthroughFile(walkthroughFile);
    expect(wt.steps.find((s) => s.id === "check-show")!.blur![0].box).toEqual({ x: 6, y: 6, w: 50, h: 20 });

    removeBlur(walkthroughFile, "check-show", "b1", { by: "person" });
    wt = loadWalkthroughFile(walkthroughFile);
    expect(wt.steps.find((s) => s.id === "check-show")!.blur ?? []).toHaveLength(0);
  });

  it("rejects a blur box with neither target nor box", () => {
    const { walkthroughFile } = setupHelpApp();
    expect(() => addBlur(walkthroughFile, "check-show", { id: "b1" } as never)).toThrow(EditValidationError);
  });
});
