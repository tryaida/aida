// The demo's walkthroughs (assets/demo-app/walkthroughs): they load, pass the text checks the
// build runs, sit in the sections the help site shows, and their needs/leaves give a capture
// order that differs from file order (what the demo shows off).
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEMO_WALKTHROUGHS_DIR, SHOWCASE_WALKTHROUGH } from "../../src/demo/index.js";
import { loadWalkthroughFile } from "../../src/walkthrough/index.js";
import { libraryPlacement } from "../../src/walkthrough/placement.js";
import { checkWalkthroughText } from "../../src/qa/walkthrough-text.js";
import { planRunFromFiles } from "../../src/states/index.js";

const files = readdirSync(DEMO_WALKTHROUGHS_DIR)
  .filter((f) => f.endsWith(".yaml"))
  .sort()
  .map((f) => join(DEMO_WALKTHROUGHS_DIR, f));

describe("demo walkthroughs", () => {
  it("are three or four, and each loads and passes the build's text checks", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files.length).toBeLessThanOrEqual(4);
    for (const file of files) {
      const wf = loadWalkthroughFile(file);
      expect(checkWalkthroughText(wf, readFileSync(file, "utf8")), file).toEqual([]);
      expect(wf.steps.every((s) => s.say && s.caption && s.page_text && s.title), file).toBe(true);
    }
  });

  it("include the showcase walkthrough", () => {
    expect(files.map((f) => loadWalkthroughFile(f).walkthrough)).toContain(SHOWCASE_WALKTHROUGH);
  });

  it("use only fictional contact details", () => {
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const email of text.match(/[\w.+-]+@[\w.-]+/g) ?? []) expect(email.endsWith("@example.com"), email).toBe(true);
      for (const phone of text.match(/555-\d{4}/g) ?? []) expect(Number(phone.slice(4)), phone).toBeGreaterThanOrEqual(100);
      for (const phone of text.match(/555-\d{4}/g) ?? []) expect(Number(phone.slice(4)), phone).toBeLessThanOrEqual(199);
    }
  });

  it("sit in more than one part of the help site", () => {
    const categories = new Set(files.map((f) => libraryPlacement(loadWalkthroughFile(f).section, loadWalkthroughFile(f).walkthrough).category.slug));
    expect(categories.size).toBeGreaterThanOrEqual(3);
    const showcase = loadWalkthroughFile(join(DEMO_WALKTHROUGHS_DIR, `${SHOWCASE_WALKTHROUGH}.yaml`));
    expect(libraryPlacement(showcase.section, showcase.walkthrough).url).toBe("/how-do-i/repair-jobs/mark-a-repair-ready");
  });

  it("are captured in an order derived from needs/leaves, not file order", () => {
    const run = planRunFromFiles({ walkthroughsDir: DEMO_WALKTHROUGHS_DIR }, files, { reset: "database-checks" });
    expect(run.plan.problems).toEqual([]);
    const order = run.plan.walkthroughs.map((p) => p.id);
    const fileOrder = files.map((f) => loadWalkthroughFile(f).walkthrough);
    expect(order).not.toEqual(fileOrder);
    expect(order.indexOf("take-in-a-repair")).toBeLessThan(order.indexOf("mark-a-repair-ready"));
    const showcase = run.plan.walkthroughs.find((p) => p.id === SHOWCASE_WALKTHROUGH)!;
    expect(showcase.needs).toEqual([{ state: "new-repair-waiting", metBy: "walkthrough", providers: ["take-in-a-repair"] }]);
  });
});
