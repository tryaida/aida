import { describe, expect, it } from "vitest";
import {
  annotateDuplicates,
  annotateFieldHints,
  capLines,
  capSelectOptions,
  formatSnapshot,
  markRequired,
  normalizeName,
  redactLines,
} from "../../src/inspect/format.js";

describe("capSelectOptions", () => {
  it("leaves a short option list untouched", () => {
    const lines = [
      '- combobox "Class":',
      '  - option "A"',
      '  - option "B"',
      '- button "Create"',
    ];
    expect(capSelectOptions(lines, 15)).toEqual(lines);
  });

  it("caps a long option list to N + a '+more' line", () => {
    const options = Array.from({ length: 18 }, (_, i) => `  - option "Opt${i + 1}"`);
    const lines = ['- combobox "Class":', ...options, '- button "Create"'];

    const out = capSelectOptions(lines, 15);

    const optionLines = out.filter((l) => /- option "/.test(l));
    expect(optionLines).toHaveLength(15);
    expect(out).toContain('  - … (+3 more)');
    expect(out[out.length - 1]).toBe('- button "Create"');
  });

  it("caps each combobox/listbox block independently", () => {
    const lines = [
      '- combobox "A":',
      ...Array.from({ length: 20 }, (_, i) => `  - option "a${i}"`),
      '- combobox "B":',
      '  - option "b1"',
      '  - option "b2"',
    ];
    const out = capSelectOptions(lines, 15);
    expect(out.filter((l) => l.includes('"a')).length).toBe(15);
    expect(out.filter((l) => l.includes('"b')).length).toBe(2);
  });
});

describe("normalizeName", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeName("  First   Name \n")).toBe("First Name");
  });
});

describe("markRequired", () => {
  it("appends [required] to a matching textbox line", () => {
    const lines = ['- textbox "First Name"', '- textbox "Last Name"'];
    const out = markRequired(lines, new Set(["First Name"]));
    expect(out[0]).toBe('- textbox "First Name" [required]');
    expect(out[1]).toBe('- textbox "Last Name"');
  });

  it("inserts the marker before a nested block's trailing colon", () => {
    const lines = ['- combobox "Class":', '  - option "A"'];
    const out = markRequired(lines, new Set(["Class"]));
    expect(out[0]).toBe('- combobox "Class" [required]:');
  });

  it("does not double-mark an already-marked line", () => {
    const lines = ['- textbox "First Name" [required]'];
    expect(markRequired(lines, new Set(["First Name"]))).toEqual(lines);
  });

  it("leaves non-form-control lines untouched", () => {
    const lines = ['- button "Create Competitor"', '- heading "Add new competitor" [level=1]'];
    expect(markRequired(lines, new Set(["Create Competitor"]))).toEqual(lines);
  });
});

describe("annotateFieldHints", () => {
  it(
    "prints the short name with a (label: ..., optional) annotation when a hint is nested in a " +
      "<span> (real-app shape: accessible name 'Address Optional', short name 'Address')",
    () => {
      const lines = ['- textbox "Address Optional"'];
      const out = annotateFieldHints(lines, [{ full: "Address Optional", short: "Address", required: false }]);
      expect(out[0]).toBe('- textbox "Address" (label: "Address Optional", optional)');
    },
  );

  it("prints 'required' the same way for a required hint", () => {
    const lines = ['- textbox "What it was Required for this action"'];
    const out = annotateFieldHints(lines, [
      { full: "What it was Required for this action", short: "What it was", required: true },
    ]);
    expect(out[0]).toBe('- textbox "What it was" (label: "What it was Required for this action", required)');
  });

  it("leaves a line alone when the short name equals the full name (markRequired's job instead)", () => {
    const lines = ['- textbox "First Name"'];
    const out = annotateFieldHints(lines, [{ full: "First Name", short: "First Name", required: true }]);
    expect(out).toEqual(lines);
  });

  it("leaves a line alone when no hint matches it", () => {
    const lines = ['- button "Create Competitor"'];
    expect(annotateFieldHints(lines, [])).toEqual(lines);
  });

  it("preserves a nested block's trailing colon", () => {
    const lines = ['- combobox "Class Optional":'];
    const out = annotateFieldHints(lines, [{ full: "Class Optional", short: "Class", required: false }]);
    expect(out[0]).toBe('- combobox "Class" (label: "Class Optional", optional):');
  });
});

describe("markRequired + annotateFieldHints together: no double marking", () => {
  it("does not also add [required] to a line annotateFieldHints already annotated", () => {
    const lines = ['- textbox "Address Optional"'];
    const annotated = annotateFieldHints(lines, [{ full: "Address Optional", short: "Address", required: true }]);
    const out = markRequired(annotated, new Set(["Address Optional"]));
    expect(out).toEqual(annotated);
    expect(out[0]).not.toContain("[required]");
  });
});

describe("redactLines", () => {
  it("redacts a non-fake email but keeps an example.com one", () => {
    const out = redactLines(['- text: Contact leaked@realcompany.com or test@example.com']);
    expect(out[0]).not.toContain("leaked@realcompany.com");
    expect(out[0]).toContain("test@example.com");
  });
});

describe("annotateDuplicates", () => {
  it("prints a within disambiguator for each occurrence, in document order", () => {
    const lines = [
      '- group "Riverbend entry":',
      '  - button "Delete"',
      '- group "Nullarbor entry":',
      '  - button "Delete"',
    ];
    const hints = [
      { role: "button", name: "Delete", index: 0, within: "Riverbend entry" },
      { role: "button", name: "Delete", index: 1, within: "Nullarbor entry" },
    ];
    const out = annotateDuplicates(lines, hints);
    expect(out[1]).toContain('(within: "Riverbend entry")');
    expect(out[3]).toContain('(within: "Nullarbor entry")');
  });

  it("falls back to nth when no named ancestor was found", () => {
    const lines = ['- button "Delete"', '- button "Delete"'];
    const hints = [
      { role: "button", name: "Delete", index: 0 },
      { role: "button", name: "Delete", index: 1 },
    ];
    const out = annotateDuplicates(lines, hints);
    expect(out[0]).toContain("(nth: 0)");
    expect(out[1]).toContain("(nth: 1)");
  });

  it("leaves a non-duplicate role+name line untouched", () => {
    const lines = ['- button "Create Competitor"'];
    expect(annotateDuplicates(lines, [])).toEqual(lines);
  });
});

describe("formatSnapshot", () => {
  it("runs the full pipeline and reports line count/truncation", () => {
    const raw = ['- main:', '  - textbox "First Name"', '  - button "Create Competitor"'].join("\n");
    const { text, lineCount, truncated } = formatSnapshot(raw, new Set(["First Name"]));
    expect(text).toContain('[required]');
    expect(lineCount).toBe(3);
    expect(truncated).toBe(false);
  });

  it("caps total output at lineCap and notes how many lines were trimmed", () => {
    const raw = Array.from({ length: 100 }, (_, i) => `- button "B${i}"`).join("\n");
    const { lineCount, truncated, text } = formatSnapshot(raw, new Set(), { lineCap: 80 });
    expect(lineCount).toBe(80);
    expect(truncated).toBe(true);
    expect(text.split("\n").at(-1)).toMatch(/more lines trimmed/);
  });
});
