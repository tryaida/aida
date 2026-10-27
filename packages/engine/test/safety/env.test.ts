import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appEnvDirs, collectAppEnv, expandEnvValue, isAppEnvFile, parseEnvFile, UNRESOLVED } from "../../src/safety/env.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function appDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-safety-env-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

describe("parseEnvFile", () => {
  it("reads plain, quoted and exported values, skipping comments", () => {
    const parsed = parseEnvFile(
      [
        "# a comment",
        "PLAIN=postgres://a@db.example.com/x",
        'DOUBLE="postgres://b@h2.example.com/y" # trailing comment',
        "SINGLE='value # not a comment'",
        "export EXPORTED=yes",
        "INLINE=abc # comment",
        "EMPTY=",
        'MULTI="line1\\nline2"',
        "  SPACED = padded  ",
      ].join("\n"),
    );
    expect(parsed.PLAIN).toBe("postgres://a@db.example.com/x");
    expect(parsed.DOUBLE).toBe("postgres://b@h2.example.com/y");
    expect(parsed.SINGLE).toBe("value # not a comment");
    expect(parsed.EXPORTED).toBe("yes");
    expect(parsed.INLINE).toBe("abc");
    expect(parsed.EMPTY).toBe("");
    expect(parsed.MULTI).toBe("line1\nline2");
    expect(parsed.SPACED).toBe("padded");
  });

  it("handles CRLF line endings and later duplicates win", () => {
    expect(parseEnvFile("A=1\r\nA=2\r\n")).toEqual({ A: "2" });
  });
});

describe("expandEnvValue", () => {
  const lookup = (n: string) => ({ HOST: "db.example.com", EMPTY: "" })[n];
  it("expands ${VAR}, $VAR and defaults", () => {
    expect(expandEnvValue("postgres://u@${HOST}/db", lookup)).toBe("postgres://u@db.example.com/db");
    expect(expandEnvValue("postgres://u@$HOST/db", lookup)).toBe("postgres://u@db.example.com/db");
    expect(expandEnvValue("${MISSING:-localhost}", lookup)).toBe("localhost");
    expect(expandEnvValue("${EMPTY:-fallback}", lookup)).toBe("fallback");
    expect(expandEnvValue("\\$HOST", lookup)).toBe("$HOST");
  });
  it("marks a reference it can't resolve", () => {
    expect(expandEnvValue("${NOPE}", lookup)).toBe(UNRESOLVED);
  });
});

describe("collectAppEnv", () => {
  const isDb = (n: string) => n === "DATABASE_URL" || n === "DIRECT_URL";
  const sources = (dir: string | undefined, env: Record<string, string | undefined> = {}) =>
    collectAppEnv(dir, env, isDb).values.map((v) => v.source).sort();

  it("keeps every file's value, whatever the precedence (finding 4: Vite lets .env.development beat .env.local)", () => {
    const dir = appDir({
      ".env": "DATABASE_URL=postgres://a@remote.example.com/x",
      ".env.local": "DATABASE_URL=postgres://a@localhost/x",
      ".env.development": "DATABASE_URL=postgres://a@dev.example.com/x",
      ".env.production": "DATABASE_URL=postgres://a@prod.example.com/x",
    });
    expect(sources(dir)).toEqual([".env.development:DATABASE_URL", ".env.local:DATABASE_URL", ".env.production:DATABASE_URL", ".env:DATABASE_URL"]);
  });

  it("keeps a file value that process env has the same variable for (finding 5)", () => {
    const dir = appDir({ ".env.local": "DATABASE_URL=postgres://a@remote.example.com/x\nDIRECT_URL=postgres://a@localhost/x" });
    expect(sources(dir, { DATABASE_URL: "postgres://a@127.0.0.1/x" })).toEqual([".env.local:DATABASE_URL", ".env.local:DIRECT_URL", "process.env.DATABASE_URL"]);
  });

  it("an empty value sets nothing and hides nothing", () => {
    const dir = appDir({ ".env": "DATABASE_URL=postgres://a@remote.example.com/x", ".env.local": "DATABASE_URL=" });
    expect(sources(dir, { DATABASE_URL: "" })).toEqual([".env:DATABASE_URL"]);
  });

  it("reads Vite mode files and .envrc, but not templates or backups", () => {
    const dir = appDir({
      ".env.staging": "DATABASE_URL=postgres://a@stage.example.com/x",
      ".envrc": "export DATABASE_URL=postgres://a@rc.example.com/x",
      ".env.example": "DATABASE_URL=postgres://user:pass@host:5432/db",
      ".env.production-backup": "DATABASE_URL=postgres://a@old.example.com/x",
      ".env.local.bak": "DATABASE_URL=postgres://a@old.example.com/x",
    });
    expect(sources(dir)).toEqual([".env.staging:DATABASE_URL", ".envrc:DATABASE_URL"]);
  });

  it("reads a monorepo's root .env up to the git root, labelled relative to the app (finding 2)", () => {
    const root = appDir({ ".env": "DATABASE_URL=postgres://a@root.example.com/x" });
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    const app = join(root, "apps", "web");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, ".env.local"), "DIRECT_URL=postgres://a@localhost/x");
    expect(sources(app)).toEqual(["../../.env:DATABASE_URL", ".env.local:DIRECT_URL"]);
    expect(appEnvDirs(app)).toEqual([app, join(root, "apps"), root]);
  });

  it("stops at the app directory when it isn't in a git repository (a stray empty .git doesn't count)", () => {
    const dir = appDir({});
    mkdirSync(join(dir, "sub", ".git"), { recursive: true });
    expect(appEnvDirs(join(dir, "sub"))).toEqual([join(dir, "sub")]);
  });

  it("expands references across files", () => {
    const dir = appDir({ ".env": "DB_HOST=db.example.com", ".env.local": "DATABASE_URL=postgres://u@${DB_HOST}/x" });
    const [v] = collectAppEnv(dir, {}, isDb).values;
    expect(v.value).toBe("postgres://u@db.example.com/x");
  });

  it("knows which files an app may load", () => {
    for (const n of [".env", ".env.local", ".env.development.local", ".env.test", ".env.staging", ".envrc"]) expect(isAppEnvFile(n), n).toBe(true);
    for (const n of [".env.example", ".env.sample", ".env.template", ".env.vault", ".env.bak", ".env.production-backup", ".environment"]) expect(isAppEnvFile(n), n).toBe(false);
  });
});
