// M33: lock-aware, undoable edit actions for walkthrough `paths` (decision 34).
import { afterEach, describe, expect, it } from "vitest";
import {
  addBlur,
  addCallout,
  removeBlur,
  addPath,
  EditLockedError,
  EditValidationError,
  lock,
  readHistory,
  removePath,
  setPathField,
  setPathStepActions,
  setPathStepField,
  undo,
} from "../../src/edit/index.js";
import { runEditCommand } from "../../src/commands/edit.js";
import { loadWalkthroughFile } from "../../src/walkthrough/loader.js";
import { cleanupTmpDirs, setupHelpApp } from "./helpers.js";

afterEach(() => cleanupTmpDirs());

const fromCompetitors = {
  id: "from-competitors",
  title: "From the Competitors list",
  when: "Use this when you're already looking at the list.",
  start: { page: "/competitors" },
  steps: [{ id: "open-add-from-list", title: "Open the form", do: 'click "Add competitor" button' }],
  joins: "enter-name",
};

describe("path edit actions", () => {
  it("adds a path, validated against the whole walkthrough, and undoes it", () => {
    const { helpRoot, walkthroughFile } = setupHelpApp();
    const result = addPath(walkthroughFile, fromCompetitors);
    expect(result.target).toBe("add-competitor-and-entry#paths.from-competitors");
    expect(loadWalkthroughFile(walkthroughFile).paths?.map((p) => p.id)).toEqual(["from-competitors"]);
    expect(readHistory(helpRoot).at(-1)).toMatchObject({ action: "addPath", by: "agent" });

    undo(helpRoot);
    expect(loadWalkthroughFile(walkthroughFile).paths).toBeUndefined();
  });

  it("an empty joins makes a path run to its own end, only when its last step ends in a check; undo puts joins back", () => {
    const { helpRoot, walkthroughFile } = setupHelpApp();
    addPath(walkthroughFile, fromCompetitors);
    // Its only step clicks and checks nothing: it can't stand alone.
    expect(() => setPathField(walkthroughFile, "from-competitors", "joins", "")).toThrow(/runs to its own end: its last step needs a check/);
    setPathStepField(walkthroughFile, "from-competitors", "open-add-from-list", "check", 'text "Add competitor" is visible');
    setPathField(walkthroughFile, "from-competitors", "joins", "");
    expect(loadWalkthroughFile(walkthroughFile).paths![0].joins).toBeUndefined();
    undo(helpRoot);
    expect(loadWalkthroughFile(walkthroughFile).paths![0].joins).toBe("enter-name");
  });

  it("rejects a path whose joins isn't a main step, writing nothing", () => {
    const { walkthroughFile } = setupHelpApp();
    expect(() => addPath(walkthroughFile, { ...fromCompetitors, joins: "nope" })).toThrow(EditValidationError);
    expect(loadWalkthroughFile(walkthroughFile).paths).toBeUndefined();
  });

  it("sets path fields (page is start.page; an empty note removes it) and undoes them", () => {
    const { helpRoot, walkthroughFile } = setupHelpApp();
    addPath(walkthroughFile, fromCompetitors);
    setPathField(walkthroughFile, "from-competitors", "page", "/competitors/list");
    setPathField(walkthroughFile, "from-competitors", "note", "This way adds them to the current show too.");
    setPathField(walkthroughFile, "from-competitors", "joins", "enter-contact");
    let p = loadWalkthroughFile(walkthroughFile).paths![0];
    expect(p).toMatchObject({ start: { page: "/competitors/list" }, note: "This way adds them to the current show too.", joins: "enter-contact" });

    setPathField(walkthroughFile, "from-competitors", "note", "");
    expect(loadWalkthroughFile(walkthroughFile).paths![0].note).toBeUndefined();
    undo(helpRoot); // note back
    undo(helpRoot); // joins back
    p = loadWalkthroughFile(walkthroughFile).paths![0];
    expect(p.note).toBe("This way adds them to the current show too.");
    expect(p.joins).toBe("enter-name");
  });

  it("sets a path step's field and actions, and removes a path", () => {
    const { helpRoot, walkthroughFile } = setupHelpApp();
    addPath(walkthroughFile, fromCompetitors);
    setPathStepField(walkthroughFile, "from-competitors", "open-add-from-list", "say", "Open the add form from the list.");
    setPathStepActions(walkthroughFile, "from-competitors", "open-add-from-list", [{ do: "click", target: { role: "link", name: "New" } }]);
    const step = loadWalkthroughFile(walkthroughFile).paths![0].steps[0];
    expect(step.say).toBe("Open the add form from the list.");
    expect(step.actions).toEqual([{ do: "click", target: { role: "link", name: "New" } }]);

    removePath(walkthroughFile, "from-competitors");
    expect(loadWalkthroughFile(walkthroughFile).paths).toBeUndefined();
    undo(helpRoot);
    expect(loadWalkthroughFile(walkthroughFile).paths?.[0].id).toBe("from-competitors");
  });

  it("undo of a path step edit restores the whole step, do/check included", () => {
    const { helpRoot, walkthroughFile } = setupHelpApp();
    addPath(walkthroughFile, {
      ...fromCompetitors,
      steps: [{ id: "open-add-from-list", title: "Open the form", do: 'click "Add competitor" button', check: 'text "New competitor" is visible' }],
    });
    setPathStepActions(walkthroughFile, "from-competitors", "open-add-from-list", [{ do: "click", target: { role: "link", name: "New" } }]);
    undo(helpRoot);
    let step = loadWalkthroughFile(walkthroughFile).paths![0].steps[0];
    expect(step.actions).toEqual([
      { do: "click", target: { role: "button", name: "Add competitor" } },
      { do: "expect", target: { text: "New competitor" } },
    ]);

    setPathStepActions(walkthroughFile, "from-competitors", "open-add-from-list", [{ do: "click", target: { role: "link", name: "New" } }]);
    setPathStepField(walkthroughFile, "from-competitors", "open-add-from-list", "do", 'click "Create" button');
    undo(helpRoot); // the actions list comes back, not an empty one
    step = loadWalkthroughFile(walkthroughFile).paths![0].steps[0];
    expect(step.actions).toEqual([{ do: "click", target: { role: "link", name: "New" } }]);
  });

  it("adds callouts and blur to a path step (<pathId>/<stepId>), behind the path's locks", () => {
    const { helpRoot, walkthroughFile } = setupHelpApp();
    addPath(walkthroughFile, fromCompetitors);
    addBlur(walkthroughFile, "from-competitors/open-add-from-list", { id: "b1", box: { x: 1, y: 2, w: 3, h: 4 } });
    addCallout(walkthroughFile, "from-competitors/open-add-from-list", { id: "c1", target: { role: "button", name: "Add competitor" }, label: "Here" });
    let step = loadWalkthroughFile(walkthroughFile).paths![0].steps[0];
    expect(step.blur).toEqual([{ id: "b1", box: { x: 1, y: 2, w: 3, h: 4 } }]);
    expect(step.callouts?.[0].id).toBe("c1");
    undo(helpRoot);
    expect(loadWalkthroughFile(walkthroughFile).paths![0].steps[0].callouts ?? []).toEqual([]);

    lock(walkthroughFile, "path:add-competitor-and-entry:from-competitors:step:open-add-from-list", { by: "person" });
    expect(() => removeBlur(walkthroughFile, "from-competitors/open-add-from-list", "b1")).toThrow(EditLockedError);
    removeBlur(walkthroughFile, "from-competitors/open-add-from-list", "b1", { by: "person" });
    step = loadWalkthroughFile(walkthroughFile).paths![0].steps[0];
    expect(step.blur ?? []).toEqual([]);
    expect(() => addBlur(walkthroughFile, "from-competitors/nope", { id: "b2", box: { x: 1, y: 1, w: 1, h: 1 } })).toThrow(/no step with id "nope"/);
  });

  it("refuses agent edits to a locked path, allows a person", () => {
    const { walkthroughFile } = setupHelpApp();
    addPath(walkthroughFile, fromCompetitors);
    lock(walkthroughFile, "path:add-competitor-and-entry:from-competitors", { by: "person" });
    expect(() => setPathField(walkthroughFile, "from-competitors", "title", "X")).toThrow(EditLockedError);
    expect(() => setPathStepField(walkthroughFile, "from-competitors", "open-add-from-list", "title", "X")).toThrow(EditLockedError);
    expect(() => removePath(walkthroughFile, "from-competitors")).toThrow(EditLockedError);
    setPathField(walkthroughFile, "from-competitors", "title", "From the list", { by: "person" });
    expect(loadWalkthroughFile(walkthroughFile).paths![0].title).toBe("From the list");
  });

  it("runs through aida edit with --json", () => {
    const { walkthroughFile } = setupHelpApp();
    const logs: string[] = [];
    const orig = console.log;
    console.log = (s: string) => logs.push(s);
    try {
      expect(runEditCommand("addPath", [walkthroughFile, JSON.stringify(fromCompetitors)], { json: true })).toBe(0);
      expect(runEditCommand("setPathField", [walkthroughFile, "from-competitors", "when", "Use this from the list."], { json: true })).toBe(0);
      expect(runEditCommand("removePath", [walkthroughFile, "missing"], { json: true })).toBe(1);
    } finally {
      console.log = orig;
    }
    expect(JSON.parse(logs[1])).toMatchObject({ ok: true, action: "setPathField", after: "Use this from the list." });
    expect(JSON.parse(logs[2]).error).toMatch(/no path with id "missing"/);
  });
});
