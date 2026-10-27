// The saved sign-in session's file key (`.aida-session/storageState-<key>.json`), shared by
// capture, inspect, record, ci, theme --from-app and state setup so one sign-in is reused across
// them. Keyed by base URL, persona and the sign-in adapter itself: a session saved by an older
// adapter (or the same file with another export) is never reused after the adapter changes.
import { createHash } from "node:crypto";
import type { Persona } from "../walkthrough/index.js";
import type { ResolvedConfig } from "../config/types.js";

/** What identifies the sign-in adapter: `signInHash` from `loadConfig()` (its file's content and
 * export name), else the function's own source (a hand-built config). */
export function signInKey(config: Partial<Pick<ResolvedConfig, "signIn" | "signInHash">> | undefined): string | undefined {
  if (!config) return undefined;
  if (config.signInHash) return config.signInHash;
  if (typeof config.signIn === "function") return createHash("sha256").update(config.signIn.toString()).digest("hex").slice(0, 16);
  return undefined;
}

/** 16 hex characters for base URL + persona (+ the sign-in adapter, when there is one). */
export function sessionKey(
  baseUrl: string,
  persona: Persona | undefined | null,
  config?: Partial<Pick<ResolvedConfig, "signIn" | "signInHash">>,
): string {
  const adapter = signInKey(config);
  const input = { baseUrl, persona: persona ?? null, ...(adapter ? { signIn: adapter } : {}) };
  return createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 16);
}
