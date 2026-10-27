// Generated-vs-human-edited block markers. Each generated block (other than frontmatter — see
// below) is wrapped in `{/* aida:begin <key> */}...{/* aida:end <key> */}`: an MDX
// expression-comment, safe inside the help app's MDX pipeline (an HTML comment `<!-- ... -->` is
// not reliably MDX-safe — some remark/MDX pipelines choke on it between block-level elements). A
// sidecar `.aida.json` records the hash aida last wrote for each key; on rebuild, a block
// whose on-disk hash still matches is safe to regenerate, and a block whose hash has drifted (a
// human edited it) is left alone and reported as a suggestion instead. Everything outside a
// recognised marker pair — any text a human added between, before or after them — is preserved
// byte-for-byte.
//
// Frontmatter is the one block never wrapped in markers: MDX/Fumadocs require the YAML
// frontmatter to be the literal first thing in the file (`---\n...\n---`), not preceded by a
// comment of any kind. It's still tracked like any other generated block — same hash-in-sidecar,
// same "human edited it, leave it alone" rule — just without the surrounding marker text.
//
// Reading accepts both this MDX-comment style and the older `<!-- aida:begin ... -->` HTML-
// comment style (and, for frontmatter specifically, the older "frontmatter wrapped in its own
// marker pair" shape), so a page built before this fix migrates cleanly on its next rebuild
// instead of being treated as entirely human-edited.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface GeneratedBlock {
  key: string;
  content: string;
}

export interface MergeResult {
  text: string;
  sidecar: Record<string, string>;
  suggestions: { key: string; message: string; suggested: string }[];
}

/** The one block written plain at the top of the file, never wrapped in markers. */
export const FRONTMATTER_KEY = "frontmatter";

/**
 * Frontmatter keys aida computes fresh on every build and must never freeze, even once a
 * person has hand-edited some other frontmatter field (e.g. `title`): a failed capture must
 * always ship `passed: false`, not whatever `passed`/`lastChecked`/link values were on disk the
 * last time a human touched the frontmatter. Keys not in this set (title, for, and anything a
 * person adds) are treated as human-editable, same as any other block.
 */
const FRONTMATTER_ENGINE_KEYS = new Set(["walkthrough", "lastChecked", "passed", "video", "srt", "vtt"]);

function escapeKey(key: string): string {
  return key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function beginMarker(key: string): string {
  return `{/* aida:begin ${key} */}`;
}
function endMarker(key: string): string {
  return `{/* aida:end ${key} */}`;
}

function hashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Matches either marker style, for reading. Writing always uses the MDX style (see above). */
function blockRegex(key: string): RegExp {
  const esc = escapeKey(key);
  const begin = `(?:<!--\\s*aida:begin ${esc}\\s*-->|\\{\\/\\*\\s*aida:begin ${esc}\\s*\\*\\/\\})`;
  const end = `(?:<!--\\s*aida:end ${esc}\\s*-->|\\{\\/\\*\\s*aida:end ${esc}\\s*\\*\\/\\})`;
  return new RegExp(`${begin}\\n?([\\s\\S]*?)\\n?${end}`);
}

function renderBlock(block: GeneratedBlock): string {
  return `${beginMarker(block.key)}\n${block.content}\n${endMarker(block.key)}`;
}

/** A plain `---\n...\n---` frontmatter fence at the very start of the file. */
const PLAIN_FRONTMATTER_RE = /^---\n[\s\S]*?\n---/;

function frontmatterLineKey(line: string): string | undefined {
  return /^([A-Za-z0-9_]+):/.exec(line)?.[1];
}

/** The lines of a frontmatter block whose key is NOT engine-owned — the part a person can edit. */
function humanOwnedFrontmatterLines(content: string): string[] {
  return content.split("\n").filter((line) => {
    const key = frontmatterLineKey(line);
    return key !== undefined && !FRONTMATTER_ENGINE_KEYS.has(key);
  });
}

/**
 * Builds the frontmatter to write: engine-owned keys (`passed`, `lastChecked`, `video`, `srt`,
 * `vtt`, `walkthrough`) always come from the freshly generated content, so a failed capture can
 * never ship stale `passed: true`. Every other key (`title`, `for`, anything a person added)
 * comes from whichever side owns it — the fresh content when nothing's been hand-edited there
 * (`keepHuman` false), the on-disk content when it has (`keepHuman` true).
 */
function mergeFrontmatter(oldContent: string, newContent: string, keepHuman: boolean): string {
  const oldLines = new Map<string, string>();
  for (const line of oldContent.split("\n")) {
    const key = frontmatterLineKey(line);
    if (key) oldLines.set(key, line);
  }
  const order: string[] = [];
  for (const line of newContent.split("\n")) {
    const key = frontmatterLineKey(line);
    if (key && !order.includes(key)) order.push(key);
  }
  // Keys a person added that the generator never writes (e.g. a custom frontmatter field) —
  // preserve them, appended after the generated keys, in their original order.
  for (const key of oldLines.keys()) if (!order.includes(key)) order.push(key);

  const newLines = new Map<string, string>();
  for (const line of newContent.split("\n")) {
    const key = frontmatterLineKey(line);
    if (key) newLines.set(key, line);
  }

  const lines = ["---"];
  for (const key of order) {
    if (FRONTMATTER_ENGINE_KEYS.has(key)) {
      const line = newLines.get(key);
      if (line) lines.push(line);
      continue;
    }
    const line = keepHuman ? oldLines.get(key) ?? newLines.get(key) : newLines.get(key) ?? oldLines.get(key);
    if (line) lines.push(line);
  }
  lines.push("---");
  return lines.join("\n");
}

/** Every `aida:begin <key>` marker present in `text`, either style, de-duplicated. */
function allMarkerKeys(text: string): string[] {
  const re = /(?:<!--\s*aida:begin\s+(\S+?)\s*-->|\{\/\*\s*aida:begin\s+(\S+?)\s*\*\/\})/g;
  const keys = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const key = m[1] ?? m[2];
    if (key) keys.add(key);
  }
  return [...keys];
}

/**
 * Migrates a page built before this fix: frontmatter that's still wrapped in its own
 * begin/end marker pair (either style) at the top of the file is unwrapped to plain text, so
 * `PLAIN_FRONTMATTER_RE` can find it. A no-op on an already-plain file.
 */
function migrateLegacyFrontmatter(text: string): string {
  const re = new RegExp(
    `^(?:<!--\\s*aida:begin ${FRONTMATTER_KEY}\\s*-->|\\{\\/\\*\\s*aida:begin ${FRONTMATTER_KEY}\\s*\\*\\/\\})\\n?([\\s\\S]*?)\\n?(?:<!--\\s*aida:end ${FRONTMATTER_KEY}\\s*-->|\\{\\/\\*\\s*aida:end ${FRONTMATTER_KEY}\\s*\\*\\/\\})\\n?`,
  );
  const m = re.exec(text);
  if (!m) return text;
  return `${m[1]}\n${text.slice(m[0].length)}`;
}

/**
 * Merges `blocks` (in document order) into `existingText` (the previous build's output, or
 * undefined for a first build). A block is rewritten when it's new, or when its on-disk content
 * still hashes to what `sidecarIn` recorded for it (aida's own last write, untouched since). A
 * block whose on-disk content no longer matches that hash — a human edited it — is left exactly
 * as it is on disk, and reported as a suggestion instead of being overwritten. The frontmatter
 * block (see `FRONTMATTER_KEY`) follows the same hash rule but is never marker-wrapped; it's
 * read from/written to the plain `---...---` fence at the top of the file instead.
 */
export function mergeBlocks(
  existingText: string | undefined,
  blocks: GeneratedBlock[],
  sidecarIn: Record<string, string>,
): MergeResult {
  const sidecar: Record<string, string> = {};
  const suggestions: MergeResult["suggestions"] = [];
  const frontmatter = blocks.find((b) => b.key === FRONTMATTER_KEY);
  const rest = blocks.filter((b) => b.key !== FRONTMATTER_KEY);

  if (existingText === undefined) {
    const parts: string[] = [];
    if (frontmatter) {
      parts.push(frontmatter.content);
      sidecar[frontmatter.key] = hashOf(humanOwnedFrontmatterLines(frontmatter.content).join("\n"));
    }
    parts.push(...rest.map(renderBlock));
    for (const b of rest) sidecar[b.key] = hashOf(b.content);
    return { text: parts.join("\n\n"), sidecar, suggestions };
  }

  let text = migrateLegacyFrontmatter(existingText);

  // Offset after which the next never-before-seen block gets inserted — tracks "end of the
  // most recently placed block" as we walk `rest` in document order, so a new block lands right
  // after the block that precedes it, not always at the very end of the file (see below).
  let cursor = 0;

  if (frontmatter) {
    const m = PLAIN_FRONTMATTER_RE.exec(text);
    if (!m) {
      text = `${frontmatter.content}\n\n${text.trimStart()}`;
      sidecar[frontmatter.key] = hashOf(humanOwnedFrontmatterLines(frontmatter.content).join("\n"));
      cursor = frontmatter.content.length;
    } else {
      const oldFrontmatter = m[0];
      const oldHuman = humanOwnedFrontmatterLines(oldFrontmatter).join("\n");
      const knownHash = sidecarIn[frontmatter.key];
      const stillOurs = knownHash !== undefined && hashOf(oldHuman) === knownHash;
      // Engine-owned keys (passed, lastChecked, video, srt, vtt, walkthrough) are always taken
      // fresh below, regardless of `stillOurs` — a block whose *other* fields a person edited
      // must never freeze these and ship a stale `passed: true` for a capture that has since
      // failed. Only the human-owned keys (title, for, ...) follow the usual hash rule.
      const merged = mergeFrontmatter(oldFrontmatter, frontmatter.content, !stillOurs);
      text = merged + text.slice(m[0].length);
      const newHuman = humanOwnedFrontmatterLines(frontmatter.content).join("\n");
      if (stillOurs) {
        sidecar[frontmatter.key] = hashOf(newHuman);
      } else {
        sidecar[frontmatter.key] = knownHash ?? hashOf(oldHuman);
        if (oldHuman.trim() !== newHuman.trim()) {
          suggestions.push({
            key: frontmatter.key,
            message: `"${frontmatter.key}" was edited by a person and differs from the freshly generated content; left as-is (engine-owned fields like "passed" and "lastChecked" were still refreshed).`,
            suggested: frontmatter.content,
          });
        }
      }
      cursor = merged.length;
    }
  }

  for (const block of rest) {
    const re = blockRegex(block.key);
    const match = re.exec(text);
    if (!match) {
      // New block (e.g. a step added since the last build): insert right after the block that
      // precedes it in document order, not always at the very end of the file — the end of the
      // file is the footer ("last-checked"), and a block appended after it would read out of
      // order on every subsequent rebuild.
      const insertion = `\n\n${renderBlock(block)}`;
      text = text.slice(0, cursor) + insertion + text.slice(cursor);
      sidecar[block.key] = hashOf(block.content);
      cursor += insertion.length;
      continue;
    }

    const oldInner = match[1] ?? "";
    const knownHash = sidecarIn[block.key];
    const stillOurs = knownHash !== undefined && hashOf(oldInner) === knownHash;

    if (stillOurs) {
      const rendered = renderBlock(block);
      text = text.slice(0, match.index) + rendered + text.slice(match.index + match[0].length);
      sidecar[block.key] = hashOf(block.content);
      cursor = match.index + rendered.length;
    } else {
      // Human-edited (or hand-written, never recorded) — leave it, suggest the generated version.
      sidecar[block.key] = knownHash ?? hashOf(oldInner);
      if (oldInner.trim() !== block.content.trim()) {
        suggestions.push({
          key: block.key,
          message: `"${block.key}" was edited by a person and differs from the freshly generated content; left as-is.`,
          suggested: block.content,
        });
      }
      cursor = match.index + match[0].length;
    }
  }

  // Blocks that no longer correspond to a current step/section (e.g. a step was removed):
  // drop them when they're still exactly what aida last wrote (safe — nothing human to lose),
  // but leave a human-edited one in place and flag it instead of silently deleting someone's
  // wording and its screenshot reference.
  const currentKeys = new Set(rest.map((b) => b.key));
  for (const key of allMarkerKeys(text)) {
    if (currentKeys.has(key)) continue;
    const re = blockRegex(key);
    const match = re.exec(text);
    if (!match) continue;
    const oldInner = match[1] ?? "";
    const knownHash = sidecarIn[key];
    const stillOurs = knownHash !== undefined && hashOf(oldInner) === knownHash;
    if (stillOurs) {
      text = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).replace(/\n{3,}/g, "\n\n");
    } else {
      suggestions.push({
        key,
        message: `"${key}" no longer corresponds to anything in the walkthrough, but was edited by a person; left as-is — consider removing it.`,
        suggested: "",
      });
    }
  }

  return { text, sidecar, suggestions };
}

/** Strips every aida marker (either style), leaving the content they wrapped. For the plain-md copy. */
export function stripMarkers(text: string): string {
  return text
    .replace(/<!-- aida:begin [^\n]*? -->\n?/g, "")
    .replace(/\n?<!-- aida:end [^\n]*? -->/g, "")
    .replace(/\{\/\* aida:begin [^\n]*? \*\/\}\n?/g, "")
    .replace(/\n?\{\/\* aida:end [^\n]*? \*\/\}/g, "");
}

/**
 * One-time migration for a page built before step blocks were keyed by `step.id`: renames a
 * aida-tracked marker/sidecar entry from its old position-based key (`step-3`) to the new
 * id-based key (`step-add-competitor`), preserving on-disk content exactly (human-edited or
 * not) so the usual hash check in `mergeBlocks` keeps working across the rename. A no-op when
 * the keys are already the same, the new key is already present (already migrated), or the old
 * key was never aida's own write (hand-authored marker with no sidecar record — never rename
 * something aida doesn't know it wrote).
 */
export function renameLegacyKey(
  text: string,
  sidecarIn: Record<string, string>,
  oldKey: string,
  newKey: string,
): { text: string; sidecar: Record<string, string> } {
  if (oldKey === newKey || sidecarIn[newKey] !== undefined || sidecarIn[oldKey] === undefined) {
    return { text, sidecar: sidecarIn };
  }
  const match = blockRegex(oldKey).exec(text);
  if (!match) return { text, sidecar: sidecarIn };
  const renamed = renderBlock({ key: newKey, content: match[1] ?? "" });
  const newText = text.slice(0, match.index) + renamed + text.slice(match.index + match[0].length);
  const sidecar = { ...sidecarIn, [newKey]: sidecarIn[oldKey] };
  delete sidecar[oldKey];
  return { text: newText, sidecar };
}

export function sidecarPath(indexFile: string): string {
  return `${indexFile}.aida.json`;
}

export function readSidecar(indexFile: string): Record<string, string> {
  const file = sidecarPath(indexFile);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export function writeSidecar(indexFile: string, sidecar: Record<string, string>): void {
  writeFileSync(sidecarPath(indexFile), `${JSON.stringify(sidecar, null, 2)}\n`);
}
