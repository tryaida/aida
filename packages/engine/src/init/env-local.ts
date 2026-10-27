// `aida init --tunnel-host <host>` (build-plan.md M25): writes the hosts a dev tunnel or proxy
// serves the help app on into `<help>/.env.local` as `AIDA_STUDIO_ALLOWED_HOSTS`. Next reads
// that file before next.config.mjs, which passes the list to `allowedDevOrigins` (otherwise Next
// blocks the Studio's dev resources and it loads forever), and the Studio's own Host/Origin
// checks (app/studio/_lib/security.ts) accept the same exact hostnames. Merges with what's there:
// other lines are never touched, and hosts already listed are kept.
//
// It also makes sure `.env.local` holds a Studio access key (`AIDA_STUDIO_KEY`). With a key set
// the Studio refuses every request without its cookie, on localhost too (a tunnel reaches the dev
// server from this machine, so only the key tells them apart): the private link
// (`/studio/access#key=<key>`, the key in the fragment so it never reaches the server's request
// log) sets the cookie, and the page and every Studio API call need it (security.ts).
// `.env.local` is git-ignored by the help app's template (`.env*.local`), so the key is never
// committed, and it's kept owner-only (0600) since it holds the key.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STUDIO_HOSTS_VAR = "AIDA_STUDIO_ALLOWED_HOSTS";
export const STUDIO_KEY_VAR = "AIDA_STUDIO_KEY";
/** Shorter keys are treated as unset by the Studio (security.ts), so init replaces them. */
export const STUDIO_KEY_MIN_LENGTH = 32;

/** Printed by `aida init` whenever tunnel hosts are given, next to the access link. */
export const TUNNEL_HOST_WARNING =
  "With an access key set, the Studio only opens through a private link above, on localhost too " +
  "(a tunnel reaches the dev server from this machine, so only the key tells them apart): open it " +
  "once per browser and it sets a cookie for 12 hours; every request without that cookie gets a " +
  "403. Anyone with the link can edit " +
  "this help app's files, including code the dev server runs, so keep it private: don't paste it " +
  "into chats, issues or screenshots. To revoke it, delete AIDA_STUDIO_KEY from .env.local, " +
  "re-run init with --tunnel-host and restart the dev server. A host behind your own sign-in " +
  "(Cloudflare Access, Tailscale, ngrok with OAuth) is safer still than a public quick tunnel.";

/** The bare hostname from `--tunnel-host`, which may be given as a URL ("https://x.example.com/")
 * or host:port. Throws on a wildcard or anything that isn't a hostname: the Studio's checks match
 * exact hostnames, so a wildcard would let Next serve the Studio and then refuse every edit. */
export function normalizeTunnelHost(input: string): string {
  let host = input.trim().toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) {
    try {
      host = new URL(host).hostname;
    } catch {
      throw new Error(`--tunnel-host ${JSON.stringify(input)} isn't a valid URL or hostname`);
    }
  } else {
    host = host.replace(/\/.*$/, "").replace(/:\d+$/, "");
  }
  if (host.includes("*")) {
    throw new Error(`--tunnel-host ${JSON.stringify(input)}: list each exact host, not a wildcard`);
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) {
    throw new Error(`--tunnel-host ${JSON.stringify(input)} isn't a hostname`);
  }
  return host;
}

function parseList(value: string): string[] {
  const v = value.trim().replace(/^(["'])(.*)\1$/, "$2");
  return v.split(",").map((h) => h.trim()).filter(Boolean);
}

export interface WriteTunnelHostsResult {
  file: string;
  /** Every host now listed (existing first, then new). */
  hosts: string[];
  /** Hosts this call added. */
  added: string[];
  written: boolean;
}

/** Adds `hosts` to `AIDA_STUDIO_ALLOWED_HOSTS` in `<helpDir>/.env.local`, creating the file or
 * the line as needed and leaving every other line exactly as it was. */
export function writeTunnelHosts(helpDir: string, hosts: string[]): WriteTunnelHostsResult {
  const file = join(helpDir, ".env.local");
  const wanted = hosts.map(normalizeTunnelHost);
  const raw = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = raw === "" ? [] : raw.replace(/\r?\n$/, "").split(/\r?\n/);
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${STUDIO_HOSTS_VAR}\\s*=(.*)$`);

  const index = lines.findIndex((l) => pattern.test(l));
  const existing = index === -1 ? [] : parseList(lines[index].match(pattern)![1]);
  const added = wanted.filter((h, i) => !existing.includes(h) && wanted.indexOf(h) === i);
  const all = [...existing, ...added];
  if (added.length === 0) return { file, hosts: all, added, written: false };

  const line = `${STUDIO_HOSTS_VAR}=${all.join(",")}`;
  if (index === -1) {
    lines.push("# Hosts a dev tunnel serves the help app on; the Studio only loads on these and localhost.", line);
  } else {
    lines[index] = line;
  }
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  // 0600 on create: ensureStudioKey adds the key to this same file next.
  writeFileSync(file, lines.join(eol) + eol, { encoding: "utf8", mode: 0o600 });
  ownerOnlyIfKeyed(file);
  return { file, hosts: all, added, written: true };
}

export interface EnsureStudioKeyResult {
  file: string;
  key: string;
  /** True when this call wrote a new key (none was there, or the one there was too short). */
  created: boolean;
}

/** Makes sure `<helpDir>/.env.local` holds a `AIDA_STUDIO_KEY` (32 random bytes, base64url),
 * keeping one that's already there and long enough, and leaving every other line as it was. */
export function ensureStudioKey(helpDir: string): EnsureStudioKeyResult {
  const file = join(helpDir, ".env.local");
  const raw = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = raw === "" ? [] : raw.replace(/\r?\n$/, "").split(/\r?\n/);
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${STUDIO_KEY_VAR}\\s*=(.*)$`);

  const index = lines.findIndex((l) => pattern.test(l));
  const existing = index === -1 ? "" : lines[index].match(pattern)![1].trim().replace(/^(["'])(.*)\1$/, "$2").trim();
  if (existing.length >= STUDIO_KEY_MIN_LENGTH) {
    ownerOnlyIfKeyed(file);
    return { file, key: existing, created: false };
  }

  const key = randomBytes(32).toString("base64url");
  const line = `${STUDIO_KEY_VAR}=${key}`;
  if (index === -1) {
    lines.push("# The Studio's access key off localhost (aida init prints the link). Keep it private; never commit it.", line);
  } else {
    lines[index] = line;
  }
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  writeFileSync(file, lines.join(eol) + eol, { encoding: "utf8", mode: 0o600 });
  // `mode` only applies when the file is created: tighten one that was already there.
  chmodSync(file, 0o600);
  return { file, key, created: true };
}

/** Makes `.env.local` owner-only (0600) when it holds the Studio key: an existing file may have
 * been created 0644 by hand or by an older init. A no-op on Windows, which has no mode bits. */
function ownerOnlyIfKeyed(file: string): void {
  if (!existsSync(file)) return;
  if (!new RegExp(`^\\s*(?:export\\s+)?${STUDIO_KEY_VAR}\\s*=`, "m").test(readFileSync(file, "utf8"))) return;
  try {
    chmodSync(file, 0o600);
  } catch {
    // Not ours to fix (e.g. another owner); the key still works.
  }
}

/** The private link that opens the Studio through a tunnel host and sets its access cookie. The
 * key is in the URL fragment, which browsers never send, so it never appears in a request log. */
export function studioAccessUrl(host: string, key: string): string {
  return `https://${host}/studio/access#key=${encodeURIComponent(key)}`;
}

/** The same link on this machine (`npm run dev` listens on 127.0.0.1): with a key set the Studio
 * needs it on localhost too. */
export function localStudioAccessUrl(key: string, port = 3000): string {
  return `http://localhost:${port}/studio/access#key=${encodeURIComponent(key)}`;
}
