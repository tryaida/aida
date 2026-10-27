import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ImportGraph } from "../../src/impact/import-graph.js";

const createdDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-impact-import-graph-test-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    rmSync(createdDirs.pop()!, { recursive: true, force: true });
  }
});

describe("ImportGraph", () => {
  it("follows a relative import to its resolved file", () => {
    const repo = tmpDir();
    mkdirSync(join(repo, "app"), { recursive: true });
    writeFileSync(join(repo, "app", "shared.ts"), "export const x = 1;");
    writeFileSync(join(repo, "app", "page.tsx"), 'import { x } from "./shared";\nexport default function Page() { return x; }');

    const graph = new ImportGraph(repo);
    const closure = graph.closure(join(repo, "app", "page.tsx"));
    expect(closure.has(join(repo, "app", "shared.ts"))).toBe(true);
  });

  it("resolves a tsconfig path alias (@/*)", () => {
    const repo = tmpDir();
    writeFileSync(repo + "/tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./*"] } } }));
    mkdirSync(join(repo, "lib"), { recursive: true });
    writeFileSync(join(repo, "lib", "actions.ts"), "export const doThing = () => {};");
    mkdirSync(join(repo, "app"), { recursive: true });
    writeFileSync(join(repo, "app", "page.tsx"), 'import { doThing } from "@/lib/actions";\nexport default function Page() { return null; }');

    const graph = new ImportGraph(repo);
    const closure = graph.closure(join(repo, "app", "page.tsx"));
    expect(closure.has(join(repo, "lib", "actions.ts"))).toBe(true);
  });

  it("resolves an index file for a directory import", () => {
    const repo = tmpDir();
    mkdirSync(join(repo, "components", "widget"), { recursive: true });
    writeFileSync(join(repo, "components", "widget", "index.tsx"), "export const Widget = () => null;");
    mkdirSync(join(repo, "app"), { recursive: true });
    writeFileSync(
      join(repo, "app", "page.tsx"),
      'import { Widget } from "../components/widget";\nexport default function Page() { return null; }',
    );

    const graph = new ImportGraph(repo);
    const closure = graph.closure(join(repo, "app", "page.tsx"));
    expect(closure.has(join(repo, "components", "widget", "index.tsx"))).toBe(true);
  });

  it("never follows a bare package import past the repo boundary", () => {
    const repo = tmpDir();
    mkdirSync(join(repo, "app"), { recursive: true });
    writeFileSync(join(repo, "app", "page.tsx"), 'import { useState } from "react";\nexport default function Page() { return null; }');

    const graph = new ImportGraph(repo);
    const closure = graph.closure(join(repo, "app", "page.tsx"));
    expect(closure.size).toBe(1); // just the entry itself
  });

  it("follows a transitive chain (page -> component -> shared lib)", () => {
    const repo = tmpDir();
    mkdirSync(join(repo, "lib"), { recursive: true });
    writeFileSync(join(repo, "lib", "deep.ts"), "export const z = 1;");
    mkdirSync(join(repo, "components"), { recursive: true });
    writeFileSync(join(repo, "components", "card.tsx"), 'import { z } from "../lib/deep";\nexport const Card = () => z;');
    mkdirSync(join(repo, "app"), { recursive: true });
    writeFileSync(
      join(repo, "app", "page.tsx"),
      'import { Card } from "../components/card";\nexport default function Page() { return null; }',
    );

    const graph = new ImportGraph(repo);
    const closure = graph.closure(join(repo, "app", "page.tsx"));
    expect(closure.has(join(repo, "lib", "deep.ts"))).toBe(true);
  });
});
