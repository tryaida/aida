import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyTemplate } from "../../src/init/copy-template.js";

const createdDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-copy-template-test-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    rmSync(createdDirs.pop()!, { recursive: true, force: true });
  }
});

function makeFakeTemplate(): string {
  const dir = tmpDir();
  mkdirSync(join(dir, "app"), { recursive: true });
  writeFileSync(join(dir, "package.json"), "{}");
  writeFileSync(join(dir, "app", "layout.tsx"), "export default function Layout() {}\n");
  mkdirSync(join(dir, "node_modules", "whatever"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "whatever", "index.js"), "module.exports = {};");
  return dir;
}

describe("copyTemplate", () => {
  it("copies every template file into an empty destination", () => {
    const template = makeFakeTemplate();
    const dest = tmpDir();

    const result = copyTemplate(dest, template);

    expect(result.copied.sort()).toEqual(["app/layout.tsx", "package.json"].sort());
    expect(result.skipped).toEqual([]);
    expect(existsSync(join(dest, "package.json"))).toBe(true);
    expect(existsSync(join(dest, "app", "layout.tsx"))).toBe(true);
  });

  it("skips node_modules/.next/.build and never overwrites an existing file", () => {
    const template = makeFakeTemplate();
    const dest = tmpDir();
    writeFileSync(join(dest, "package.json"), '{"already": "here"}');

    const result = copyTemplate(dest, template);

    expect(result.skipped).toEqual(["package.json"]);
    expect(result.copied).toEqual(["app/layout.tsx"]);
    expect(JSON.parse(readFileSync(join(dest, "package.json"), "utf8"))).toEqual({ already: "here" });
    expect(existsSync(join(dest, "node_modules"))).toBe(false);
  });

  it("skips machine-local files: env files, build info, the template's own tests", () => {
    const template = makeFakeTemplate();
    writeFileSync(join(template, ".env.local"), "ANTHROPIC_API_KEY=never-copy-me");
    writeFileSync(join(template, ".env"), "X=1");
    writeFileSync(join(template, "tsconfig.tsbuildinfo"), "{}");
    writeFileSync(join(template, ".gitignore"), "node_modules/\n");
    mkdirSync(join(template, "test"), { recursive: true });
    writeFileSync(join(template, "test", "a.test.ts"), "");
    mkdirSync(join(template, "vendor"), { recursive: true });
    writeFileSync(join(template, "vendor", "aida-docs-0.0.1.tgz"), "");
    const dest = tmpDir();

    const result = copyTemplate(dest, template);

    expect(result.copied.sort()).toEqual([".gitignore", "app/layout.tsx", "package.json"]);
  });

  it("throws when the template directory doesn't exist", () => {
    expect(() => copyTemplate(tmpDir(), join(tmpdir(), "does-not-exist-template"))).toThrow();
  });
});
