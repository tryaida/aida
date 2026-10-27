import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AppDatabaseRefusedError,
  assertAppDatabaseSafe,
  checkAppDatabase,
  resetAppDatabaseWarnings,
  resolveAppDir,
} from "../../src/safety/index.js";
import { fingerprint } from "../../src/safety/classify.js";

const PASSWORD = "s3cr3t-Pa55word";
const NEON = "ep-cool-darkness-123456.us-east-2.aws.neon.tech";
const NEON_URL = `postgresql://neondb_owner:${PASSWORD}@${NEON}/neondb?sslmode=require`;
const BRANCH = "ep-throwaway-999999.us-east-2.aws.neon.tech";

const dirs: string[] = [];
beforeEach(() => resetAppDatabaseWarnings());
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-safety-db-"));
  dirs.push(dir);
  return dir;
}
function appWith(files: Record<string, string>): string {
  const dir = tmp();
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

describe("checkAppDatabase sources", () => {
  it("reads the app's .env.local and refuses a live Neon database", async () => {
    const dir = appWith({ ".env.local": `DATABASE_URL="${NEON_URL}"\n` });
    const check = await checkAppDatabase({ config: { app: { dir } }, env: {} });
    expect(check.status).toBe("remote");
    expect(check.findings).toEqual([
      expect.objectContaining({ source: ".env.local:DATABASE_URL", variable: "DATABASE_URL", host: NEON, database: "neondb", provider: "Neon", status: "remote" }),
    ]);
    expect(check.message).toMatch(/Neon database: create a Neon branch/);
    expect(check.message).toContain(`app.database.throwaway: "${NEON}"`);
  });

  it("is local for a localhost database", async () => {
    const dir = appWith({ ".env": "DATABASE_URL=postgres://postgres:postgres@localhost:5432/app\n" });
    const check = await checkAppDatabase({ config: { app: { dir } }, env: {} });
    expect(check.status).toBe("local");
    expect(check.message).toContain(".env:DATABASE_URL: localhost:5432/app");
  });

  it("is unknown (and doesn't refuse) when nothing is found", async () => {
    const check = await checkAppDatabase({ config: { app: { dir: tmp() } }, env: {} });
    expect(check.status).toBe("unknown");
    const warnings: string[] = [];
    assertAppDatabaseSafe(check, (m) => warnings.push(m));
    assertAppDatabaseSafe(check, (m) => warnings.push(m));
    expect(warnings).toHaveLength(1); // once per process
    expect(warnings[0]).toMatch(/couldn't find the app's database setting/);
  });

  it("checks the env file value even when process.env has the same variable (finding 5)", async () => {
    const dir = appWith({ ".env.local": `DATABASE_URL=${NEON_URL}\n` });
    const check = await checkAppDatabase({ config: { app: { dir } }, env: { DATABASE_URL: "postgres://u@127.0.0.1:5432/ci" } });
    expect(check.status).toBe("remote");
    expect(check.refuse).toBe(true);
    expect(check.findings.map((f) => `${f.source}=${f.status}`)).toEqual(["process.env.DATABASE_URL=local", ".env.local:DATABASE_URL=remote"]);
  });

  it("an empty process.env value hides nothing (finding 5)", async () => {
    const dir = appWith({ ".env": `DATABASE_URL=${NEON_URL}\n` });
    const check = await checkAppDatabase({ config: { app: { dir } }, env: { DATABASE_URL: "" } });
    expect(check.status).toBe("remote");
  });

  it("process.env alone is checked (CI)", async () => {
    const check = await checkAppDatabase({ env: { POSTGRES_URL: NEON_URL } });
    expect(check.status).toBe("remote");
    expect(check.findings[0].source).toBe("process.env.POSTGRES_URL");
  });

  it("refuses a remote value in any env file, whatever the precedence (finding 4)", async () => {
    // Vite: .env.development beats .env.local, so the Neon value is what `vite` uses.
    const dir = appWith({ ".env.local": "DATABASE_URL=postgres://u@localhost/app\n", ".env.development": `DATABASE_URL=${NEON_URL}\n` });
    const check = await checkAppDatabase({ config: { app: { dir } }, env: {} });
    expect(check.status).toBe("remote");
    expect(check.message).toContain(".env.development:DATABASE_URL points at");
  });

  it("reads a monorepo's root .env, up to the git root (finding 2)", async () => {
    const root = appWith({ ".env": `DATABASE_URL=${NEON_URL}\n` });
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    const app = join(root, "apps", "web");
    mkdirSync(app, { recursive: true });
    const check = await checkAppDatabase({ config: { app: { dir: app } }, env: {} });
    expect(check.status).toBe("remote");
    expect(check.findings[0].source).toBe("../../.env:DATABASE_URL");
  });

  it("explicit app.database.url doesn't switch off the env files (finding 1)", async () => {
    const dir = appWith({ ".env": `DATABASE_URL=${NEON_URL}\n` });
    const check = await checkAppDatabase({
      config: { app: { dir, database: { url: "postgresql://demo@127.0.0.1:55432/demo" } } },
      env: {},
    });
    expect(check.status).toBe("remote");
    expect(check.findings.map((f) => `${f.source}=${f.status}`)).toEqual(["config app.database.url=local", ".env:DATABASE_URL=remote"]);
    expect(check.message).toMatch(/aida.config sets app.database.url, but if the app is started the normal way .* it reads \.env:DATABASE_URL/);
    const all = check.suggestions.join("\n");
    expect(all).toContain(`ignoreEnv: ".env:DATABASE_URL#${fingerprint(NEON)}"`);
    expect(all).toMatch(/after # is a fingerprint of its host/);
    expect(all).toMatch(/Only if the server you capture against is started with app.database.url/);
  });

  it("app.database.ignoreEnv acknowledges exactly the listed settings (finding 1)", async () => {
    const dir = appWith({ ".env": `DATABASE_URL=${NEON_URL}\nDATABASE_URL_DIRECT=${NEON_URL}\n` });
    const database = { url: "postgresql://demo@127.0.0.1:55432/demo", ignoreEnv: [`.env:DATABASE_URL#${fingerprint(NEON)}`, `.env:DATABASE_URL_DIRECT@${NEON}`] };
    const ok = await checkAppDatabase({ config: { app: { dir, database } }, env: {} });
    expect(ok.status).toBe("local");
    expect(ok.refuse).toBe(false);
    expect(ok.ignoredEnv).toEqual([".env:DATABASE_URL", ".env:DATABASE_URL_DIRECT"]);
    expect(ok.findings.filter((f) => f.ignored).map((f) => f.source)).toEqual([".env:DATABASE_URL", ".env:DATABASE_URL_DIRECT"]);
    expect(ok.message).toContain("Not counted (app.database.ignoreEnv)");

    // A new file holding a remote value refuses again.
    writeFileSync(join(dir, ".env.local"), `DATABASE_URL=${NEON_URL}\n`);
    const newFile = await checkAppDatabase({ config: { app: { dir, database } }, env: {} });
    expect(newFile.status).toBe("remote");
    expect(newFile.message).toContain(".env.local:DATABASE_URL");

    // So does a new variable in the same file, and a process.env value.
    const newVar = await checkAppDatabase({ config: { app: { dir, database } }, env: { DIRECT_URL: NEON_URL } });
    expect(newVar.status).toBe("remote");
  });

  it("ignoreEnv without app.database.url doesn't apply, and says why", async () => {
    const dir = appWith({ ".env": `DATABASE_URL=${NEON_URL}\n` });
    const check = await checkAppDatabase({ config: { app: { dir, database: { ignoreEnv: [".env:DATABASE_URL"] } } }, env: {} });
    expect(check.status).toBe("remote");
    expect(check.suggestions.join(" ")).toMatch(/ignoreEnv: it only applies together with app.database.url/);
  });

  it("ignoreEnv accepts process.env:VARIABLE", async () => {
    const check = await checkAppDatabase({
      config: { app: { database: { url: "postgres://u@localhost/app", ignoreEnv: [`process.env:DATABASE_URL#${fingerprint(NEON)}`] } } },
      env: { DATABASE_URL: NEON_URL },
    });
    expect(check.status).toBe("local");
  });

  it("app.database.url may be a function (sync or async)", async () => {
    const check = await checkAppDatabase({ config: { app: { database: { url: async () => NEON_URL } } }, env: {} });
    expect(check.status).toBe("remote");
    expect(check.findings[0].source).toBe("config app.database.url");
  });

  it("a throwing app.database.url function fails without repeating its message", async () => {
    await expect(
      checkAppDatabase({ config: { app: { database: { url: () => { throw new Error(NEON_URL); } } } }, env: {} }),
    ).rejects.toThrow(/app.database.url in aida.config threw an error/);
    await checkAppDatabase({ config: { app: { database: { url: () => { throw new Error(NEON_URL); } } } }, env: {} }).catch((e: Error) => {
      expect(e.message).not.toContain(PASSWORD);
    });
  });

  it("an unresolved ${VAR} host refuses: couldn't read (finding 2)", async () => {
    const dir = appWith({ ".env": "DATABASE_URL=postgres://u:p@${DB_HOST}/app\n" });
    const check = await checkAppDatabase({ config: { app: { dir } }, env: {} });
    expect(check.status).toBe("unreadable");
    expect(check.refuse).toBe(true);
    expect(check.message).toMatch(/Refusing to capture: aida couldn't read where \.env:DATABASE_URL points/);
    expect(() => assertAppDatabaseSafe(check, () => {})).toThrow(AppDatabaseRefusedError);
  });

  it("an unparsable database setting refuses: couldn't read", async () => {
    const check = await checkAppDatabase({ env: { DATABASE_URL: "not a url at all" } });
    expect(check.status).toBe("unreadable");
    expect(check.refuse).toBe(true);
  });

  it("checks name patterns: *DATABASE_URL, DATABASE_URL_*, *_DB_URL, Supabase", async () => {
    for (const name of ["SHADOW_DATABASE_URL", "DATABASE_URL_DIRECT", "ANALYTICS_DB_URL", "NEXT_PUBLIC_SUPABASE_URL"]) {
      const check = await checkAppDatabase({ env: { [name]: name.includes("SUPABASE") ? "https://abc.supabase.co" : NEON_URL } });
      expect(check.status, name).toBe("remote");
    }
  });

  // Reviewer probes for finding 2: each landed on "unknown" (a warning) before.
  it.each([
    ["DB_URL", NEON_URL],
    ["VITE_SUPABASE_URL", "https://abcdref.supabase.co"],
    ["PUBLIC_SUPABASE_URL", "https://abcdref.supabase.co"],
    ["EXPO_PUBLIC_SUPABASE_URL", "https://abcdref.supabase.co"],
    ["PG_CONNECTION", "host=prod.example.com port=5432 user=app dbname=main"],
    ["DATABASE_HOST", "aws.connect.psdb.cloud"],
    ["CONVEX_URL", "https://happy-animal-123.convex.cloud"],
    ["NEXT_PUBLIC_CONVEX_URL", "https://happy-animal-123.convex.cloud"],
    ["NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN", "myapp.firebaseapp.com"],
    ["FIREBASE_DATABASE_URL", "https://myapp-default-rtdb.firebaseio.com"],
    ["NEXT_PUBLIC_FIREBASE_PROJECT_ID", "myapp-prod"],
    ["SOME_URL", NEON_URL],
    ["APP_STORE", `mysql://u:${PASSWORD}@h.example.com/db`],
  ])("%s refuses", async (name, value) => {
    const check = await checkAppDatabase({ env: { [name]: value } });
    expect(check.status, name).toBe("remote");
    expect(JSON.stringify(check)).not.toContain(PASSWORD);
  });

  it("is local for local Convex, Supabase and Firebase emulator settings", async () => {
    const check = await checkAppDatabase({
      env: { CONVEX_URL: "http://127.0.0.1:3210", VITE_SUPABASE_URL: "http://127.0.0.1:54321", FIREBASE_PROJECT_ID: "demo-test" },
    });
    expect(check.status).toBe("local");
  });

  it("stays a warning only when nothing database-like is found", async () => {
    const check = await checkAppDatabase({ env: { SOME_URL: "https://example.com", PORT: "3000" } });
    expect(check.status).toBe("unknown");
    expect(check.refuse).toBe(false);
  });

  it("refuses a single-label host, suggesting the opt-in for a docker-compose service (finding 7)", async () => {
    const compose = await checkAppDatabase({ env: { DATABASE_URL: "postgres://u:p@db:5432/app" } });
    expect(compose.status).toBe("remote");
    expect(compose.suggestions.join(" ")).toMatch(/"db" looks like a docker-compose service\. If it runs on this machine, opt it in: app: \{ database: \{ throwaway: "db" \} \}/);
    const vpn = await checkAppDatabase({ env: { DATABASE_URL: "postgres://u:p@prod-db/app" } });
    expect(vpn.status).toBe("remote");
    expect(vpn.suggestions.join(" ")).toMatch(/"prod-db" has no domain, so it may be a machine on your network or VPN/);
    const optedIn = await checkAppDatabase({ config: { app: { database: { throwaway: "db" } } }, env: { DATABASE_URL: "postgres://u:p@db:5432/app" } });
    expect(optedIn.status).toBe("throwaway");
  });

  it("checks both the URL host and ?host= (finding 6)", async () => {
    const check = await checkAppDatabase({ env: { DATABASE_URL: `postgres://u:${PASSWORD}@${NEON}/db?host=localhost` } });
    expect(check.status).toBe("remote");
    expect(check.message).toContain(NEON);
  });

  it("splits Mongo host lists; every host must be local or opted in, and the suggestion lists each (finding 10)", async () => {
    const check = await checkAppDatabase({ env: { MONGODB_URI: "mongodb://localhost,db2/app" } });
    expect(check.status).toBe("remote");
    const both = await checkAppDatabase({ env: { MONGODB_URI: "mongodb://a.example.com:27017,b.example.com:27017/app" } });
    expect(both.message).toContain('app.database.throwaway: ["a.example.com", "b.example.com"]');
    const half = await checkAppDatabase({ config: { app: { database: { throwaway: "a.example.com" } } }, env: { MONGODB_URI: "mongodb://a.example.com:27017,b.example.com:27017/app" } });
    expect(half.status).toBe("remote");
    const all = await checkAppDatabase({ config: { app: { database: { throwaway: ["a.example.com", "b.example.com"] } } }, env: { MONGODB_URI: "mongodb://a.example.com:27017,b.example.com:27017/app" } });
    expect(all.status).toBe("throwaway");
  });
});

describe("throwaway opt-in", () => {
  it("allows exactly the named host, case-insensitively", async () => {
    const url = `postgresql://u:${PASSWORD}@${BRANCH}/neondb`;
    const check = await checkAppDatabase({ config: { app: { database: { url, throwaway: BRANCH.toUpperCase() } } }, env: {} });
    expect(check.status).toBe("throwaway");
    expect(() => assertAppDatabaseSafe(check, () => {})).not.toThrow();
  });

  it("never carries over: the env pointing back at main is refused again", async () => {
    const config = { app: { database: { throwaway: [BRANCH] } } };
    const check = await checkAppDatabase({ config, env: { DATABASE_URL: NEON_URL } });
    expect(check.status).toBe("remote");
    expect(() => assertAppDatabaseSafe(check)).toThrow(AppDatabaseRefusedError);
  });

  it("doesn't match on suffix, prefix or wildcard", async () => {
    for (const throwaway of ["neon.tech", "us-east-2.aws.neon.tech", `${NEON}.evil.com`, "*.neon.tech", "ep-cool-darkness-123456"]) {
      const check = await checkAppDatabase({ config: { app: { database: { throwaway } } }, env: { DATABASE_URL: NEON_URL } });
      expect(check.status, throwaway).toBe("remote");
    }
  });

  it("on a shared host, needs user@host; a bare host is rejected with the reason (finding 3)", async () => {
    const POOLER = "aws-0-us-east-1.pooler.supabase.com";
    const url = `postgresql://postgres.abcdref:${PASSWORD}@${POOLER}:6543/postgres`;
    const bare = await checkAppDatabase({ config: { app: { database: { throwaway: POOLER } } }, env: { DATABASE_URL: url } });
    expect(bare.status).toBe("remote");
    expect(bare.suggestions.join(" ")).toMatch(/Ignoring throwaway "aws-0-us-east-1\.pooler\.supabase\.com": many customers' databases share that host/);
    expect(bare.message).toContain(`app.database.throwaway: "postgres.abcdref@${POOLER}"`);
    expect(JSON.stringify(bare)).not.toContain(PASSWORD);

    const other = await checkAppDatabase({ config: { app: { database: { throwaway: `postgres.otherref@${POOLER}` } } }, env: { DATABASE_URL: url } });
    expect(other.status).toBe("remote");
    const bound = await checkAppDatabase({ config: { app: { database: { throwaway: `postgres.abcdref@${POOLER}` } } }, env: { DATABASE_URL: url } });
    expect(bound.status).toBe("throwaway");
  });

  it("binds PlanetScale to the user next to DATABASE_HOST, and Prisma db.prisma.io to the URL user", async () => {
    const dir = appWith({ ".env": "DATABASE_HOST=aws.connect.psdb.cloud\nDATABASE_USERNAME=branchuser\nDATABASE_PASSWORD=pscale_pw_x\n" });
    const ps = await checkAppDatabase({ config: { app: { dir } }, env: {} });
    expect(ps.message).toContain('"branchuser@aws.connect.psdb.cloud"');
    expect(JSON.stringify(ps)).not.toContain("pscale_pw_x");
    const psOk = await checkAppDatabase({ config: { app: { dir, database: { throwaway: "branchuser@aws.connect.psdb.cloud" } } }, env: {} });
    expect(psOk.status).toBe("throwaway");
    const prisma = await checkAppDatabase({ config: { app: { database: { throwaway: "db.prisma.io" } } }, env: { DATABASE_URL: `postgres://abc123:${PASSWORD}@db.prisma.io:5432/postgres` } });
    expect(prisma.status).toBe("remote");
    expect(prisma.message).toContain('"abc123@db.prisma.io"');
  });

  it("a shared host with no user can't be opted in (Prisma Accelerate)", async () => {
    const check = await checkAppDatabase({
      config: { app: { database: { throwaway: "accelerate.prisma-data.net" } } },
      env: { DATABASE_URL: `prisma://accelerate.prisma-data.net/?api_key=${PASSWORD}` },
    });
    expect(check.status).toBe("remote");
    expect(check.suggestions.join(" ")).toMatch(/doesn't name a user, so aida can't tell which project it is and no opt-in can cover it/);
    expect(JSON.stringify(check)).not.toContain(PASSWORD);
  });

  it("reads AIDA_THROWAWAY_DATABASE_HOST (comma-separated)", async () => {
    const check = await checkAppDatabase({ env: { DATABASE_URL: NEON_URL, AIDA_THROWAWAY_DATABASE_HOST: ` other.example.com , ${NEON} ` } });
    expect(check.status).toBe("throwaway");
  });

  it("needs every remote setting listed", async () => {
    const check = await checkAppDatabase({
      config: { app: { database: { throwaway: BRANCH } } },
      env: { DATABASE_URL: `postgres://u@${BRANCH}/x`, DIRECT_URL: NEON_URL },
    });
    expect(check.status).toBe("remote");
    expect(check.findings.find((f) => f.variable === "DATABASE_URL")?.status).toBe("throwaway");
  });
});

describe("redaction", () => {
  it("never puts a password, user, token or full URL in findings, messages or JSON", async () => {
    const dir = appWith({
      ".env.local": [
        `DATABASE_URL=${NEON_URL}`,
        `DIRECT_URL=postgres://admin:${PASSWORD}@localhost/app`,
        `TURSO_DATABASE_URL=libsql://app-org.turso.io?authToken=${PASSWORD}`,
        `MONGODB_URI=mongodb://u:${PASSWORD}@a.example.com,b.example.com/db`,
        `SUPABASE_DB_URL=postgres://u:${PASSWORD}@\${MISSING}/db`,
        `POOLER_URL=postgres://postgres.abcdref:${PASSWORD}@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
        `PG_DSN="host=prod.example.com user=admin password=${PASSWORD} dbname=main"`,
        `ACCEL=prisma://accelerate.prisma-data.net/?api_key=${PASSWORD}`,
        `DB_URL=postgres://admin:${PASSWORD}@ep-prod-1.us-east-2.aws.neon.tech/db?host=localhost`,
      ].join("\n"),
    });
    const check = await checkAppDatabase({ config: { app: { dir } }, env: { POSTGRES_URL: `postgres://ci:${PASSWORD}@prod.example.com/x` } });
    let thrown = "";
    try {
      assertAppDatabaseSafe(check, () => {});
    } catch (e) {
      thrown = (e as Error).message;
    }
    const everything = JSON.stringify(check) + thrown;
    expect(thrown).not.toBe("");
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain("neondb_owner");
    expect(everything).not.toContain("admin");
    expect(everything).not.toContain("authToken");
    expect(everything).not.toContain("sslmode");
    expect(everything).not.toContain("postgresql://");
    expect(everything).not.toContain("api_key");
    expect(everything).not.toContain("password=");
  });
});

describe("resolveAppDir", () => {
  it("prefers app.dir, then impact.app, then impact.appRepo, then the config's parent with package.json", () => {
    const root = tmp();
    const help = join(root, "help");
    mkdirSync(help);
    expect(resolveAppDir({ configDir: help })).toBeUndefined();
    writeFileSync(join(root, "package.json"), "{}");
    expect(resolveAppDir({ configDir: help })).toEqual({ dir: root, from: "config parent" });
    expect(resolveAppDir({ configDir: help, impact: { appRepo: "../repo" } })).toEqual({ dir: join(root, "repo"), from: "impact.appRepo" });
    expect(resolveAppDir({ configDir: help, impact: { appRepo: "../repo", app: "apps/web" } })).toEqual({ dir: join(root, "repo", "apps", "web"), from: "impact.app" });
    expect(resolveAppDir({ configDir: help, app: { dir: ".." }, impact: { appRepo: "../repo" } })).toEqual({ dir: root, from: "app.dir" });
  });
});

describe("assertAppDatabaseSafe", () => {
  it("throws plain words with the fixes for a remote database", async () => {
    const check = await checkAppDatabase({ env: { DATABASE_URL: NEON_URL } });
    expect(() => assertAppDatabaseSafe(check)).toThrow(/Refusing to capture: the app's database is not on this machine/);
    try {
      assertAppDatabaseSafe(check);
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toMatch(/local database/);
      expect(message).toMatch(/AIDA_THROWAWAY_DATABASE_HOST/);
    }
  });
});
