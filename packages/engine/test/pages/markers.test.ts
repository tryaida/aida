import { describe, expect, it } from "vitest";
import { FRONTMATTER_KEY, mergeBlocks, renameLegacyKey, stripMarkers } from "../../src/pages/markers.js";

describe("mergeBlocks", () => {
  it("first build: renders every block with MDX-safe markers, in order", () => {
    const { text, sidecar, suggestions } = mergeBlocks(undefined, [
      { key: "a", content: "Alpha" },
      { key: "b", content: "Beta" },
    ], {});
    expect(text).toBe("{/* aida:begin a */}\nAlpha\n{/* aida:end a */}\n\n{/* aida:begin b */}\nBeta\n{/* aida:end b */}");
    expect(sidecar.a).toBeTruthy();
    expect(sidecar.b).toBeTruthy();
    expect(suggestions).toHaveLength(0);
  });

  it("rebuild: rewrites a block whose hash still matches what aida last wrote", () => {
    const first = mergeBlocks(undefined, [{ key: "a", content: "Alpha v1" }], {});
    const second = mergeBlocks(first.text, [{ key: "a", content: "Alpha v2" }], first.sidecar);
    expect(second.text).toContain("Alpha v2");
    expect(second.text).not.toContain("Alpha v1");
    expect(second.suggestions).toHaveLength(0);
  });

  it("preserves text outside any marker, byte-for-byte", () => {
    const first = mergeBlocks(undefined, [
      { key: "a", content: "Alpha" },
      { key: "b", content: "Beta" },
    ], {});
    const withHumanText = `A human wrote this intro.\n\n${first.text}\n\nAnd this closing note, by hand.`;
    const second = mergeBlocks(withHumanText, [
      { key: "a", content: "Alpha v2" },
      { key: "b", content: "Beta" },
    ], first.sidecar);

    expect(second.text).toContain("A human wrote this intro.");
    expect(second.text).toContain("And this closing note, by hand.");
    expect(second.text).toContain("Alpha v2");
  });

  it("does NOT overwrite a block a human edited, and reports it as a suggestion instead", () => {
    const first = mergeBlocks(undefined, [{ key: "a", content: "Alpha v1" }], {});
    const humanEdited = first.text.replace("Alpha v1", "Alpha, rewritten by a person");

    const second = mergeBlocks(humanEdited, [{ key: "a", content: "Alpha v2 (freshly generated)" }], first.sidecar);

    expect(second.text).toContain("Alpha, rewritten by a person");
    expect(second.text).not.toContain("Alpha v2 (freshly generated)");
    expect(second.suggestions).toHaveLength(1);
    expect(second.suggestions[0].key).toBe("a");
    expect(second.suggestions[0].suggested).toBe("Alpha v2 (freshly generated)");
  });

  it("treats a hand-written marker with no sidecar record as human-authored (never overwritten)", () => {
    const handWritten = "{/* aida:begin a */}\nWritten by hand, markers copied from another page.\n{/* aida:end a */}";
    const result = mergeBlocks(handWritten, [{ key: "a", content: "Generated content" }], {});

    expect(result.text).toContain("Written by hand");
    expect(result.text).not.toContain("Generated content");
    expect(result.suggestions).toHaveLength(1);
  });

  it("appends a new block (e.g. a step added since the last build) without disturbing the rest", () => {
    const first = mergeBlocks(undefined, [{ key: "a", content: "Alpha" }], {});
    const second = mergeBlocks(first.text, [
      { key: "a", content: "Alpha" },
      { key: "b", content: "Beta (new)" },
    ], first.sidecar);

    expect(second.text).toContain("Alpha");
    expect(second.text).toContain("Beta (new)");
    expect(second.suggestions).toHaveLength(0);
  });

  it("drops a stale block (e.g. a removed step) that was never human-edited", () => {
    const first = mergeBlocks(
      undefined,
      [
        { key: "a", content: "Alpha" },
        { key: "b", content: "Beta" },
        { key: "c", content: "Gamma" },
      ],
      {},
    );
    // "b" no longer exists in the current build (its step was removed).
    const second = mergeBlocks(
      first.text,
      [
        { key: "a", content: "Alpha" },
        { key: "c", content: "Gamma" },
      ],
      first.sidecar,
    );

    expect(second.text).not.toContain("aida:begin b");
    expect(second.text).not.toContain("Beta");
    expect(second.text).toContain("Alpha");
    expect(second.text).toContain("Gamma");
    expect(second.suggestions).toHaveLength(0);
  });

  it("leaves a stale block in place and flags it when a human had edited it", () => {
    const first = mergeBlocks(undefined, [
      { key: "a", content: "Alpha" },
      { key: "b", content: "Beta" },
    ], {});
    const humanEdited = first.text.replace("Beta", "Beta, rewritten by a person");

    const second = mergeBlocks(humanEdited, [{ key: "a", content: "Alpha" }], first.sidecar);

    expect(second.text).toContain("Beta, rewritten by a person");
    expect(second.suggestions.some((s) => s.key === "b")).toBe(true);
  });

  it("inserts a new block after the block that precedes it, not always at the end of the file", () => {
    const first = mergeBlocks(
      undefined,
      [
        { key: "a", content: "Alpha" },
        { key: "c", content: "Gamma" },
      ],
      {},
    );
    // A footer-like trailing block added by hand, simulating "last-checked" sitting at the very
    // end of the file — the bug this fixes appended new blocks after it, out of order.
    const withFooter = `${first.text}\n\n---\n\n*Footer, by hand.*`;

    const second = mergeBlocks(
      withFooter,
      [
        { key: "a", content: "Alpha" },
        { key: "b", content: "Beta (new, inserted between a and c)" },
        { key: "c", content: "Gamma" },
      ],
      first.sidecar,
    );

    const ia = second.text.indexOf("Alpha");
    const ib = second.text.indexOf("Beta (new");
    const ic = second.text.indexOf("Gamma");
    const footer = second.text.indexOf("Footer, by hand");
    expect(ia).toBeLessThan(ib);
    expect(ib).toBeLessThan(ic);
    expect(ic).toBeLessThan(footer);
  });

  it("a no-op rebuild (same blocks, same sidecar) is idempotent", () => {
    const first = mergeBlocks(undefined, [
      { key: "a", content: "Alpha" },
      { key: "b", content: "Beta" },
    ], {});
    const second = mergeBlocks(first.text, [
      { key: "a", content: "Alpha" },
      { key: "b", content: "Beta" },
    ], first.sidecar);
    expect(second.text).toBe(first.text);
    expect(second.sidecar).toEqual(first.sidecar);
  });

  it("accepts the older HTML-comment marker style when reading, for migration", () => {
    const legacy = "<!-- aida:begin a -->\nAlpha v1\n<!-- aida:end a -->";
    const first = mergeBlocks(undefined, [{ key: "a", content: "Alpha v1" }], {});
    // Simulate a page built before the MDX-marker fix: same content, old marker style, and a
    // sidecar recorded against that old-style text (what a pre-fix build would have written).
    const sidecarIn = { a: first.sidecar.a };
    const result = mergeBlocks(legacy, [{ key: "a", content: "Alpha v2" }], sidecarIn);

    expect(result.text).toContain("Alpha v2");
    expect(result.text).toContain("{/* aida:begin a */}");
    expect(result.text).not.toContain("<!-- aida:begin a -->");
    expect(result.suggestions).toHaveLength(0);
  });

  describe("frontmatter", () => {
    it("writes the frontmatter block plain at the top of the file, with no markers around it", () => {
      const { text, sidecar } = mergeBlocks(undefined, [
        { key: FRONTMATTER_KEY, content: "---\ntitle: \"T\"\n---" },
        { key: "header", content: "# T" },
      ], {});

      expect(text.startsWith("---\ntitle: \"T\"\n---")).toBe(true);
      expect(text).not.toContain("aida:begin frontmatter");
      expect(text).not.toContain("aida:end frontmatter");
      expect(text).toContain("{/* aida:begin header */}");
      expect(sidecar[FRONTMATTER_KEY]).toBeTruthy();
    });

    it("rebuilds frontmatter in place when it still matches the last-written hash", () => {
      const first = mergeBlocks(undefined, [{ key: FRONTMATTER_KEY, content: "---\ntitle: \"T1\"\n---" }], {});
      const second = mergeBlocks(first.text, [{ key: FRONTMATTER_KEY, content: "---\ntitle: \"T2\"\n---" }], first.sidecar);

      expect(second.text.startsWith("---\ntitle: \"T2\"\n---")).toBe(true);
      expect(second.suggestions).toHaveLength(0);
    });

    it("leaves a human-edited frontmatter alone and reports a suggestion", () => {
      const first = mergeBlocks(undefined, [{ key: FRONTMATTER_KEY, content: "---\ntitle: \"T1\"\n---" }], {});
      const humanEdited = first.text.replace("T1", "A Human Title");

      const second = mergeBlocks(humanEdited, [{ key: FRONTMATTER_KEY, content: "---\ntitle: \"T2\"\n---" }], first.sidecar);

      expect(second.text).toContain("A Human Title");
      expect(second.text).not.toContain("T2");
      expect(second.suggestions.some((s) => s.key === FRONTMATTER_KEY)).toBe(true);
    });

    it("always refreshes engine-owned keys (passed, lastChecked) even when a human edited another frontmatter field", () => {
      const first = mergeBlocks(
        undefined,
        [
          {
            key: FRONTMATTER_KEY,
            content: '---\ntitle: "T1"\nwalkthrough: "add-thing"\nlastChecked: "2024-01-01"\npassed: true\n---',
          },
        ],
        {},
      );
      const humanEdited = first.text.replace('title: "T1"', 'title: "A Human Title"');

      // A rebuild from a capture that has since FAILED must still ship passed:false and the new
      // lastChecked, even though a person edited the title (and never touched passed/lastChecked
      // themselves) — see the bug this fixes.
      const second = mergeBlocks(
        humanEdited,
        [
          {
            key: FRONTMATTER_KEY,
            content: '---\ntitle: "T2"\nwalkthrough: "add-thing"\nlastChecked: "2024-02-02"\npassed: false\n---',
          },
        ],
        first.sidecar,
      );

      expect(second.text).toContain('title: "A Human Title"');
      expect(second.text).toContain("passed: false");
      expect(second.text).toContain('lastChecked: "2024-02-02"');
      expect(second.text).not.toContain("passed: true");
    });

    it("migrates a pre-fix page whose frontmatter was wrapped in its own marker pair (either style)", () => {
      const legacyHtml =
        "<!-- aida:begin frontmatter -->\n---\ntitle: \"T1\"\n---\n<!-- aida:end frontmatter -->\n\n{/* aida:begin header */}\n# T1\n{/* aida:end header */}";

      const result = mergeBlocks(
        legacyHtml,
        [
          { key: FRONTMATTER_KEY, content: "---\ntitle: \"T2\"\n---" },
          { key: "header", content: "# T2" },
        ],
        {},
      );

      // No sidecar record for either block (pre-fix sidecar never saw the plain-frontmatter
      // shape) => both come back as human-authored, but migrated to the new plain/MDX shapes.
      expect(result.text.startsWith("---\ntitle: \"T1\"\n---")).toBe(true);
      expect(result.text).not.toContain("aida:begin frontmatter");
      expect(result.text).toContain("{/* aida:begin header */}");
    });
  });
});

describe("stripMarkers", () => {
  it("removes MDX-comment markers but keeps the content they wrapped", () => {
    const text = "{/* aida:begin a */}\nAlpha\n{/* aida:end a */}\n\n{/* aida:begin b */}\nBeta\n{/* aida:end b */}";
    const stripped = stripMarkers(text);
    expect(stripped).not.toContain("aida:begin");
    expect(stripped).not.toContain("aida:end");
    expect(stripped).toContain("Alpha");
    expect(stripped).toContain("Beta");
  });

  it("also removes the older HTML-comment markers, for migration", () => {
    const text = "<!-- aida:begin a -->\nAlpha\n<!-- aida:end a -->";
    const stripped = stripMarkers(text);
    expect(stripped).not.toContain("aida:begin");
    expect(stripped).toContain("Alpha");
  });
});

describe("renameLegacyKey", () => {
  it("renames an aida-tracked marker and its sidecar entry, preserving content", () => {
    const first = mergeBlocks(undefined, [{ key: "step-1", content: "Step one" }], {});
    const { text, sidecar } = renameLegacyKey(first.text, first.sidecar, "step-1", "step-open-page");

    expect(text).toContain("aida:begin step-open-page");
    expect(text).not.toContain("aida:begin step-1");
    expect(text).toContain("Step one");
    expect(sidecar["step-open-page"]).toBe(first.sidecar["step-1"]);
    expect(sidecar["step-1"]).toBeUndefined();
  });

  it("preserves a human edit under the renamed key", () => {
    const first = mergeBlocks(undefined, [{ key: "step-1", content: "Step one" }], {});
    const humanEdited = first.text.replace("Step one", "Step one, rewritten by a person");
    const { text, sidecar } = renameLegacyKey(humanEdited, first.sidecar, "step-1", "step-open-page");

    expect(text).toContain("Step one, rewritten by a person");
    // A later mergeBlocks call still detects this as human-edited under the new key.
    const result = mergeBlocks(text, [{ key: "step-open-page", content: "Step one (regenerated)" }], sidecar);
    expect(result.text).toContain("Step one, rewritten by a person");
    expect(result.suggestions.some((s) => s.key === "step-open-page")).toBe(true);
  });

  it("is a no-op when the old key was never aida's own write", () => {
    const handWritten = "{/* aida:begin step-1 */}\nHand-written.\n{/* aida:end step-1 */}";
    const { text, sidecar } = renameLegacyKey(handWritten, {}, "step-1", "step-open-page");
    expect(text).toBe(handWritten);
    expect(sidecar).toEqual({});
  });
});
