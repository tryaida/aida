import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeAidaConfig } from "../../src/init/write-config.js";
import type { DetectResult } from "../../src/init/detect.js";

const createdDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-write-config-test-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    rmSync(createdDirs.pop()!, { recursive: true, force: true });
  }
});

const detectedNext: DetectResult = {
  framework: "nextjs",
  appDir: "/repo/app",
  routes: ["/dashboard", "/login"],
  authLibrary: "Auth.js (next-auth)",
};

describe("writeAidaConfig", () => {
  it("writes a config with the app URL, brand and detected routes as comments", () => {
    const dir = tmpDir();
    const result = writeAidaConfig({
      destDir: dir,
      appUrl: "http://127.0.0.1:3100",
      brand: { primaryColor: "235 55% 42%", logo: "public/logo.svg" },
      detected: detectedNext,
    });

    expect(result.written).toBe(true);
    const content = readFileSync(result.file, "utf8");
    expect(content).toContain('baseUrl: "http://127.0.0.1:3100"');
    expect(content).toContain("primaryColor");
    expect(content).toContain("235 55% 42%");
    expect(content).toContain("/dashboard, /login");
    expect(content).toContain("import { defineConfig } from \"aida-docs\"");
  });

  it("sets helpApp so the generated config points the index stage at its own help site (bug: fresh help site never showed built pages)", () => {
    const dir = tmpDir();
    const result = writeAidaConfig({
      destDir: dir,
      appUrl: "http://127.0.0.1:3100",
      brand: {},
      detected: detectedNext,
    });

    const content = readFileSync(result.file, "utf8");
    expect(content).toMatch(/helpApp:\s*"\."/);
  });

  it("writes config.ci.claudeAction/docsRepo when the matching --ci flags were used (build-plan.md M19)", () => {
    const dir = tmpDir();
    const result = writeAidaConfig({
      destDir: dir,
      appUrl: "http://127.0.0.1:3100",
      brand: {},
      detected: detectedNext,
      ci: { claudeAction: true, docsRepo: "acme/aida-docs" },
    });

    const content = readFileSync(result.file, "utf8");
    expect(content).toMatch(/ci:\s*\{/);
    expect(content).toContain("claudeAction: true");
    expect(content).toContain('docsRepo: "acme/aida-docs"');
  });

  it("omits the ci block entirely when neither flag was used", () => {
    const dir = tmpDir();
    const result = writeAidaConfig({ destDir: dir, appUrl: "http://127.0.0.1:3100", brand: {}, detected: detectedNext, ci: {} });
    const content = readFileSync(result.file, "utf8");
    expect(content).not.toMatch(/\bci:\s*\{/);
  });

  it("writes the full detected brand, with nested colors/dark objects in a fixed key order", () => {
    const dir = tmpDir();
    const result = writeAidaConfig({
      destDir: dir,
      appUrl: "http://127.0.0.1:3100",
      brand: {
        radius: "10px",
        dark: { background: "224 44% 7%", primary: "236 72% 71%" },
        colors: { background: "222 26% 97%" },
        name: "Acme Events",
        primaryColor: "235 55% 42%",
        logoDark: "../public/white.png",
      },
      detected: detectedNext,
    });
    const content = readFileSync(result.file, "utf8");
    expect(content).toContain(`  brand: {
    name: "Acme Events",
    primaryColor: "235 55% 42%",
    colors: {
      background: "222 26% 97%",
    },
    dark: {
      primary: "236 72% 71%",
      background: "224 44% 7%",
    },
    logoDark: "../public/white.png",
    radius: "10px",
  },
`);
  });

  it("never overwrites an existing aida.config.ts", () => {
    const dir = tmpDir();
    const file = join(dir, "aida.config.ts");
    writeFileSync(file, "// hand-edited\n");

    const result = writeAidaConfig({
      destDir: dir,
      appUrl: "http://example.com",
      brand: {},
      detected: { framework: "unknown", routes: [] },
    });

    expect(result.written).toBe(false);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("// hand-edited\n");
  });
});
