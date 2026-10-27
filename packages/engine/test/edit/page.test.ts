import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setPageBlock } from "../../src/edit/page.js";
import { lock } from "../../src/edit/locks.js";
import { EditLockedError, EditValidationError } from "../../src/edit/types.js";
import { mergeBlocks, readSidecar, writeSidecar } from "../../src/pages/markers.js";
import { cleanupTmpDirs, tmpDir } from "./helpers.js";

afterEach(() => {
  cleanupTmpDirs();
});

function makePage(dir: string) {
  writeFileSync(join(dir, "next.config.mjs"), "export default {};\n");
  mkdirSync(join(dir, "content"), { recursive: true });
  const pageFile = join(dir, "content", "index.mdx");

  const first = mergeBlocks(undefined, [
    { key: "header", content: "# Add a competitor" },
    { key: "step-1", content: "Click **Add Competitor**." },
  ], {});
  writeFileSync(pageFile, first.text);
  writeSidecar(pageFile, first.sidecar);
  return { pageFile, sidecar: first.sidecar };
}

describe("setPageBlock", () => {
  it("edits a generated block's text in place", () => {
    const dir = tmpDir();
    const { pageFile } = makePage(dir);

    const result = setPageBlock(pageFile, "step-1", "Click **Add Competitor** at the top right.", { by: "person" });

    expect(result.before).toBe("Click **Add Competitor**.");
    const text = readFileSync(pageFile, "utf8");
    expect(text).toContain("Click **Add Competitor** at the top right.");
    expect(text).toContain("# Add a competitor");
  });

  it("flips a generated block to human-owned: the next rebuild suggests instead of overwriting", () => {
    const dir = tmpDir();
    const { pageFile, sidecar } = makePage(dir);

    setPageBlock(pageFile, "step-1", "A person's rewritten instructions.", { by: "person" });
    const editedText = readFileSync(pageFile, "utf8");

    // Simulate the next rebuild: same sidecar as before the edit, freshly generated content for
    // step-1 that's different from what the person wrote.
    const rebuilt = mergeBlocks(editedText, [
      { key: "header", content: "# Add a competitor" },
      { key: "step-1", content: "Click **Add Competitor**." },
    ], readSidecar(pageFile));

    expect(rebuilt.suggestions.some((s) => s.key === "step-1")).toBe(true);
    expect(rebuilt.text).toContain("A person's rewritten instructions.");
    expect(rebuilt.text).not.toContain("Click **Add Competitor**.\n");
    void sidecar;
  });

  it("appends a new human-owned block when the key doesn't exist yet", () => {
    const dir = tmpDir();
    const { pageFile } = makePage(dir);

    setPageBlock(pageFile, "custom-note", "A note aida never generated.", { by: "person" });

    const text = readFileSync(pageFile, "utf8");
    expect(text).toContain("A note aida never generated.");
    expect(text).toContain("aida:begin custom-note");
  });

  it("refuses to write a file that isn't .md/.mdx", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "next.config.mjs"), "export default {};\n");
    const notAPage = join(dir, "app", "api", "chat", "route.ts");
    mkdirSync(join(dir, "app", "api", "chat"), { recursive: true });
    writeFileSync(notAPage, "export async function POST() {}\n");

    expect(() => setPageBlock(notAPage, "k", "malicious", { by: "person" })).toThrow(EditValidationError);
    expect(readFileSync(notAPage, "utf8")).toBe("export async function POST() {}\n");
  });

  it("refuses to write outside the given pagesDir, even to a .mdx file", () => {
    const dir = tmpDir();
    const { pageFile } = makePage(dir);
    const pagesDir = join(dir, "pages"); // pageFile is under dir/content, not dir/pages

    expect(() => setPageBlock(pageFile, "step-1", "x", { by: "person", pagesDir })).toThrow(EditValidationError);
  });

  it("allows a write inside the given pagesDir", () => {
    const dir = tmpDir();
    const { pageFile } = makePage(dir);
    const pagesDir = join(dir, "content");

    const result = setPageBlock(pageFile, "step-1", "Inside pagesDir.", { by: "person", pagesDir });
    expect(result.after).toBe("Inside pagesDir.");
  });

  it("locking a page block via one path spelling blocks an agent edit via a different spelling of the same file", () => {
    const dir = tmpDir();
    const { pageFile } = makePage(dir);
    const differentlySpelled = `${join(dir, "content")}/./index.mdx`;
    expect(differentlySpelled).not.toBe(pageFile); // same file, different string

    // Lock using the key the normalised itemKey would produce (helpRoot-relative resolved path).
    const helpRootRelativeKey = `page:content/index.mdx:step-1`;
    lock(pageFile, helpRootRelativeKey, { by: "person" });

    expect(() => setPageBlock(differentlySpelled, "step-1", "Agent tries anyway.", { by: "agent" })).toThrow(EditLockedError);
    // A person can still override.
    setPageBlock(differentlySpelled, "step-1", "Person overrides.", { by: "person" });
    expect(readFileSync(pageFile, "utf8")).toContain("Person overrides.");
  });
});
