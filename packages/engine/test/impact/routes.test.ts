import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listApiRoutes } from "../../src/impact/routes.js";

const createdDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-impact-routes-test-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    rmSync(createdDirs.pop()!, { recursive: true, force: true });
  }
});

describe("listApiRoutes — App Router", () => {
  it("finds static and dynamic route.ts handlers", () => {
    const repo = tmpDir();
    mkdirSync(join(repo, "app", "api", "teams", "[id]"), { recursive: true });
    writeFileSync(join(repo, "app", "api", "teams", "[id]", "route.ts"), "export async function GET() {}");
    mkdirSync(join(repo, "app", "api", "health"), { recursive: true });
    writeFileSync(join(repo, "app", "api", "health", "route.ts"), "export async function GET() {}");

    const routes = listApiRoutes(repo);
    expect(routes.map((r) => r.path).sort()).toEqual(["/api/health", "/api/teams/[id]"]);
    const dynamic = routes.find((r) => r.path === "/api/teams/[id]")!;
    expect(dynamic.dynamic).toBe(true);
    expect(dynamic.file).toBe(join("app", "api", "teams", "[id]", "route.ts"));
  });
});

describe("listApiRoutes — Pages Router", () => {
  it("finds files under pages/api, treating index as the parent path", () => {
    const repo = tmpDir();
    mkdirSync(join(repo, "pages", "api", "teams"), { recursive: true });
    writeFileSync(join(repo, "pages", "api", "teams", "[id].ts"), "export default function handler() {}");
    writeFileSync(join(repo, "pages", "api", "teams", "index.ts"), "export default function handler() {}");

    const routes = listApiRoutes(repo);
    expect(routes.map((r) => r.path).sort()).toEqual(["/api/teams", "/api/teams/[id]"]);
  });
});

describe("listApiRoutes — no api dir", () => {
  it("returns an empty list", () => {
    const repo = tmpDir();
    mkdirSync(join(repo, "app"), { recursive: true });
    expect(listApiRoutes(repo)).toEqual([]);
  });
});
