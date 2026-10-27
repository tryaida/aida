// `aida init` keeps the app's own `next build` from typechecking the help app inside it.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { excludeHelpFromAppTsconfig } from "../../src/init/app-tsconfig.js";

const createdDirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-app-tsconfig-test-"));
  createdDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (createdDirs.length > 0) rmSync(createdDirs.pop()!, { recursive: true, force: true });
});

function withTsconfig(content: string): { app: string; read: () => string } {
  const app = tmpDir();
  writeFileSync(join(app, "tsconfig.json"), content);
  return { app, read: () => readFileSync(join(app, "tsconfig.json"), "utf8") };
}

describe("excludeHelpFromAppTsconfig", () => {
  it("appends to an existing exclude array without touching the rest", () => {
    const before = '{\n  "compilerOptions": { "lib": ["dom", "esnext"] },\n  "include": ["**/*.ts"],\n  "exclude": ["node_modules"]\n}\n';
    const { app, read } = withTsconfig(before);
    expect(excludeHelpFromAppTsconfig(app, join(app, "help")).status).toBe("added");
    expect(read()).toBe(before.replace('["node_modules"]', '["node_modules", "help"]'));
    expect(excludeHelpFromAppTsconfig(app, join(app, "help")).status).toBe("present");
  });

  it("edits a tsconfig with comments and a multi-line exclude", () => {
    const { app, read } = withTsconfig('{\n  // mine\n  "exclude": [\n    "node_modules",\n  ],\n}\n');
    expect(excludeHelpFromAppTsconfig(app, join(app, "help")).status).toBe("added");
    expect(read()).toBe('{\n  // mine\n  "exclude": [\n    "node_modules",\n    "help"\n  ],\n}\n');
  });

  it("matches a multi-line array's layout", () => {
    const { app, read } = withTsconfig('{\n  "exclude": [\n    "node_modules"\n  ]\n}\n');
    excludeHelpFromAppTsconfig(app, join(app, "help"));
    expect(read()).toBe('{\n  "exclude": [\n    "node_modules",\n    "help"\n  ]\n}\n');
  });

  it("adds an exclude with TypeScript's defaults to plain JSON without one", () => {
    const { app, read } = withTsconfig('{\n  "compilerOptions": { "outDir": "./dist" },\n  "include": ["**/*.ts"]\n}\n');
    const r = excludeHelpFromAppTsconfig(app, join(app, "help"));
    expect(r).toMatchObject({ status: "added" });
    expect(r.note).toBeUndefined();
    expect(JSON.parse(read()).exclude).toEqual(["node_modules", "bower_components", "jspm_packages", "dist", "help"]);
    expect(read()).toContain('  "include": ["**/*.ts"],\n  "exclude"');
  });

  it("adds an exclude to a commented tsconfig, keeping its comments", () => {
    const { app, read } = withTsconfig('{\n  // mine\n  "include": ["**/*.ts"], // all of it\n}\n');
    expect(excludeHelpFromAppTsconfig(app, join(app, "help")).status).toBe("added");
    expect(read()).toBe(
      '{\n  // mine\n  "include": ["**/*.ts"], // all of it\n  "exclude": ["node_modules", "bower_components", "jspm_packages", "help"]\n}\n',
    );
  });

  it("ignores a commented-out exclude", () => {
    const { app, read } = withTsconfig('{\n  // "exclude": ["node_modules"],\n  /* "exclude": [] */\n  "include": ["**/*.ts"]\n}\n');
    expect(excludeHelpFromAppTsconfig(app, join(app, "help")).status).toBe("added");
    expect(read()).toContain('// "exclude": ["node_modules"],\n  /* "exclude": [] */\n  "include": ["**/*.ts"],\n  "exclude": ["node_modules"');
  });

  it("keeps a comment trailing the last exclude item with that item", () => {
    const { app, read } = withTsconfig('{\n  "exclude": [\n    "node_modules" // deps\n  ]\n}\n');
    excludeHelpFromAppTsconfig(app, join(app, "help"));
    expect(read()).toBe('{\n  "exclude": [\n    "node_modules", // deps\n    "help"\n  ]\n}\n');
  });

  it("carries over the extends base's exclude, rebased to the app", () => {
    const root = tmpDir();
    const app = join(root, "apps", "web");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(root, "tsconfig.base.json"), '{\n  // shared\n  "exclude": ["node_modules", "**/*.test.ts"],\n}\n');
    writeFileSync(join(app, "tsconfig.json"), '{ "extends": "../../tsconfig.base.json", "include": ["**/*.ts"] }');
    expect(excludeHelpFromAppTsconfig(app, join(app, "help")).status).toBe("added");
    expect(JSON.parse(readFileSync(join(app, "tsconfig.json"), "utf8")).exclude).toEqual(["../../node_modules", "../../**/*.test.ts", "help"]);
  });

  it("follows an extends chain and packages in node_modules", () => {
    const app = tmpDir();
    const pkg = join(app, "node_modules", "@acme", "tsconfig");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), '{ "name": "@acme/tsconfig", "tsconfig": "next.json" }');
    writeFileSync(join(pkg, "next.json"), '{ "exclude": ["build"] }');
    writeFileSync(join(app, "tsconfig.mid.json"), '{ "extends": "@acme/tsconfig" }');
    writeFileSync(join(app, "tsconfig.json"), '{ "extends": "./tsconfig.mid" }');
    excludeHelpFromAppTsconfig(app, join(app, "help"));
    expect(JSON.parse(readFileSync(join(app, "tsconfig.json"), "utf8")).exclude).toEqual(["node_modules/@acme/tsconfig/build", "help"]);
  });

  it("uses the defaults with a note when the extends base can't be read", () => {
    const { app, read } = withTsconfig('{ "extends": "@missing/tsconfig" }');
    const r = excludeHelpFromAppTsconfig(app, join(app, "help"));
    expect(r.status).toBe("added");
    expect(r.note).toMatch(/couldn't read.*copy its entries/);
    expect(JSON.parse(read()).exclude).toEqual(["node_modules", "bower_components", "jspm_packages", "help"]);
  });

  it("leaves an unparseable tsconfig to the user", () => {
    const before = '{\n  "include": ["**/*.ts"\n';
    const { app, read } = withTsconfig(before);
    expect(excludeHelpFromAppTsconfig(app, join(app, "help")).status).toBe("manual");
    expect(read()).toBe(before);
  });

  it("does nothing when help isn't inside the app or there's no tsconfig", () => {
    const { app } = withTsconfig("{}");
    expect(excludeHelpFromAppTsconfig(app, join(tmpDir(), "help")).status).toBe("none");
    const bare = tmpDir();
    mkdirSync(join(bare, "help"));
    expect(excludeHelpFromAppTsconfig(bare, join(bare, "help")).status).toBe("none");
  });
});
