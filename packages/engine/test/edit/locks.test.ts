import { afterEach, describe, expect, it } from "vitest";
import { setStepField } from "../../src/edit/steps.js";
import { lock, unlock, isLocked } from "../../src/edit/locks.js";
import { EditLockedError } from "../../src/edit/types.js";
import { cleanupTmpDirs, setupHelpApp } from "./helpers.js";

afterEach(() => {
  cleanupTmpDirs();
});

describe("lock/unlock", () => {
  it("blocks an agent edit to a locked step field, but allows a person edit", () => {
    const { helpRoot, walkthroughFile } = setupHelpApp();
    const item = "step:add-competitor-and-entry:check-show:say";

    lock(walkthroughFile, item, { by: "person" });
    expect(isLocked(helpRoot, item)).toBe(true);

    expect(() => setStepField(walkthroughFile, "check-show", "say", "Agent tries anyway.", { by: "agent" })).toThrow(
      EditLockedError,
    );

    // A person can still override the lock directly.
    setStepField(walkthroughFile, "check-show", "say", "Person overrides.", { by: "person" });

    unlock(walkthroughFile, item, { by: "person" });
    expect(isLocked(helpRoot, item)).toBe(false);

    // Now the agent can edit it again.
    setStepField(walkthroughFile, "check-show", "say", "Agent edit after unlock.", { by: "agent" });
  });

  it("locking a whole walkthrough blocks agent edits to any of its steps", () => {
    const { helpRoot, walkthroughFile } = setupHelpApp();
    lock(walkthroughFile, "walkthrough:add-competitor-and-entry", { by: "person" });
    expect(() => setStepField(walkthroughFile, "open-competitors", "caption", "x", { by: "agent" })).toThrow(
      EditLockedError,
    );
    expect(isLocked(helpRoot, "walkthrough:add-competitor-and-entry")).toBe(true);
  });
});
