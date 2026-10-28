// The database reset before a capture, in one place: never without proving the database is local,
// and always followed by forgetting the saved sign-in sessions. A reset can wipe the session rows
// a saved session points at (an app with database sessions), and an app that caches the session
// in a cookie still draws its first page signed in, so a stale session would only show up later
// as a jump to the sign-in page in the middle of a walkthrough.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedConfig } from "../config/types.js";
import { assertLocalDatabase } from "./write-guard.js";

/** Resets the app's local database (the adapter's `reset()`), then drops saved sessions. */
export async function resetDatabase(config: Pick<ResolvedConfig, "database" | "buildDir">): Promise<void> {
  if (!config.database?.reset) return;
  assertLocalDatabase(await config.database.url());
  await config.database.reset();
  forgetSavedSessions(config.buildDir);
}

/** Deletes the saved sign-in sessions (`<buildDir>/.aida-session/storageState-*.json`). */
export function forgetSavedSessions(buildDir: string): void {
  const dir = join(buildDir, ".aida-session");
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) if (/^storageState-.*\.json$/.test(f)) rmSync(join(dir, f), { force: true });
}
