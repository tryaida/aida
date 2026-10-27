import { afterEach, describe, expect, it } from "vitest";
import { setStepField } from "../../src/edit/steps.js";
import { readHistory, undo } from "../../src/edit/history.js";
import { loadWalkthroughFile } from "../../src/walkthrough/loader.js";
import { cleanupTmpDirs, setupHelpApp } from "./helpers.js";

afterEach(() => {
  cleanupTmpDirs();
});

describe("history + undo", () => {
  it("records each edit with at/by/action/target/before/after", () => {
    const { helpRoot, walkthroughFile } = setupHelpApp();
    setStepField(walkthroughFile, "check-show", "say", "New line.", { by: "agent" });

    const entries = readHistory(helpRoot);
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry.by).toBe("agent");
    expect(entry.action).toBe("setStepField");
    expect(entry.after).toBe("New line.");
    expect(typeof entry.at).toBe("string");
    expect(entry.target).toContain("check-show.say");
  });

  it("undo(lastBy: 'agent') reverts only the agent's last edit, leaving a later person edit alone", () => {
    const { helpRoot, walkthroughFile } = setupHelpApp();

    const originalSay = loadWalkthroughFile(walkthroughFile).steps.find((s) => s.id === "check-show")!.say;
    const originalCaption = loadWalkthroughFile(walkthroughFile).steps.find((s) => s.id === "open-competitors")!.caption;

    setStepField(walkthroughFile, "check-show", "say", "Agent's edit.", { by: "agent" });
    setStepField(walkthroughFile, "open-competitors", "caption", "Person's edit.", { by: "person" });

    const { reverted } = undo(helpRoot, "agent");
    expect(reverted.action).toBe("setStepField");
    expect(reverted.by).toBe("agent");

    const wt = loadWalkthroughFile(walkthroughFile);
    expect(wt.steps.find((s) => s.id === "check-show")!.say).toBe(originalSay);
    // The person's later edit is untouched.
    expect(wt.steps.find((s) => s.id === "open-competitors")!.caption).toBe("Person's edit.");
    expect(wt.steps.find((s) => s.id === "open-competitors")!.caption).not.toBe(originalCaption);
  });

  it("undo() with no filter reverts the last edit regardless of author", () => {
    const { helpRoot, walkthroughFile } = setupHelpApp();
    setStepField(walkthroughFile, "check-show", "say", "First.", { by: "person" });
    setStepField(walkthroughFile, "check-show", "say", "Second.", { by: "agent" });

    undo(helpRoot);

    const wt = loadWalkthroughFile(walkthroughFile);
    expect(wt.steps.find((s) => s.id === "check-show")!.say).toBe("First.");
  });

  it("throws when there's nothing to undo", () => {
    const { helpRoot } = setupHelpApp();
    expect(() => undo(helpRoot)).toThrow(/nothing to undo|no edit/);
  });

  it("a revert does not append its own history entry — only the single undo:<action> entry", () => {
    const { helpRoot, walkthroughFile } = setupHelpApp();
    setStepField(walkthroughFile, "check-show", "say", "Edit.", { by: "agent" });
    expect(readHistory(helpRoot)).toHaveLength(1);

    undo(helpRoot);
    const entries = readHistory(helpRoot);
    expect(entries).toHaveLength(2); // the original edit + exactly one undo entry, not three
    expect(entries[1].action).toBe("undo:setStepField");
  });

  it("two consecutive undos revert two edits", () => {
    const { helpRoot, walkthroughFile } = setupHelpApp();
    const originalSay = loadWalkthroughFile(walkthroughFile).steps.find((s) => s.id === "check-show")!.say;

    setStepField(walkthroughFile, "check-show", "say", "First edit.", { by: "agent" });
    setStepField(walkthroughFile, "check-show", "say", "Second edit.", { by: "agent" });

    undo(helpRoot);
    expect(loadWalkthroughFile(walkthroughFile).steps.find((s) => s.id === "check-show")!.say).toBe("First edit.");

    undo(helpRoot);
    expect(loadWalkthroughFile(walkthroughFile).steps.find((s) => s.id === "check-show")!.say).toBe(originalSay);

    // Nothing left to undo — both real edits were reverted, not re-reverted.
    expect(() => undo(helpRoot)).toThrow(/nothing to undo|no edit/);
  });

  it("undo --by agent never redoes a previously-undone edit (no double-entry, can't be re-targeted)", () => {
    const { helpRoot, walkthroughFile } = setupHelpApp();
    const originalSay = loadWalkthroughFile(walkthroughFile).steps.find((s) => s.id === "check-show")!.say;

    setStepField(walkthroughFile, "check-show", "say", "Agent's edit.", { by: "agent" });
    undo(helpRoot, "agent");
    expect(loadWalkthroughFile(walkthroughFile).steps.find((s) => s.id === "check-show")!.say).toBe(originalSay);

    // Before the fix, the revert's own write looked like a fresh "agent" edit, so a second
    // `undo --by agent` would find and revert it — redoing the change that was just undone.
    expect(() => undo(helpRoot, "agent")).toThrow(/nothing to undo|no edit/);
    expect(loadWalkthroughFile(walkthroughFile).steps.find((s) => s.id === "check-show")!.say).toBe(originalSay);
  });

  it("undo --by agent never touches person edits", () => {
    const { helpRoot, walkthroughFile } = setupHelpApp();
    setStepField(walkthroughFile, "open-competitors", "caption", "Person's edit.", { by: "person" });

    expect(() => undo(helpRoot, "agent")).toThrow(/no edit by "agent"/);
    expect(loadWalkthroughFile(walkthroughFile).steps.find((s) => s.id === "open-competitors")!.caption).toBe(
      "Person's edit.",
    );
  });
});
