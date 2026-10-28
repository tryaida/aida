// Database adapter for capture: `validate.database` checks and the demo-data reset.
// The reset restores a snapshot of the seeded demo database (see ../README.md, "Demo data").
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "../../apps/web");
const SNAPSHOT = process.env.AIDA_DEMO_SNAPSHOT ?? resolve(HERE, "../.demo-data/rallly-demo.dump");

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const file of [join(APP_DIR, ".env.local"), resolve(APP_DIR, "../../.env")]) {
    if (!existsSync(file)) continue;
    const m = readFileSync(file, "utf8").match(/^DATABASE_URL=(.*)$/m);
    if (m) return m[1].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  throw new Error("database adapter: no DATABASE_URL");
}

export default {
  url: databaseUrl,
  async query(sql, params = [], context) {
    const { Client } = createRequire(join(APP_DIR, "package.json"))("pg");
    const db = new Client({ connectionString: context?.url ?? databaseUrl() });
    await db.connect();
    try {
      return (await db.query(sql, params)).rows;
    } finally {
      await db.end();
    }
  },
  reset() {
    if (!existsSync(SNAPSHOT)) throw new Error(`database adapter: no demo snapshot at ${SNAPSHOT}; make one with adapters/snapshot.sh`);
    execFileSync("pg_restore", ["--clean", "--if-exists", "--no-owner", "--single-transaction", "-d", databaseUrl(), SNAPSHOT], { stdio: "inherit" });
  },
};
