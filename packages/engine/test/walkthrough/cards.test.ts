// The video's title cards when a walkthrough leaves intro/outro out.
import { describe, expect, it } from "vitest";
import { cardText } from "../../src/walkthrough/cards.js";
import type { Walkthrough } from "../../src/walkthrough/types.js";

const base: Walkthrough = {
  walkthrough: "add-an-order",
  version: 1,
  title: "Add an order",
  summary: "Record a new order for a customer.",
  steps: [
    { id: "a", title: "Open Orders", chapter: "Find it" },
    { id: "b", title: "Fill it in", chapter: "Save it" },
  ],
} as Walkthrough;

describe("cardText", () => {
  it("narrates the title and summary on a missing intro", () => {
    const c = cardText(base);
    expect(c.intro.say).toBe("Add an order. Record a new order for a customer.");
    expect(c.intro.caption).toBe("Record a new order for a customer.");
  });

  it("gives a missing outro a title, a line and the chapters as its recap", () => {
    const c = cardText(base);
    expect(c.outro.title).toBe("You're done");
    expect(c.outro.say).toBeTruthy();
    expect(c.outro.recap).toEqual(["Find it", "Save it"]);
  });

  it("falls back to step titles for the recap without chapters, at most four", () => {
    const steps = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, title: `Step ${i}` }));
    expect(cardText({ ...base, steps } as Walkthrough).outro.recap).toEqual(["Step 0", "Step 1", "Step 2", "Step 3"]);
  });

  it("keeps what the walkthrough sets, an explicit empty line included", () => {
    const c = cardText({ ...base, intro: { say: "Hi.", caption: "Hello" }, outro: { title: "Done", say: "", recap: [] } } as Walkthrough);
    expect(c.intro).toEqual({ say: "Hi.", caption: "Hello" });
    expect(c.outro).toMatchObject({ title: "Done", say: "", recap: [] });
  });
});

describe("stepChapters", () => {
  it("carries a chapter over steps that don't name one", async () => {
    const { stepChapters } = await import("../../src/render/timeline.js");
    const steps = [{ id: "a", chapter: "One" }, { id: "b" }, { id: "c", chapter: "Two" }, { id: "d" }];
    expect(stepChapters({ ...base, steps } as Walkthrough)).toEqual(["One", "One", "Two", "Two"]);
  });
});
