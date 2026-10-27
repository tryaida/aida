import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { setData } from "../../src/edit/data.js";
import { EditValidationError } from "../../src/edit/types.js";
import { loadWalkthroughFile } from "../../src/walkthrough/loader.js";
import { lock, readHistory } from "../../src/edit/index.js";
import { cleanupTmpDirs, setupHelpApp } from "./helpers.js";

afterEach(() => {
  cleanupTmpDirs();
});

describe("setData", () => {
  it("sets a dotted-path value, parsed as a YAML scalar, and preserves everything else", () => {
    const { walkthroughFile } = setupHelpApp();
    const before = readFileSync(walkthroughFile, "utf8");

    const result = setData(walkthroughFile, "competitor.firstName", "Priya", { by: "person" });

    expect(result.before).toBe("Sophie");
    expect(result.after).toBe("Priya");
    const after = readFileSync(walkthroughFile, "utf8");
    expect(after).toContain("firstName: Priya");

    // Untouched content (other data keys, steps) stays byte-identical.
    const beforeLines = before.split("\n");
    const afterLines = after.split("\n");
    const lastNameLine = beforeLines.find((l) => l.includes("lastName: Harrington"));
    expect(lastNameLine).toBeTruthy();
    expect(afterLines).toContain(lastNameLine);

    const wt = loadWalkthroughFile(walkthroughFile);
    expect((wt.data as { competitor: { firstName: string } }).competitor.firstName).toBe("Priya");
  });

  it("parses numbers/booleans as their real type, not a string", () => {
    const { walkthroughFile } = setupHelpApp();
    setData(walkthroughFile, "entry.count", "3", { by: "agent" });
    const wt = loadWalkthroughFile(walkthroughFile);
    expect((wt.data as { entry: { count: number } }).entry.count).toBe(3);
  });

  it("creates intermediate keys that don't exist yet", () => {
    const { walkthroughFile } = setupHelpApp();
    setData(walkthroughFile, "newThing.nested.value", "hello", { by: "agent" });
    const wt = loadWalkthroughFile(walkthroughFile);
    expect((wt.data as Record<string, unknown>).newThing).toEqual({ nested: { value: "hello" } });
  });

  it("rejects an edit that would leave a {{...}} reference elsewhere unresolved, and doesn't write", () => {
    const { walkthroughFile } = setupHelpApp();
    const before = readFileSync(walkthroughFile, "utf8");

    // `competitor.email` is referenced by `{{competitor.email}}` in several steps' mask/targets
    // — renaming the key out from under those references must be rejected, not just renaming
    // the value.
    expect(() => setData(walkthroughFile, "competitor", "null", { by: "agent" })).toThrow(EditValidationError);
    expect(() => setData(walkthroughFile, "competitor", "null", { by: "agent" })).toThrow(/unresolved template/);

    expect(readFileSync(walkthroughFile, "utf8")).toBe(before);
  });

  it("rejects a value that isn't valid YAML, and doesn't write", () => {
    const { walkthroughFile } = setupHelpApp();
    const before = readFileSync(walkthroughFile, "utf8");
    expect(() => setData(walkthroughFile, "competitor.firstName", "{unterminated", { by: "agent" })).toThrow(
      EditValidationError,
    );
    expect(readFileSync(walkthroughFile, "utf8")).toBe(before);
  });

  it("rejects an agent edit to a locked walkthrough", () => {
    const { walkthroughFile } = setupHelpApp();
    lock(walkthroughFile, "walkthrough:add-competitor-and-entry");
    expect(() => setData(walkthroughFile, "competitor.firstName", "Priya", { by: "agent" })).toThrow(/locked/);
  });

  it("records a history entry that undo can revert", () => {
    const { walkthroughFile, helpRoot } = setupHelpApp();
    setData(walkthroughFile, "competitor.firstName", "Priya", { by: "agent" });
    const history = readHistory(helpRoot);
    expect(history.at(-1)).toMatchObject({
      action: "setData",
      target: "add-competitor-and-entry#data.competitor.firstName",
      before: "Sophie",
      after: "Priya",
    });
  });
});
