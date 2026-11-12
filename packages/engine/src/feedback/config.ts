// The owner's on/off switch, carried from `aida.config.ts` to the help app the same way the chat
// settings are: `aida build` writes plain JSON into the help app's `public/`, and the help app
// reads it off disk (the route at request time, guide pages when they render). The help app
// never loads the engine's config loader, which its bundler can't trace.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FeedbackConfig } from "../config/types.js";

export const FEEDBACK_CONFIG_FILE = "feedback-config.json";

export interface ResolvedFeedbackConfig {
  enabled: boolean;
  /** The help site's own origin (`publish.siteUrl`), when set: the route takes posts from it as
   * same-site even behind a proxy that rewrites `Host`. */
  siteOrigin?: string;
}

/** The `http(s)` origin of a configured site URL, or undefined for anything else. */
export function siteOriginOf(siteUrl: string | undefined): string | undefined {
  if (!siteUrl) return undefined;
  try {
    const url = new URL(siteUrl);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/** On unless the owner turned it off: entries stay in the owner's own deployment, redacted. */
export function resolveFeedbackConfig(config: FeedbackConfig | undefined, opts: { siteUrl?: string } = {}): ResolvedFeedbackConfig {
  const siteOrigin = siteOriginOf(opts.siteUrl);
  return { enabled: config?.enabled !== false, ...(siteOrigin ? { siteOrigin } : {}) };
}

/** Writes `<publicDir>/feedback-config.json`, leaving an unchanged file alone so a running
 * `next dev` doesn't reload for nothing. Pass `siteUrl` (`publish.siteUrl`) so same-site posts
 * work behind a proxy. Returns the file path. */
export function writeFeedbackConfig(publicDir: string, config: FeedbackConfig | undefined, opts: { siteUrl?: string } = {}): string {
  const file = join(publicDir, FEEDBACK_CONFIG_FILE);
  const text = `${JSON.stringify(resolveFeedbackConfig(config, opts))}\n`;
  if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeFileSync(file, text, "utf8");
  return file;
}

/**
 * The help app's feedback settings. Only a missing file means on (a help app that hasn't been
 * built since this setting existed). A file that is there but can't be read, isn't JSON, or
 * holds something other than the shape `writeFeedbackConfig` writes means off: the owner may
 * have meant to turn feedback off, and a public write route mustn't open on a guess.
 */
export function readFeedbackConfig(publicDir: string): ResolvedFeedbackConfig {
  const file = join(publicDir, FEEDBACK_CONFIG_FILE);
  if (!existsSync(file)) return { enabled: true };
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { enabled: false };
    const { enabled, siteOrigin } = parsed as { enabled?: unknown; siteOrigin?: unknown };
    if (enabled !== undefined && typeof enabled !== "boolean") return { enabled: false };
    const origin = typeof siteOrigin === "string" ? siteOriginOf(siteOrigin) : undefined;
    return { enabled: enabled !== false, ...(origin ? { siteOrigin: origin } : {}) };
  } catch {
    return { enabled: false };
  }
}

/** Whether feedback is on for a help app; see `readFeedbackConfig`. */
export function readFeedbackEnabled(publicDir: string): boolean {
  return readFeedbackConfig(publicDir).enabled;
}
