// M38: `press`, `hover`, `focus` and exact-text checks — schema, plain words, and the words a
// reader sees for them.
import { describe, expect, it } from "vitest";
import { ActionSchema, WalkthroughDocSchema, docToWalkthrough, describeAction, describeActions, keyWords, parseDoString, stepInstruction } from "../../src/walkthrough/index.js";
import { normaliseKey } from "../../src/walkthrough/parse-do.js";
import { textMatches } from "../../src/capture/text-check.js";

describe("plain words", () => {
  it("parses press, with and without a field", () => {
    expect(parseDoString('press "Enter"')).toEqual([{ do: "press", key: "Enter" }]);
    expect(parseDoString('press "Enter" in "Search"')).toEqual([{ do: "press", key: "Enter", target: { label: "Search" } }]);
    expect(parseDoString('press "Control+K"')).toEqual([{ do: "press", key: "Control+K" }]);
  });

  it("normalises key names, which Playwright reads case-sensitively", () => {
    expect(parseDoString('press "enter"')).toEqual([{ do: "press", key: "Enter" }]);
    expect(normaliseKey("ctrl+k")).toBe("Control+k");
    expect(normaliseKey("esc")).toBe("Escape");
    expect(normaliseKey("controlormeta+K")).toBe("ControlOrMeta+K");
    expect(normaliseKey("Shift++")).toBe("Shift++");
  });

  it("parses hover and focus", () => {
    expect(parseDoString('hover "Settings" button')).toEqual([{ do: "hover", target: { role: "button", name: "Settings" } }]);
    expect(parseDoString('focus "Email"')).toEqual([{ do: "focus", target: { label: "Email" } }]);
    expect(parseDoString('focus "Email" textbox')).toEqual([{ do: "focus", target: { role: "textbox", name: "Email" } }]);
  });

  it("parses an exact text check, in do: and check: forms", () => {
    expect(parseDoString('expect text exactly "Saved"')).toEqual([{ do: "expect", target: { text: "Saved", exact: true } }]);
    const wt = docToWalkthrough(
      WalkthroughDocSchema.parse({
        walkthrough: "save-a-note",
        title: "Save a note",
        start: { page: "/notes" },
        steps: [{ id: "save", do: 'press "Enter" in "Note"', check: 'text exactly "Saved" is visible' }],
      }),
    );
    expect(wt.steps[0].actions).toEqual([
      { do: "press", key: "Enter", target: { label: "Note" } },
      { do: "expect", target: { text: "Saved", exact: true } },
    ]);
  });

  it("names the new forms in the error for anything it can't read", () => {
    expect(() => parseDoString("tap the thing")).toThrow(/press\/hover\/focus/);
  });
});

describe("schema", () => {
  it("accepts press with or without a target, hover, focus and expect with text", () => {
    for (const a of [
      { do: "press", key: "Escape" },
      { do: "press", key: "Enter", target: { label: "Search" }, highlight: true },
      { do: "hover", target: { role: "button", name: "Settings" } },
      { do: "focus", target: { label: "Email" } },
      { do: "expect", target: { role: "status" }, text: "Saved" },
      { do: "expect", target: { role: "status" }, text: "Saved", exact: true },
    ]) {
      expect(ActionSchema.safeParse(a).success, JSON.stringify(a)).toBe(true);
    }
  });

  it("rejects a press without a key, a key with spaces, hover without a target, and exact without text", () => {
    expect(ActionSchema.safeParse({ do: "press" }).success).toBe(false);
    expect(ActionSchema.safeParse({ do: "press", key: "Control K" }).success).toBe(false);
    expect(ActionSchema.safeParse({ do: "hover" }).success).toBe(false);
    const r = ActionSchema.safeParse({ do: "expect", target: { role: "status" }, exact: true });
    expect(r.success).toBe(false);
    expect(r.success ? "" : r.error.issues[0].message).toMatch(/needs `text`/);
  });
});

describe("words for readers", () => {
  it("prints keys the way a keyboard does", () => {
    expect(keyWords("Enter")).toBe("Enter");
    expect(keyWords("Control+k")).toBe("Ctrl+K");
    expect(keyWords("Escape")).toBe("Esc");
    expect(keyWords("Shift+Tab")).toBe("Shift+Tab");
    expect(keyWords("ArrowDown")).toBe("Down arrow");
    expect(keyWords("ControlOrMeta+K")).toBe("Ctrl+K (Cmd+K on a Mac)");
  });

  it("describes each new action as one instruction", () => {
    expect(describeAction({ do: "press", key: "Enter" })).toBe("Press **Enter**.");
    expect(describeAction({ do: "press", key: "Enter", target: { label: "Search" } })).toBe("In **Search**, press **Enter**.");
    expect(describeAction({ do: "hover", target: { role: "button", name: "Settings" } })).toBe("Hover over **Settings**.");
    expect(describeAction({ do: "focus", target: { label: "Email" } })).toBe("Go to the **Email** field.");
    expect(describeAction({ do: "expect", target: { role: "status", name: "Result" }, text: "Saved", exact: true })).toBe(
      'Check that **Result** shows exactly "Saved".',
    );
    expect(describeAction({ do: "waitForUrl", pattern: "x" })).toBeUndefined();
  });

  it("gives a step with no page_text or caption words from its actions, with data filled in", () => {
    const step = {
      actions: [
        { do: "type" as const, target: { label: "Search" }, text: "{{q}}" },
        { do: "press" as const, key: "Enter", target: { label: "Search" } },
        { do: "waitFor" as const, target: { text: "{{q}}" } },
        { do: "hover" as const, target: { role: "row", name: "{{customer}}" } },
      ],
    };
    expect(describeActions(step.actions)).toBe("Fill in **Search**. In **Search**, press **Enter**. Hover over **{{customer}}**.");
    expect(stepInstruction(step, { customer: "Acme" })).toBe("Fill in **Search**. In **Search**, press **Enter**. Hover over **Acme**.");
    expect(stepInstruction({ ...step, page_text: "Type the order number and press **Enter**." })).toBe("Type the order number and press **Enter**.");
  });
});

describe("M38 review fixes", () => {
  it("normalises key names at load and rejects ones Playwright can't press", () => {
    const parse = (key: string) => ActionSchema.safeParse({ do: "press", key });
    expect(parse("ctrl+k")).toMatchObject({ success: true, data: { key: "Control+k" } });
    expect(parse("Cmd+K")).toMatchObject({ success: true, data: { key: "Meta+K" } });
    expect(parse("esc")).toMatchObject({ success: true, data: { key: "Escape" } });
    expect(parse("F2").success).toBe(true);
    expect(parse("Shift++").success).toBe(true);
    const typo = parse("Entr");
    expect(typo.success).toBe(false);
    expect(typo.success ? "" : typo.error.issues[0].message).toMatch(/"Entr" isn't a key name/);
    expect(parse("Hyper+K").success).toBe(false);
    expect(() => parseDoString('press "Entr"')).toThrow(/isn't a key name/);
  });

  it("checks /patterns/ in an expect's text when the walkthrough loads", () => {
    const parse = (text: string) => ActionSchema.safeParse({ do: "expect", target: { role: "status" }, text });
    const message = (text: string) => {
      const r = parse(text);
      return r.success ? "" : r.error.issues[0].message;
    };
    expect(message("/[/")).toMatch(/isn't a valid regular expression/);
    expect(message("//")).toMatch(/empty pattern/);
    expect(message("/saved/g")).toMatch(/only "i"/);
    expect(message("/(a+)+$/")).toMatch(/can hang/);
    expect(message(`/${"a".repeat(201)}/`)).toMatch(/longer than 200/);
    expect(parse("/saved/i").success).toBe(true);
    expect(parse("/ORD-\\d+/").success).toBe(true);
    expect(textMatches("Saved", "/saved/i", true)).toBe(true);
  });

  it("words focus by what it lands on, and never prints a pattern, a highlight or broken bold", () => {
    expect(describeAction({ do: "focus", target: { role: "button", name: "Settings" } })).toBe("Move to **Settings**.");
    expect(describeAction({ do: "focus", target: { role: "textbox", name: "Notes" } })).toBe("Go to the **Notes** field.");
    expect(describeAction({ do: "hover", target: { css: ".menu > li" } })).toBe("Hover over the item.");
    expect(describeAction({ do: "hover", target: { role: "menu" } })).toBe("Hover over the menu.");
    expect(describeAction({ do: "expect", target: { role: "status" }, text: "/ORD-\\d+/" })).toBe("Check that the status shows the expected text.");
    expect(describeAction({ do: "click", target: { role: "row", name: "/ORD-1001/" } })).toBe("Select the row.");
    expect(describeAction({ do: "click", target: { role: "button", name: "Save *draft*" } })).toBe('Select "Save *draft*".');
    expect(describeAction({ do: "press", key: "*" })).toBe('Press "*".');
    expect(describeAction({ do: "hover", target: { role: "row", name: "{{customer}}" } }, { customer: "Acme_Co" })).toBe('Hover over "Acme_Co".');
  });
});

describe("text matching (toHaveText / toContainText)", () => {
  it("contains by default, equals with exact, both after collapsing whitespace", () => {
    expect(textMatches("  1 order\n found ", "1 order found", true)).toBe(true);
    expect(textMatches("1 order found today", "1 order found", true)).toBe(false);
    expect(textMatches("1 order found today", "order found", false)).toBe(true);
    expect(textMatches("Saved", "saved", false)).toBe(false);
  });

  it("reads /regex/ as a pattern: searched, or matched whole with exact", () => {
    expect(textMatches("Order ORD-1001", "/ORD-\\d+/", false)).toBe(true);
    expect(textMatches("Order ORD-1001", "/ORD-\\d+/", true)).toBe(false);
    expect(textMatches("ORD-1001", "/ORD-\\d+/", true)).toBe(true);
  });
});
