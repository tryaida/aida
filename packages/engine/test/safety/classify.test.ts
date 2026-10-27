import { describe, expect, it } from "vitest";
import { classifyDatabaseSetting, classifyHost, isSharedHost, looksLikeDatabaseValue } from "../../src/safety/classify.js";

describe("classifyHost", () => {
  it.each([
    "localhost",
    "LOCALHOST",
    "app.localhost",
    "127.0.0.1",
    "127.1.2.3",
    "::1",
    "[::1]",
    "0.0.0.0",
    "/var/run/postgresql",
    "",
    "host.docker.internal",
  ])("%s is local", (host) => {
    expect(classifyHost(host).kind).toBe("local");
  });

  it.each([
    "localhost.evil.com",
    "127.0.0.1.nip.io",
    "ep-cool-name-123456.us-east-2.aws.neon.tech",
    "db.abcdefgh.supabase.co",
    "10.0.0.5",
    "192.168.1.10",
    "2001:db8::1",
    "/cloudsql/project:region:instance",
    // Single-label names may resolve through /etc/hosts or a VPN (finding 7).
    "db",
    "postgres",
    "prod-db",
  ])("%s is remote", (host) => {
    expect(classifyHost(host).kind).toBe("remote");
  });

  it("notes a single-label host as maybe a docker-compose service, maybe a VPN machine", () => {
    expect(classifyHost("prod-db").note).toMatch(/docker-compose service, or a machine on your network or VPN/);
  });
});

describe("classifyDatabaseSetting", () => {
  it("reads host, port and database name from a URL", () => {
    const r = classifyDatabaseSetting("DATABASE_URL", "postgresql://user:pw@ep-x-123.eu-central-1.aws.neon.tech:5432/neondb?sslmode=require");
    expect(r).toMatchObject({ kind: "remote", hosts: ["ep-x-123.eu-central-1.aws.neon.tech"], port: "5432", database: "neondb", provider: "Neon" });
  });

  it("treats local URLs, sockets and files as local", () => {
    expect(classifyDatabaseSetting("DATABASE_URL", "postgres://u:p@localhost:5432/app").kind).toBe("local");
    expect(classifyDatabaseSetting("DATABASE_URL", "postgres://u@127.0.0.1:55432/app").kind).toBe("local");
    expect(classifyDatabaseSetting("DATABASE_URL", "postgres://u@[::1]:5432/app").kind).toBe("local");
    expect(classifyDatabaseSetting("DATABASE_URL", "postgres:///app").kind).toBe("local");
    expect(classifyDatabaseSetting("DATABASE_URL", "postgres://u@/app?host=/var/run/postgresql").kind).toBe("local");
    expect(classifyDatabaseSetting("DATABASE_URL", "file:./dev.db").kind).toBe("local");
    expect(classifyDatabaseSetting("DATABASE_URL", "./prisma/dev.sqlite").kind).toBe("local");
    expect(classifyDatabaseSetting("TURSO_DATABASE_URL", "libsql://127.0.0.1:8080").kind).toBe("local");
  });

  it("treats a docker-compose service name as remote until opted in", () => {
    expect(classifyDatabaseSetting("DATABASE_URL", "postgres://u:p@db:5432/app")).toMatchObject({ kind: "remote", optIns: ["db"], singleLabelHosts: ["db"] });
    expect(classifyDatabaseSetting("DATABASE_URL", "postgres://u:p@prod-db/app")).toMatchObject({ kind: "remote", singleLabelHosts: ["prod-db"] });
  });

  it("checks both the URL host and a host/hostaddr query param (finding 6)", () => {
    expect(classifyDatabaseSetting("DATABASE_URL", "postgres://u@localhost/app?host=prod.example.com").kind).toBe("remote");
    expect(classifyDatabaseSetting("DATABASE_URL", "postgres://u@localhost/app?hostaddr=203.0.113.9").kind).toBe("remote");
    // The reviewer probe: a Neon URL with ?host=localhost came out local.
    const probe = classifyDatabaseSetting("DATABASE_URL", "postgres://u:pw@ep-prod-1.us-east-2.aws.neon.tech/db?host=localhost");
    expect(probe).toMatchObject({ kind: "remote", remoteHosts: ["ep-prod-1.us-east-2.aws.neon.tech"], provider: "Neon" });
    expect(classifyDatabaseSetting("DATABASE_URL", "postgres://u@prod.example.com/app?host=localhost").kind).toBe("remote");
    expect(classifyDatabaseSetting("DATABASE_URL", "postgres://u@localhost/app?host=127.0.0.1").kind).toBe("local");
  });

  it("rejects look-alike local hosts", () => {
    expect(classifyDatabaseSetting("DATABASE_URL", "postgres://u@localhost.evil.com/app").kind).toBe("remote");
    expect(classifyDatabaseSetting("DATABASE_URL", "postgres://u@127.0.0.1.nip.io/app").kind).toBe("remote");
  });

  it("reads PGHOST as a bare host", () => {
    expect(classifyDatabaseSetting("PGHOST", "localhost").kind).toBe("local");
    expect(classifyDatabaseSetting("PGHOST", "/tmp").kind).toBe("local");
    expect(classifyDatabaseSetting("PGHOST", "db.internal.example.com").kind).toBe("remote");
  });

  it("knows hosted and local Supabase", () => {
    expect(classifyDatabaseSetting("NEXT_PUBLIC_SUPABASE_URL", "https://abcd.supabase.co")).toMatchObject({ kind: "remote", provider: "Supabase" });
    expect(classifyDatabaseSetting("SUPABASE_URL", "http://127.0.0.1:54321")).toMatchObject({ kind: "local", note: expect.stringMatching(/local Supabase/) });
  });

  it("names other providers", () => {
    expect(classifyDatabaseSetting("DATABASE_URL", "mysql://u:p@aws.connect.psdb.cloud/db").provider).toBe("PlanetScale");
    expect(classifyDatabaseSetting("DATABASE_URL", "postgres://u:p@x.abc.us-east-1.rds.amazonaws.com/db").provider).toBe("Amazon RDS");
    expect(classifyDatabaseSetting("TURSO_DATABASE_URL", "libsql://app-org.turso.io?authToken=secret").provider).toBe("Turso");
    expect(classifyDatabaseSetting("MONGODB_URI", "mongodb+srv://u:p@cluster0.abc.mongodb.net/db").provider).toBe("MongoDB Atlas");
  });

  it("handles Mongo host lists: remote if any host is", () => {
    const r = classifyDatabaseSetting("MONGODB_URI", "mongodb://u:p@localhost:27017,mongo2.example.com:27017/db?replicaSet=rs0");
    expect(r.kind).toBe("remote");
    expect(r.remoteHosts).toEqual(["mongo2.example.com"]);
    expect(classifyDatabaseSetting("MONGODB_URI", "mongodb://localhost:27017,127.0.0.1:27018/db").kind).toBe("local");
  });

  it("splits Mongo host lists without ports, and every host must be local (finding 10)", () => {
    const r = classifyDatabaseSetting("MONGODB_URI", "mongodb://localhost,db2/app");
    expect(r).toMatchObject({ kind: "remote", hosts: ["localhost", "db2"], remoteHosts: ["db2"], optIns: ["db2"] });
    const both = classifyDatabaseSetting("MONGODB_URI", "mongodb://a.example.com:27017,b.example.com:27017/app");
    expect(both).toMatchObject({ kind: "remote", hosts: ["a.example.com", "b.example.com"], optIns: ["a.example.com", "b.example.com"] });
    expect(classifyDatabaseSetting("MONGODB_URI", "mongodb://localhost,127.0.0.1/app").kind).toBe("local");
  });

  it("reads keyword connection strings (finding 2)", () => {
    expect(classifyDatabaseSetting("DB", "host=prod.example.com port=5432 user=app dbname=main")).toMatchObject({ kind: "remote", hosts: ["prod.example.com"], port: "5432", database: "main" });
    expect(classifyDatabaseSetting("DB", "host=localhost user=app dbname=main").kind).toBe("local");
    expect(classifyDatabaseSetting("DB", "host=localhost hostaddr=203.0.113.9 dbname=main").kind).toBe("remote");
    expect(classifyDatabaseSetting("DB", "dbname=main user=app").kind).toBe("local"); // libpq's default unix socket
    expect(classifyDatabaseSetting("DB", "Server=tcp:prod.database.windows.net,1433;Initial Catalog=app;User ID=x;Password=y")).toMatchObject({ kind: "remote", provider: "Azure" });
  });

  it("asks for user@host on shared hosts, and never binds one without a user (finding 3)", () => {
    const pooler = classifyDatabaseSetting("DATABASE_URL", "postgres://postgres.abcdref:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres");
    expect(pooler).toMatchObject({ kind: "remote", optIns: ["postgres.abcdref@aws-0-us-east-1.pooler.supabase.com"], unboundHosts: [] });
    const accel = classifyDatabaseSetting("DATABASE_URL", "prisma://accelerate.prisma-data.net/?api_key=secret");
    expect(accel).toMatchObject({ kind: "remote", optIns: [], unboundHosts: ["accelerate.prisma-data.net"] });
    const ps = classifyDatabaseSetting("DATABASE_HOST", "aws.connect.psdb.cloud", { bareHost: true, user: "branchuser" });
    expect(ps.optIns).toEqual(["branchuser@aws.connect.psdb.cloud"]);
    expect(isSharedHost("db.prisma.io")).toBe(true);
    expect(isSharedHost("db.abcdref.supabase.co")).toBe(false);
  });

  // Second review, finding 2: an unescaped @, /, ? or # in the password put part of it in the
  // reported host, port or database. Now unreadable (refused), with nothing from the URL shown.
  it.each([
    "postgres://u:p@ss@prod.example.com/db",
    "postgres://u:pa/ss@prod.example.com/db",
    "postgres://admin:2024/HunterPass@db.mycorp.com/app",
    "postgres://admin:Sup3r@Secr3t/x@host.example.com/app",
    "postgres://admin:12?HunterPass@db.mycorp.com/app",
    "postgres://admin:1234#HunterPass@db.mycorp.com/app",
  ])("an unescaped @ / ? or # before the host is unreadable, showing nothing: %s", (url) => {
    const parsed = classifyDatabaseSetting("DATABASE_URL", url);
    expect(parsed.kind).toBe("unknown");
    expect(parsed.hosts).toEqual([]);
    expect(parsed.database).toBeUndefined();
    expect(parsed.port).toBeUndefined();
    expect(parsed.note).toMatch(/unescaped @, \/, \? or #/);
    for (const fragment of ["HunterPass", "Secr3t", "secr3t", "2024", "1234", "ss@"]) expect(JSON.stringify(parsed)).not.toContain(fragment);
  });

  it("still reads a percent-encoded password", () => {
    expect(classifyDatabaseSetting("DATABASE_URL", "postgres://admin:2024%2FHunter%40Pass@db.mycorp.com/app")).toMatchObject({
      kind: "remote",
      hosts: ["db.mycorp.com"],
      database: "app",
    });
  });

  it("is unknown when the host comes from an unresolved variable, but not when only the password does", () => {
    expect(classifyDatabaseSetting("DATABASE_URL", "postgres://u:p@\u0000unresolved\u0000/db").kind).toBe("unknown");
    expect(classifyDatabaseSetting("DATABASE_URL", "postgres://u:\u0000unresolved\u0000@prod.example.com/db").kind).toBe("remote");
    expect(classifyDatabaseSetting("DATABASE_URL", "not a url").kind).toBe("unknown");
  });
});

describe("looksLikeDatabaseValue", () => {
  it.each([
    "postgres://u:p@prod.example.com/db",
    "postgresql://u@localhost/db",
    "mysql://u@h.example.com/db",
    "mongodb+srv://u:p@cluster0.abc.mongodb.net/db",
    "libsql://app-org.turso.io",
    "prisma+postgres://accelerate.prisma-data.net/?api_key=x",
    "jdbc:postgresql://h.example.com/db",
    "host=prod.example.com user=app dbname=main",
    "https://abcd.supabase.co",
    "https://happy-animal-123.convex.cloud",
    "https://myapp-default-rtdb.firebaseio.com",
    "myapp.firebaseapp.com",
    "aws.connect.psdb.cloud",
  ])("%s looks like a database", (v) => {
    expect(looksLikeDatabaseValue(v)).toBe(true);
  });

  it.each(["https://example.com", "https://myapp.up.railway.app", "hello", "sk_test_123", "10", "https://hooks.slack.com/services/x"])("%s doesn't", (v) => {
    expect(looksLikeDatabaseValue(v)).toBe(false);
  });
});
