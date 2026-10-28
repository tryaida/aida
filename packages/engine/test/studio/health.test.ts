// M39: what the Studio reads about a walkthrough beyond pass/fail: the last failure's suspected
// owner and reason, and its outline card's drift. Plain files in a temp dir.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configLiteral, lastFailure, outlineDriftFor, outlineDriftIndex, walkthroughHealth } from "../../src/studio/health.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-studio-health-"));
  dirs.push(dir);
  return dir;
}

describe("studio health", () => {
  it("reads the failure report's category, reason and step", () => {
    const dir = tmp();
    expect(lastFailure(dir)).toBeUndefined();
    writeFileSync(join(dir, "failure.json"), JSON.stringify({ step: "save", category: "environment", reason: "signing in failed", error: "HTTP 401" }));
    expect(lastFailure(dir)).toEqual({ category: "environment", label: "setup problem (not the walkthrough)", reason: "signing in failed", step: "save", error: "HTTP 401" });
    // Older reports had no category; a broken file reads as nothing.
    writeFileSync(join(dir, "failure.json"), JSON.stringify({ error: "not found" }));
    expect(lastFailure(dir)).toMatchObject({ category: "walkthrough", reason: "not found" });
    writeFileSync(join(dir, "failure.json"), "{not json");
    expect(lastFailure(dir)).toBeUndefined();
  });

  it("reads a card's drift, nothing for a dropped card, a missing card or a broken outline", () => {
    const dir = tmp();
    const file = join(dir, "outline.yaml");
    expect(outlineDriftFor(file, "add-session")).toEqual([]);
    writeFileSync(
      file,
      `cards:
  - id: add-session
    title: Add a session
    status: captured
    drift:
      - { expected: Save session, seen: Add session, step: add, at: "2026-10-26T00:00:00Z", source: capture }
      - { expected: Sessions, at: "2026-10-26T00:00:00Z", source: writer }
  - id: old
    title: Old
    status: dropped
    drift:
      - { expected: X, at: "2026-10-26T00:00:00Z", source: capture }
`,
    );
    expect(outlineDriftFor(file, "add-session")).toEqual([
      { expected: "Save session", seen: "Add session", step: "add", source: "capture", text: '"Save session" (saw "Add session" at step add)' },
      { expected: "Sessions", source: "writer", text: '"Sessions" (writer: not on screen)' },
    ]);
    expect(outlineDriftFor(file, "old")).toEqual([]);
    expect(outlineDriftFor(file, "missing")).toEqual([]);
    expect(walkthroughHealth(dir, file, "add-session").drift).toHaveLength(2);
    writeFileSync(file, "cards:\n  - id: Bad Id\n    title: t\n");
    expect(outlineDriftFor(file, "add-session")).toEqual([]);
  });

  it("reads the outline once into an index by card id (M39 review)", () => {
    const dir = tmp();
    const file = join(dir, "outline.yaml");
    writeFileSync(file, `cards:\n  - id: a\n    title: A\n    status: captured\n    drift:\n      - { expected: X, at: "2026-10-26T00:00:00Z", source: capture }\n  - id: b\n    title: B\n    status: captured\n`);
    const index = outlineDriftIndex(file);
    expect([...index.keys()]).toEqual(["a"]);
    expect(walkthroughHealth(dir, index, "a").drift).toHaveLength(1);
    expect(walkthroughHealth(dir, index, "b").drift).toEqual([]);
    expect(outlineDriftIndex(join(dir, "missing.yaml")).size).toBe(0);
  });

  it("configLiteral: a top-level string field of the config object only (M39 review)", () => {
    const config = `// outline: "commented.yaml"
import { defineConfig } from "aida-docs";
const shared = { outline: "not-the-config.yaml" };
export default defineConfig({
  app: { baseUrl: "http://localhost:3000", outline: "nested.yaml" },
  /* outline: "block-commented.yaml" */
  note: "outline: 'in-a-string.yaml'",
  "buildDir": './.build',
  outline: "plan/outline.yaml",
});
`;
    expect(configLiteral(config, "outline")).toBe("plan/outline.yaml");
    expect(configLiteral(config, "buildDir")).toBe("./.build");
    expect(configLiteral(config, "walkthroughsDir")).toBeUndefined();
    // Only nested or commented: not set.
    expect(configLiteral(`export default defineConfig({\n  // outline: "x.yaml",\n  capture: { outline: "y.yaml" },\n});\n`, "outline")).toBeUndefined();
    // Computed: not a literal, so the default applies.
    expect(configLiteral("export default { outline: `${dir}/o.yaml` };", "outline")).toBeUndefined();
    expect(configLiteral("export default { outline: OUTLINE };", "outline")).toBeUndefined();
    expect(configLiteral("export default {\n  outline: 'o.yaml' };", "outline")).toBe("o.yaml");
  });
});
