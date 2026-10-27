import { describe, expect, it } from "vitest";
import { citedNumbers, parseBlocks } from "../../components/chat/markdown";

describe("chat markdown", () => {
  it("splits paragraphs and lists", () => {
    expect(parseBlocks("Open **Competitors** [1].\n\n1. Click **Add**\n2. Save\n\n- a\n- b")).toEqual([
      { kind: "p", lines: ["Open **Competitors** [1]."] },
      { kind: "ol", items: ["Click **Add**", "Save"] },
      { kind: "ul", items: ["a", "b"] },
    ]);
  });

  it("joins an indented continuation line onto its list item", () => {
    expect(parseBlocks("1. Click Add\n   then Save")).toEqual([{ kind: "ol", items: ["Click Add then Save"] }]);
  });

  it("finds the citation numbers an answer uses", () => {
    expect([...citedNumbers("Do this [1]. Then that [3] [1].")]).toEqual([1, 3]);
  });
});
