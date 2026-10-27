// Page text edit action: setPageBlock. Edits human text inside a generated block (by its
// marker key) or appends a new human-owned block when the key doesn't exist yet. Pages are
// `.md` today with `<!-- aida:begin key -->...<!-- aida:end key -->` markers (see
// packages/engine/src/pages/markers.ts) and are moving to `.mdx` with `{/* aida:begin key */}`
// markers + the same `.aida.json` sidecar hashes — this module recognises both styles so it
// keeps working across that switch without changes.
//
// Editing a generated block's text doesn't need to touch the sidecar: markers.ts's own rebuild
// check (`hashOf(oldInner) === sidecarIn[key]`) already treats any on-disk content that no
// longer hashes to aida's last-written value as human-owned, so the very act of writing new
// text here is what flips a block from generated to human-owned on the next rebuild — rebuilds
// then suggest instead of overwrite.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { appendHistory, registerRevert } from "./history.js";
import { findHelpRoot } from "./help-root.js";
import { isLockedAny } from "./locks.js";
import { EditLockedError, EditValidationError } from "./types.js";
import type { EditOptions, EditResult, HistoryEntry } from "./types.js";

interface MarkerStyle {
  name: "html" | "mdx";
  begin: (key: string) => string;
  end: (key: string) => string;
  regex: (key: string) => RegExp;
}

function escapeKey(key: string): string {
  return key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const HTML_STYLE: MarkerStyle = {
  name: "html",
  begin: (key) => `<!-- aida:begin ${key} -->`,
  end: (key) => `<!-- aida:end ${key} -->`,
  regex: (key) => new RegExp(`<!-- aida:begin ${escapeKey(key)} -->\\n?([\\s\\S]*?)\\n?<!-- aida:end ${escapeKey(key)} -->`),
};

const MDX_STYLE: MarkerStyle = {
  name: "mdx",
  begin: (key) => `{/* aida:begin ${key} */}`,
  end: (key) => `{/* aida:end ${key} */}`,
  regex: (key) => new RegExp(`\\{/\\* aida:begin ${escapeKey(key)} \\*/\\}\\n?([\\s\\S]*?)\\n?\\{/\\* aida:end ${escapeKey(key)} \\*/\\}`),
};

const STYLES = [HTML_STYLE, MDX_STYLE];

/** Which marker style is already used in `text`, for a new block's markers; MDX expression
 * comments (the engine's current default — see pages/markers.ts) if the file has no markers yet,
 * unless the file is clearly using the older HTML-comment style throughout. */
function dominantStyle(text: string): MarkerStyle {
  return text.includes("<!-- aida:begin") && !text.includes("{/* aida:begin") ? HTML_STYLE : MDX_STYLE;
}

function findBlock(text: string, key: string): { style: MarkerStyle; match: RegExpExecArray } | undefined {
  for (const style of STYLES) {
    const match = style.regex(key).exec(text);
    if (match) return { style, match };
  }
  return undefined;
}

function renderBlock(style: MarkerStyle, key: string, content: string): string {
  return `${style.begin(key)}\n${content}\n${style.end(key)}`;
}

/** `page:<helpRoot-relative resolved pageFile>:<key>` — normalised so differently-spelled paths
 * to the same file (relative vs. absolute, redundant "..", a trailing slash) always produce the
 * same lock/history key; a raw, un-normalised caller path would let a lock be silently bypassed
 * by spelling the same file differently. */
function itemKey(helpRoot: string, pageFile: string, key: string): string {
  return `page:${relative(helpRoot, resolve(pageFile))}:${key}`;
}

function record(helpRoot: string, file: string, opts: EditOptions, target: string, before: unknown, after: unknown): HistoryEntry {
  const entry: HistoryEntry = {
    at: new Date().toISOString(),
    by: opts.by ?? "agent",
    action: "setPageBlock",
    target,
    before,
    after,
    file,
  };
  if (opts.record !== false) appendHistory(helpRoot, entry);
  return entry;
}

/** Sets the text of a page block (a generated block, by its marker `key`, or a new human-only
 * block if that key doesn't exist in the file yet). */
export function setPageBlock(pageFile: string, key: string, text: string, opts: EditOptions = {}): EditResult<string | undefined> {
  const by = opts.by ?? "agent";
  const helpRoot = findHelpRoot(pageFile);

  // Defense against writing to an arbitrary file: a page block is only ever a built .md/.mdx
  // page, and (when the caller supplies `pagesDir` — required for any caller taking pageFile
  // from an untrusted source such as an HTTP request) must resolve inside it.
  const resolvedPageFile = resolve(pageFile);
  if (!/\.mdx?$/i.test(resolvedPageFile)) {
    throw new EditValidationError(`setPageBlock: "${pageFile}" is not a .md/.mdx file`);
  }
  if (opts.pagesDir) {
    const resolvedPagesDir = resolve(opts.pagesDir);
    const rel = relative(resolvedPagesDir, resolvedPageFile);
    if (rel.startsWith("..") || rel.split(/[\\/]/)[0] === "..") {
      throw new EditValidationError(`setPageBlock: "${pageFile}" is outside the pages directory`);
    }
  }

  if (by === "agent") {
    const lockedKey = isLockedAny(helpRoot, [itemKey(helpRoot, pageFile, key)]);
    if (lockedKey) throw new EditLockedError(lockedKey);
  }

  const existing = existsSync(pageFile) ? readFileSync(pageFile, "utf8") : "";
  const found = findBlock(existing, key);

  let before: string | undefined;
  let next: string;
  if (found) {
    before = found.match[1] ?? "";
    next = existing.slice(0, found.match.index) + renderBlock(found.style, key, text) + existing.slice(found.match.index + found.match[0].length);
  } else {
    before = undefined;
    const style = dominantStyle(existing);
    const sep = existing.length > 0 && !existing.endsWith("\n\n") ? (existing.endsWith("\n") ? "\n" : "\n\n") : "";
    next = `${existing}${sep}${renderBlock(style, key, text)}`;
  }

  writeFileSync(pageFile, next.endsWith("\n") ? next : `${next}\n`);

  const target = itemKey(helpRoot, pageFile, key);
  record(helpRoot, pageFile, opts, target, before, text);
  return { target, before, after: text };
}

registerRevert("setPageBlock", (entry) => {
  if (!entry.file) throw new Error("history entry has no file to revert");
  const key = entry.target.split(":").slice(2).join(":");
  if (entry.before === undefined) {
    // The block didn't exist before this edit — undo removes it entirely.
    const existing = readFileSync(entry.file, "utf8");
    const found = findBlock(existing, key);
    if (found) {
      const next = existing.slice(0, found.match.index) + existing.slice(found.match.index + found.match[0].length);
      writeFileSync(entry.file, next.replace(/\n{3,}/g, "\n\n"));
    }
    return;
  }
  setPageBlock(entry.file, key, entry.before as string, { by: entry.by, record: false });
});
