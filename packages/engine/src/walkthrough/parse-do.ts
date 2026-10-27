import type { Action } from "./action.js";

/**
 * Parses a plain-words `do:` string into one or more structured Actions.
 * Supported forms (case-insensitive):
 *   click "Add competitor" button
 *   fill "First name" with "Jordan"
 *   select "Class" option "Open"
 *   expect text "Competitor added"
 *   go to /competitors
 *   wait for url /competitors/*
 * Throws a short, agent-readable error for anything else — write an explicit
 * `actions:` entry instead.
 */
export function parseDoString(doText: string): Action[] {
  const text = doText.trim();

  let m = text.match(/^click\s+"([^"]+)"\s+(\w+)$/i);
  if (m) {
    const [, name, role] = m;
    return [{ do: "click", target: { role: role.toLowerCase(), name } }];
  }

  m = text.match(/^fill\s+"([^"]+)"\s+with\s+"([^"]*)"$/i);
  if (m) {
    const [, label, value] = m;
    return [{ do: "type", target: { label }, text: value }];
  }

  m = text.match(/^select\s+"([^"]+)"\s+option\s+"([^"]+)"$/i);
  if (m) {
    const [, label, option] = m;
    return [{ do: "select", target: { label }, option }];
  }

  m = text.match(/^expect\s+text\s+"([^"]+)"$/i);
  if (m) {
    const [, value] = m;
    return [{ do: "expect", target: { text: value } }];
  }

  m = text.match(/^go to\s+(\S+)$/i);
  if (m) {
    const [, path] = m;
    return [{ do: "goto", path }];
  }

  m = text.match(/^wait for url\s+(\S+)$/i);
  if (m) {
    const [, glob] = m;
    return [{ do: "waitForUrl", pattern: globToRegexSource(glob) }];
  }

  throw new Error(
    `unrecognised "do:" step: ${JSON.stringify(text)} — use click/fill/select/expect/"go to"/"wait for url", or an explicit actions: list`,
  );
}

/**
 * Turns a plain-words path glob (e.g. `/competitors/*`) into a RegExp source
 * matched against the *full* URL by `page.waitForURL`. Anchors on the path
 * after an optional scheme+host prefix, since the glob only ever describes a
 * path, and allows an optional trailing query/hash so `wait for url /x`
 * still matches `/x?foo=1`.
 */
function globToRegexSource(glob: string): string {
  const escaped = glob
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^?#]*");
  return `^[^?#]*://[^/]+${escaped}(?:[?#].*)?$`;
}
