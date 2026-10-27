import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectFramework } from "../../src/init/detect.js";

const createdDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-detect-test-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    rmSync(createdDirs.pop()!, { recursive: true, force: true });
  }
});

describe("detectFramework", () => {
  it("detects a Next.js App Router repo and its top-level routes", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "15.0.0" } }));
    mkdirSync(join(dir, "app", "dashboard"), { recursive: true });
    mkdirSync(join(dir, "app", "login"), { recursive: true });
    mkdirSync(join(dir, "app", "(marketing)"), { recursive: true }); // route group, excluded
    mkdirSync(join(dir, "app", "_components"), { recursive: true }); // private folder, excluded

    const result = detectFramework(dir);
    expect(result.framework).toBe("nextjs");
    expect(result.routes).toEqual(["/dashboard", "/login"]);
  });

  it("recognises next-auth as the sign-in library", () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { next: "15.0.0", "next-auth": "5.0.0" } }),
    );
    mkdirSync(join(dir, "app"), { recursive: true });

    expect(detectFramework(dir).authLibrary).toBe("Auth.js (next-auth)");
  });

  it("reports unknown when there's no package.json or app dir", () => {
    const dir = tmpDir();
    const result = detectFramework(dir);
    expect(result.framework).toBe("unknown");
    expect(result.routes).toEqual([]);
  });

  it("auto-resolves a pnpm workspace monorepo with exactly one Next.js app", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    mkdirSync(join(dir, "apps", "web", "app", "dashboard"), { recursive: true });
    writeFileSync(join(dir, "apps", "web", "package.json"), JSON.stringify({ dependencies: { next: "15.0.0" } }));

    const result = detectFramework(dir);
    expect(result.framework).toBe("nextjs");
    expect(result.routes).toEqual(["/dashboard"]);
    expect(result.apps).toBeUndefined();
  });

  it("lists candidates and asks for --app when a monorepo has several Next.js apps", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    mkdirSync(join(dir, "apps", "web", "app", "dashboard"), { recursive: true });
    writeFileSync(join(dir, "apps", "web", "package.json"), JSON.stringify({ dependencies: { next: "15.0.0" } }));
    mkdirSync(join(dir, "apps", "docs", "app"), { recursive: true });
    writeFileSync(join(dir, "apps", "docs", "package.json"), JSON.stringify({ dependencies: { next: "15.0.0" } }));

    const result = detectFramework(dir);
    expect(result.framework).toBe("unknown");
    expect(result.apps?.map((a) => a.path).sort()).toEqual(["apps/docs", "apps/web"]);
  });

  it("uses --app to resolve a specific app inside a monorepo", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    mkdirSync(join(dir, "apps", "web", "app", "dashboard"), { recursive: true });
    writeFileSync(join(dir, "apps", "web", "package.json"), JSON.stringify({ dependencies: { next: "15.0.0" } }));
    mkdirSync(join(dir, "apps", "docs", "app"), { recursive: true });
    writeFileSync(join(dir, "apps", "docs", "package.json"), JSON.stringify({ dependencies: { next: "15.0.0" } }));

    const result = detectFramework(dir, { app: "apps/web" });
    expect(result.framework).toBe("nextjs");
    expect(result.routes).toEqual(["/dashboard"]);
  });
});
