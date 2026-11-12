import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cleanHints, ELEMENT_HINT_HELPERS, isStableId, looksRecordish, masksField, pathHint, underBlur } from "../../src/capture/hints.js";

const TOUR_JS = join(dirname(fileURLToPath(import.meta.url)), "../../../help-app/public/tour.js");

describe("tour.js carries capture's helpers unchanged", () => {
  it("has the same text between its markers as capture/hints.ts ELEMENT_HINT_HELPERS", () => {
    const src = readFileSync(TOUR_JS, "utf8");
    const m = /\/\* aida-hints:start \*\/\n([\s\S]*?)\n\s*\/\* aida-hints:end \*\//.exec(src);
    expect(m).not.toBeNull();
    const lines = (text: string) => text.split("\n").map((l) => l.trim());
    expect(lines(m![1]!)).toEqual(lines(ELEMENT_HINT_HELPERS.trimEnd()));
  });
});

describe("isStableId", () => {
  it("keeps hand-written ids and refuses generated ones", () => {
    for (const id of ["first-name", "save", "colour", "line1", "h1-title"]) expect(isStableId(id), id).toBe(true);
    for (const id of [":r1:", "«r2»", "radix-:r3:", "mui-12345", "headlessui-menu-button-7", "react-select-3-input", "item-1699999999", "cl9ebqhxk00003b600tymydho", "550e8400-e29b-41d4-a716-446655440000", ""]) {
      expect(isStableId(id), id).toBe(false);
    }
  });

  it("refuses an id naming a record: a number set off by a separator, or a long one", () => {
    for (const id of ["delete-42", "row-7", "order-981", "row_7", "step-2", "field_10", "order981", "item-a1b2c3d4e5"]) expect(isStableId(id), id).toBe(false);
  });
});

describe("looksRecordish", () => {
  it("catches record numbers in test ids and name attributes too", () => {
    for (const v of ["row-delete-42", "order:981", "items[3]", "items[3][qty]", "42-delete", "user_7_email", "invite-aB3dE5gH7jK9mN1pQ3rS"]) expect(looksRecordish(v), v).toBe(true);
    for (const v of ["save", "delete-row", "email", "line1", "colour"]) expect(looksRecordish(v), v).toBe(false);
  });
});

describe("masksField", () => {
  it("matches a step mask against any name the field goes by, loosely", () => {
    expect(masksField(["Email"], "Email")).toBe(true);
    expect(masksField(["Email"], undefined, "email *")).toBe(true);
    expect(masksField(["Email"], "Work email (required)")).toBe(true);
    expect(masksField(["Phone"], "Email")).toBe(false);
    expect(masksField(undefined, "Email")).toBe(false);
  });
});

describe("underBlur", () => {
  const blur = [{ x: 0, y: 100, w: 300, h: 40 }];
  it("tests where the element was and, after a scroll, where it was by then", () => {
    expect(underBlur([{ x: 10, y: 110, w: 50, h: 20 }], blur)).toBe(true);
    expect(underBlur([{ x: 10, y: 300, w: 50, h: 20 }], blur)).toBe(false);
    // At y 300 with the page at 0; the boxes were resolved with the page scrolled 190 down.
    expect(underBlur([{ x: 10, y: 300, w: 50, h: 20 }], blur, { x: 0, y: 0 }, { x: 0, y: 190 })).toBe(true);
    expect(underBlur([], blur)).toBe(false);
  });
});

describe("pathHint", () => {
  it("turns record ids, tokens and run values into `*` and drops the query", () => {
    expect(pathHint("/things/42/edit?tab=1")).toBe("/things/*/edit");
    expect(pathHint("/invite/aB3dE5gH7jK9mN1pQ3rS")).toBe("/invite/*");
    expect(pathHint("/shows/summer-show-r7x2", "r7x2")).toBe("/shows/*");
    expect(pathHint("/people/jo.bloggs@gmail.com")).toBe("/people/*");
    expect(pathHint("/")).toBe("/");
  });
});

describe("cleanHints", () => {
  const raw = { tag: "button", role: "button", name: "Save", text: "Save", testId: "save", id: ":r1:", type: "submit" };

  it("keeps what identifies the element, in a fixed order, without generated ids or repeated text", () => {
    expect(cleanHints(raw)).toEqual({ tag: "button", role: "button", name: "Save", testId: "save", type: "submit" });
  });

  it("drops a value redaction would change, or one holding the run id, rather than rewriting it", () => {
    expect(cleanHints({ tag: "button", role: "button", name: "Email jo@gmail.com", id: "contact" })).toEqual({ tag: "button", role: "button", id: "contact" });
    expect(cleanHints({ tag: "td", name: "Order 4111 1111 1111 1111" })).toBeUndefined();
    expect(cleanHints({ tag: "button", name: "Batch r9z8", text: "Batch r9z8 now", id: "batch" }, { runId: "r9z8" })).toEqual({ tag: "button", id: "batch" });
  });

  it("keeps no record id, test id or name attribute", () => {
    expect(cleanHints({ tag: "button", role: "button", name: "Delete", id: "delete-42", testId: "row-delete-42" })).toEqual({ tag: "button", role: "button", name: "Delete" });
    expect(cleanHints({ tag: "input", role: "spinbutton", label: "Quantity", nameAttr: "items[3][qty]" })).toEqual({ tag: "input", role: "spinbutton", label: "Quantity" });
    // An id redaction would change goes too.
    expect(cleanHints({ tag: "button", name: "Go", id: "jo@gmail.com" })).toEqual({ tag: "button", name: "Go" });
  });

  it("drops a masked container's name, and a hidden container's", () => {
    const raw = { tag: "button", role: "button", name: "Delete", within: { tag: "tr", role: "row", name: "Jane Realperson Delete", masked: true } };
    expect(cleanHints(raw)).toEqual({ tag: "button", role: "button", name: "Delete" });
    expect(cleanHints({ ...raw, within: { ...raw.within, masked: false } }, { withinHidden: true })).toEqual({ tag: "button", role: "button", name: "Delete" });
    expect(cleanHints({ ...raw, within: { ...raw.within, masked: false } })?.within).toEqual({ tag: "tr", role: "row", name: "Jane Realperson Delete" });
  });

  it("keeps only the label of a masked field, and only structure for a hidden element", () => {
    const field = { tag: "input", role: "textbox", name: "Email", label: "Email", placeholder: "jo@example.com", nameAttr: "email", type: "email" };
    expect(cleanHints(field, { maskedField: true })).toEqual({ tag: "input", role: "textbox", name: "Email", label: "Email", nameAttr: "email", type: "email" });
    expect(cleanHints(field, { hidden: true })).toEqual({ tag: "input", role: "textbox", nameAttr: "email", type: "email" });
    expect(cleanHints({ tag: "button", name: "Reveal", masked: true })).toBeUndefined();
  });

  it("caps long text as a prefix and keeps a container", () => {
    const long = "A".repeat(200);
    const h = cleanHints({ tag: "button", role: "button", name: "Delete", within: { tag: "tr", role: "row", name: long } });
    expect(h?.within).toEqual({ tag: "tr", role: "row", name: "A".repeat(80) });
  });

  it("gives a link's href as a path pattern", () => {
    expect(cleanHints({ tag: "a", role: "link", name: "Open", href: "/things/123" })).toEqual({ tag: "a", role: "link", name: "Open", href: "/things/*" });
  });
});
