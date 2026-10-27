// Second security review of the capture safety guard (decisions #27): each probe from the review
// is a test here. Opt-ins are bound to what a setting points at (ignoreEnv, allowLivePayments),
// malformed URLs show nothing, more database settings are recognised, throwaway opt-ins can name
// one database and Neon/Supabase routing options, and local addresses carry a tunnel note.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkDatabase } from "../../src/doctor/checks.js";
import { fingerprint } from "../../src/safety/classify.js";
import { checkAppDatabase, checkOutbound, resetAppDatabaseWarnings } from "../../src/safety/index.js";

const PASSWORD = "s3cr3t-Pa55word";
const BRANCH = "ep-capture-111111.ap-southeast-2.aws.neon.tech";
const PROD = "ep-prod-222222.ap-southeast-2.aws.neon.tech";
const neon = (host: string, extra = "") => `postgresql://owner:${PASSWORD}@${host}/neondb?sslmode=require${extra}`;
const LOCAL_URL = "postgresql://demo@127.0.0.1:55432/demo";
const POOLER = "aws-0-us-east-1.pooler.supabase.com";

const dirs: string[] = [];
beforeEach(() => resetAppDatabaseWarnings());
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function appWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-review-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}
function all(x: unknown): string {
  return JSON.stringify(x);
}

describe("ignoreEnv is bound to what the setting points at (finding 1)", () => {
  it("refuses again when the ignored setting is changed to another database, showing the new entry", async () => {
    const dir = appWith({ ".env": `DATABASE_URL=${neon(BRANCH)}\n` });
    const database = { url: LOCAL_URL, ignoreEnv: [`.env:DATABASE_URL@${BRANCH}`] };
    expect((await checkAppDatabase({ config: { app: { dir, database } }, env: {} })).status).toBe("local");

    writeFileSync(join(dir, ".env"), `DATABASE_URL=${neon(PROD)}\n`);
    const check = await checkAppDatabase({ config: { app: { dir, database } }, env: {} });
    expect(check.status).toBe("remote");
    expect(check.refuse).toBe(true);
    const text = check.suggestions.join("\n");
    expect(text).toContain(`app.database.ignoreEnv lists ".env:DATABASE_URL@${BRANCH}", but .env:DATABASE_URL now points at ${PROD}/neondb, a different database`);
    expect(text).toContain(`list it as ".env:DATABASE_URL#${fingerprint(PROD)}" instead`);
    expect(all(check)).not.toContain(PASSWORD);
  });

  it("accepts the fingerprint form, so a public config doesn't publish the hostname", async () => {
    const dir = appWith({ ".env": `DATABASE_URL=${neon(PROD)}\n` });
    const ok = await checkAppDatabase({ config: { app: { dir, database: { url: LOCAL_URL, ignoreEnv: [`.env:DATABASE_URL#${fingerprint(PROD)}`] } } }, env: {} });
    expect(ok.status).toBe("local");
    expect(ok.ignoredEnv).toEqual([".env:DATABASE_URL"]);
    const wrong = await checkAppDatabase({ config: { app: { dir, database: { url: LOCAL_URL, ignoreEnv: [`.env:DATABASE_URL#${fingerprint(BRANCH)}`] } } }, env: {} });
    expect(wrong.status).toBe("remote");
  });

  it("a name-only entry doesn't apply, and says which entry to use", async () => {
    const dir = appWith({ ".env": `DATABASE_URL=${neon(PROD)}\n` });
    const check = await checkAppDatabase({ config: { app: { dir, database: { url: LOCAL_URL, ignoreEnv: [".env:DATABASE_URL"] } } }, env: {} });
    expect(check.status).toBe("remote");
    expect(check.suggestions.join(" ")).toContain(
      `app.database.ignoreEnv lists ".env:DATABASE_URL" without saying which database it points at, so it doesn't apply`,
    );
    expect(check.suggestions.join(" ")).toContain(`".env:DATABASE_URL#${fingerprint(PROD)}"`);
  });

  it("binds shared hosts to user@host", async () => {
    const url = `postgresql://postgres.abcdref:${PASSWORD}@${POOLER}:6543/postgres`;
    const config = (entry: string) => ({ app: { database: { url: LOCAL_URL, ignoreEnv: [entry] } } });
    expect((await checkAppDatabase({ config: config(`process.env:DATABASE_URL@postgres.abcdref@${POOLER}`), env: { DATABASE_URL: url } })).status).toBe("local");
    expect((await checkAppDatabase({ config: config(`process.env:DATABASE_URL@postgres.other@${POOLER}`), env: { DATABASE_URL: url } })).status).toBe("remote");
    expect((await checkAppDatabase({ config: config(`process.env:DATABASE_URL@${POOLER}`), env: { DATABASE_URL: url } })).status).toBe("remote");
  });

  it("an unreadable setting can't be ignored: there's nothing to bind the entry to", async () => {
    const check = await checkAppDatabase({
      config: { app: { database: { url: LOCAL_URL, ignoreEnv: ["process.env:DATABASE_URL#0123456789"] } } },
      env: { DATABASE_URL: "postgres://u:p@${MISSING_HOST}/db" },
    });
    expect(check.status).toBe("unreadable");
    expect(check.suggestions.join(" ")).toMatch(/can't read where process\.env\.DATABASE_URL points .* can't be bound to a database/);
  });
});

describe("allowLivePayments is bound to the key (finding 1)", () => {
  it("refuses a different key in an allowed setting, showing only the new fingerprint", () => {
    const dir = appWith({ ".env.local": "STRIPE_SECRET_KEY=sk_live_firstKEY123\n" });
    const entry = `.env.local:STRIPE_SECRET_KEY#${fingerprint("sk_live_firstKEY123")}`;
    expect(checkOutbound({ config: { app: { dir, allowLivePayments: [entry] } }, env: {} }).refusal).toBe("");

    writeFileSync(join(dir, ".env.local"), "STRIPE_SECRET_KEY=sk_live_secondKEY456\n");
    const again = checkOutbound({ config: { app: { dir, allowLivePayments: [entry] } }, env: {} });
    expect(again.refusal).toMatch(/LIVE Stripe key/);
    const text = again.refusalSuggestions.join(" ");
    expect(text).toContain(`app.allowLivePayments lists "${entry}", but .env.local:STRIPE_SECRET_KEY now holds a different live key`);
    expect(text).toContain(`".env.local:STRIPE_SECRET_KEY#${fingerprint("sk_live_secondKEY456")}"`);
    expect(all(again)).not.toContain("secondKEY456");
    expect(all(again)).not.toContain("firstKEY123");
  });

  it("a name-only entry doesn't apply", () => {
    const check = checkOutbound({ config: { app: { allowLivePayments: ["process.env:STRIPE_SECRET_KEY"] } }, env: { STRIPE_SECRET_KEY: "sk_live_abcDEF" } });
    expect(check.refusal).not.toBe("");
    expect(check.refusalSuggestions[0]).toMatch(/without the key's fingerprint, so it doesn't apply/);
  });

  it("finds a live key inside a JSON value (finding 3)", () => {
    const check = checkOutbound({ env: { PAYMENTS_CONFIG: '{"publishable":"pk_live_x","secret":"sk_live_jsonKEY789"}' } });
    expect(check.livePayments).toBe(true);
    expect(check.findings[0]).toMatchObject({ variable: "PAYMENTS_CONFIG", live: true, fingerprint: fingerprint("sk_live_jsonKEY789") });
    expect(all(check)).not.toContain("jsonKEY789");
  });
});

describe("malformed URLs show no password fragments (finding 2)", () => {
  it.each([
    ["postgres://admin:2024/HunterPass@db.mycorp.com/app", ["HunterPass", "2024"]],
    ["postgres://admin:Sup3r@Secr3t/x@host.example.com/app", ["Secr3t", "secr3t", "Sup3r"]],
  ])("%s is unreadable in the message, --json and doctor", async (url, fragments) => {
    const check = await checkAppDatabase({ env: { DATABASE_URL: url } });
    expect(check.status).toBe("unreadable");
    expect(check.refuse).toBe(true);
    expect(check.findings[0].host).toBeUndefined();
    expect(check.findings[0].database).toBeUndefined();
    const out = all(check) + all(checkDatabase(check));
    for (const f of fragments) expect(out).not.toContain(f);
  });
});

describe("recognition gaps (finding 3)", () => {
  it.each([
    ["DB_SERVER", "tcp:prod-sql.database.windows.net,1433", "prod-sql.database.windows.net"],
    ["DATABASE_SERVER", "prod.mycorp.com", "prod.mycorp.com"],
    ["DB_HOST", "prod.mycorp.com", "prod.mycorp.com"],
    ["PGHOSTADDR", "10.1.2.3", "10.1.2.3"],
    ["REDIS_URL", `rediss://default:${PASSWORD}@eu1-clever-cat-123.upstash.io:6379`, "eu1-clever-cat-123.upstash.io"],
    ["KV_URL", `rediss://default:${PASSWORD}@eu1-clever-cat-123.upstash.io:6379`, "eu1-clever-cat-123.upstash.io"],
    ["UPSTASH_REDIS_REST_URL", "https://eu1-clever-cat-123.upstash.io", "eu1-clever-cat-123.upstash.io"],
    ["CACHE_CONNECTION", `redis://u:${PASSWORD}@redis-1234.c1.us-east-1-2.ec2.redns.redis-cloud.com:12345`, "redis-1234.c1.us-east-1-2.ec2.redns.redis-cloud.com"],
    ["POCKETBASE_URL", "https://myapp.pockethost.io", "myapp.pockethost.io"],
    ["PB_URL", "https://pb.mycorp.com", "pb.mycorp.com"],
    ["NEXT_PUBLIC_POCKETBASE_URL", "https://myapp.pockethost.io", "myapp.pockethost.io"],
    ["APPWRITE_ENDPOINT", "https://appwrite.mycorp.com/v1", "appwrite.mycorp.com"],
    ["SOME_ENDPOINT", "https://fra.cloud.appwrite.io/v1", "fra.cloud.appwrite.io"],
    ["FIREBASE_CONFIG", `{"apiKey":"AIza${PASSWORD}","authDomain":"myapp-prod.firebaseapp.com","projectId":"myapp-prod"}`, "myapp-prod.firebaseapp.com"],
    ["APP_SETTINGS", `{"apiKey":"AIza${PASSWORD}","projectId":"myapp-prod"}`, "myapp-prod.firebaseapp.com"],
    ["APP_SETTINGS", `{"apiKey":"AIza${PASSWORD}","databaseURL":"https://myapp-default-rtdb.firebaseio.com"}`, "myapp-default-rtdb.firebaseio.com"],
  ])("%s=%s refuses", async (name, value, host) => {
    const check = await checkAppDatabase({ env: { [name]: value } });
    expect(check.status, name).toBe("remote");
    expect(check.findings[0].host).toBe(host);
    expect(all(check)).not.toContain(PASSWORD);
  });

  it.each([
    ["DB_SERVER", "localhost,1433"],
    ["PGHOSTADDR", "127.0.0.1"],
    ["REDIS_URL", "redis://localhost:6379"],
    ["PB_URL", "http://127.0.0.1:8090"],
    ["APPWRITE_ENDPOINT", "http://localhost/v1"],
    ["FIREBASE_CONFIG", '{"apiKey":"fake","projectId":"demo-capture"}'],
  ])("%s=%s is local", async (name, value) => {
    expect((await checkAppDatabase({ env: { [name]: value } })).status, name).toBe("local");
  });

  it("binds Appwrite Cloud (a shared host) to the project next to the endpoint", async () => {
    const env = { APPWRITE_ENDPOINT: "https://cloud.appwrite.io/v1", APPWRITE_PROJECT_ID: "prodproject" };
    const check = await checkAppDatabase({ env });
    expect(check.status).toBe("remote");
    expect(check.message).toContain('"prodproject@cloud.appwrite.io"');
    expect((await checkAppDatabase({ config: { app: { database: { throwaway: "cloud.appwrite.io" } } }, env })).status).toBe("remote");
    expect((await checkAppDatabase({ config: { app: { database: { throwaway: "prodproject@cloud.appwrite.io" } } }, env })).status).toBe("throwaway");
    const unbound = await checkAppDatabase({ env: { APPWRITE_ENDPOINT: "https://cloud.appwrite.io/v1" } });
    expect(unbound.suggestions.join(" ")).toMatch(/no opt-in can cover it/);
  });

  it("reads wrangler's .dev.vars like an env file", async () => {
    const dir = appWith({ ".dev.vars": `DATABASE_URL=${neon(PROD)}\n`, ".dev.vars.staging": `DB_URL=${neon(BRANCH)}\n` });
    const check = await checkAppDatabase({ config: { app: { dir } }, env: {} });
    expect(check.status).toBe("remote");
    expect(check.findings.map((f) => f.source).sort()).toEqual([".dev.vars.staging:DB_URL", ".dev.vars:DATABASE_URL"]);
  });

  describe("secrets injected at run time", () => {
    it("refuses an app with doppler.yaml, and accepts the explicit, bound acknowledgement", async () => {
      const dir = appWith({ "doppler.yaml": "setup:\n  project: myapp\n  config: dev\n", ".env": "DATABASE_URL=postgres://u@localhost/app\n" });
      const check = await checkAppDatabase({ config: { app: { dir } }, env: {} });
      expect(check.status).toBe("unreadable");
      expect(check.refuse).toBe(true);
      expect(check.findings.find((f) => f.source === "doppler.yaml")).toMatchObject({ from: "secrets-manager", status: "unreadable" });
      expect(check.message).toMatch(/secrets are injected at run time \(doppler\.yaml, Doppler\); aida can't see the database/);
      const entry = check.suggestions.join(" ").match(/"(doppler\.yaml#[0-9a-f]{10})"/)?.[1];
      expect(check.suggestions.join(" ")).toMatch(/Secrets are injected at run time; aida can't see the database\. Set app\.database\.url .* without `doppler run`/);
      expect(entry).toBeDefined();

      // The acknowledgement needs app.database.url too.
      const noUrl = await checkAppDatabase({ config: { app: { dir, database: { ignoreEnv: [entry!] } } }, env: {} });
      expect(noUrl.refuse).toBe(true);
      const acked = await checkAppDatabase({ config: { app: { dir, database: { url: LOCAL_URL, ignoreEnv: [entry!] } } }, env: {} });
      expect(acked.status).toBe("local");

      // Switching to another Doppler config refuses again.
      writeFileSync(join(dir, "doppler.yaml"), "setup:\n  project: myapp\n  config: prd\n");
      const switched = await checkAppDatabase({ config: { app: { dir, database: { url: LOCAL_URL, ignoreEnv: [entry!] } } }, env: {} });
      expect(switched.refuse).toBe(true);
      expect(switched.suggestions.join(" ")).toMatch(/now points at secrets Doppler injects at run time, a different database/);
    });

    it("refuses .infisical.json", async () => {
      const dir = appWith({ ".infisical.json": '{"workspaceId":"abc","defaultEnvironment":"prod"}' });
      const check = await checkAppDatabase({ config: { app: { dir } }, env: {} });
      expect(check.refuse).toBe(true);
      expect(check.suggestions.join(" ")).toMatch(/`infisical run`/);
    });

    it("refuses an op:// database setting, binds the acknowledgement to the reference, and ignores op:// keys", async () => {
      const dir = appWith({ ".env": "DATABASE_URL=op://Prod/main-db/url\nSTRIPE_SECRET_KEY=op://Prod/stripe/key\n" });
      const check = await checkAppDatabase({ config: { app: { dir } }, env: {} });
      expect(check.status).toBe("unreadable");
      expect(check.findings.map((f) => f.source)).toEqual([".env:DATABASE_URL"]);
      expect(check.suggestions.join(" ")).toMatch(/without `op run`/);
      expect(all(check)).not.toContain("main-db");
      const entry = `.env:DATABASE_URL#${fingerprint("op://Prod/main-db/url")}`;
      expect(check.suggestions.join(" ")).toContain(entry);
      expect((await checkAppDatabase({ config: { app: { dir, database: { url: LOCAL_URL, ignoreEnv: [entry] } } }, env: {} })).status).toBe("local");
    });
  });
});

describe("throwaway opt-ins can name one database and routing options (finding 4)", () => {
  it("host/database must match the database", async () => {
    const url = (db: string) => `postgres://app:${PASSWORD}@db.mycorp.com/${db}`;
    const staging = { app: { database: { throwaway: "db.mycorp.com/staging" } } };
    expect((await checkAppDatabase({ config: staging, env: { DATABASE_URL: url("staging") } })).status).toBe("throwaway");
    expect((await checkAppDatabase({ config: staging, env: { DATABASE_URL: url("production") } })).status).toBe("remote");
  });

  it("a host-only opt-in covering several databases on that host covers none, and suggests host/database", async () => {
    const check = await checkAppDatabase({
      config: { app: { database: { throwaway: "db.mycorp.com" } } },
      env: { DATABASE_URL: `postgres://app:${PASSWORD}@db.mycorp.com/staging`, REPORTS_DATABASE_URL: `postgres://app:${PASSWORD}@db.mycorp.com/production` },
    });
    expect(check.status).toBe("remote");
    expect(check.throwawayHosts).toEqual([]);
    const text = check.suggestions.join(" ");
    expect(text).toMatch(/Ignoring throwaway "db\.mycorp\.com": that host serves several databases here \(staging and production\)/);
    expect(text).toContain('throwaway: ["db.mycorp.com/staging", "db.mycorp.com/production"]');
  });

  it.each([
    ["options=endpoint%3Dep-prod-222222", "endpoint=ep-prod-222222"],
    ["options=project%3Dep-prod-222222", "endpoint=ep-prod-222222"],
    ["options=endpoint%3Dep-prod-222222%20-c%20search_path%3Dapp", "endpoint=ep-prod-222222"],
  ])("Neon ?%s is part of the identity", async (param, route) => {
    const env = { DATABASE_URL: neon(BRANCH, `&${param}`) };
    const check = await checkAppDatabase({ config: { app: { database: { throwaway: BRANCH } } }, env });
    expect(check.status).toBe("remote");
    expect(check.message).toContain(`"${BRANCH}?${route}"`);
    expect((await checkAppDatabase({ config: { app: { database: { throwaway: `${BRANCH}?${route}` } } }, env })).status).toBe("throwaway");
  });

  it("Neon's endpoint=<id>$ password prefix is part of the identity, and the password isn't shown", async () => {
    for (const sep of ["$", ";"]) {
      const env = { DATABASE_URL: `postgresql://owner:endpoint=ep-prod-222222${sep}${PASSWORD}@${BRANCH}/neondb` };
      const check = await checkAppDatabase({ config: { app: { database: { throwaway: BRANCH } } }, env });
      expect(check.status, sep).toBe("remote");
      expect(check.message).toContain(`"${BRANCH}?endpoint=ep-prod-222222"`);
      expect(all(check)).not.toContain(PASSWORD);
    }
  });

  it("a Supabase pooler ?options=reference= for another project isn't covered", async () => {
    const env = { DATABASE_URL: `postgresql://postgres.abcdref:${PASSWORD}@${POOLER}:6543/postgres?options=reference%3Dprodref` };
    const check = await checkAppDatabase({ config: { app: { database: { throwaway: `postgres.abcdref@${POOLER}` } } }, env });
    expect(check.status).toBe("remote");
    expect(check.message).toContain(`"postgres.abcdref@${POOLER}?reference=prodref"`);
  });

  it("an ignoreEnv binding includes the routing option", async () => {
    const env = { DATABASE_URL: neon(BRANCH, "&options=endpoint%3Dep-prod-222222") };
    const check = await checkAppDatabase({ config: { app: { database: { url: LOCAL_URL, ignoreEnv: [`process.env:DATABASE_URL@${BRANCH}`] } } }, env });
    expect(check.status).toBe("remote");
  });

  it("accepts a #fingerprint throwaway entry", async () => {
    const check = await checkAppDatabase({ config: { app: { database: { throwaway: `#${fingerprint(BRANCH)}` } } }, env: { DATABASE_URL: neon(BRANCH) } });
    expect(check.status).toBe("throwaway");
  });
});

describe("local addresses may be tunnels (finding 5)", () => {
  it("says so on a local result and in doctor", async () => {
    const check = await checkAppDatabase({ env: { DATABASE_URL: "postgres://u@127.0.0.1:5432/app" } });
    expect(check.status).toBe("local");
    expect(check.message).toContain("Local address: if this is a tunnel or proxy to a hosted database, it isn't safe.");
    expect(checkDatabase(check).detail).toContain("if this is a tunnel or proxy to a hosted database, it isn't safe");
    // Not for a local file or socket.
    expect((await checkAppDatabase({ env: { DATABASE_URL: "file:./dev.db" } })).message).not.toContain("tunnel");
  });

  it("warns on a known proxy port", async () => {
    const check = await checkAppDatabase({ env: { DATABASE_URL: "postgres://u@localhost:15432/app" } });
    expect(check.status).toBe("local");
    expect(check.warnings.join(" ")).toMatch(/process\.env\.DATABASE_URL uses port 15432 on this machine, the port `fly proxy` examples use/);
    expect(checkDatabase(check).status).toBe("warn");
  });

  it("warns when an env file mentions cloud-sql-proxy or pscale", async () => {
    const dir = appWith({ ".env": "# run `cloud-sql-proxy myproj:region:db` first\nDATABASE_URL=postgres://u@127.0.0.1:5432/app\n", ".env.local": "# pscale connect mydb main\n" });
    const check = await checkAppDatabase({ config: { app: { dir } }, env: {} });
    expect(check.status).toBe("local");
    const text = check.warnings.join(" ");
    expect(text).toContain(".env mentions cloud-sql-proxy");
    expect(text).toContain(".env.local mentions pscale connect");
    expect(checkDatabase(check).status).toBe("warn");
  });
});
