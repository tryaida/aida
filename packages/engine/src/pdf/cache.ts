// Content-hash cache for the pdf stage: skip re-rendering a walkthrough's PDFs when nothing
// that would change their bytes has changed since the last build (docs/scope.md "Only rebuild
// what changed"). Mirrors build/hash.ts's approach (sha256 of a stable JSON blob) rather than
// render/hash.ts's file-fingerprint sidecar, since a PDF's inputs are a handful of small files
// (markdown + a few dozen screenshot PNGs) cheap enough to fingerprint by path+size+mtime.
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

function fileFingerprint(file: string): string {
  if (!existsSync(file)) return `missing:${file}`;
  const st = statSync(file);
  return `${file}:${st.size}:${st.mtimeMs}`;
}

export interface PdfCacheInput {
  markdown: string;
  screenshots: string[];
  paper: string;
  brand?: unknown;
  lastChecked?: string;
  extra?: unknown;
}

/** Stable sha256 over a walkthrough's PDF inputs: the page Markdown's own text (not just its
 * file fingerprint — pages rewrites index.plain.md in place, so mtime alone would never miss a
 * real content change, but hashing the text directly is just as cheap and makes this hash
 * meaningful even when called with in-memory Markdown, as the CLI's `--json` path does). */
export function pdfInputHash(input: PdfCacheInput): string {
  const hash = createHash("sha256");
  hash.update(input.markdown);
  hash.update(JSON.stringify({ paper: input.paper, brand: input.brand, lastChecked: input.lastChecked, extra: input.extra }));
  for (const f of [...input.screenshots].sort()) hash.update(fileFingerprint(f));
  return hash.digest("hex");
}

export function cacheSidecarPath(outFile: string): string {
  return `${outFile}.hash`;
}

/** True when every file in `outFiles` exists and shares a matching `.hash` sidecar for `hash`. */
export function matchesCache(outFiles: string[], hash: string): boolean {
  return outFiles.every((f) => {
    if (!existsSync(f)) return false;
    const sidecar = cacheSidecarPath(f);
    if (!existsSync(sidecar)) return false;
    try {
      return readFileSync(sidecar, "utf8").trim() === hash;
    } catch {
      return false;
    }
  });
}

export function writeCacheSidecar(outFile: string, hash: string): void {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(cacheSidecarPath(outFile), `${hash}\n`);
}

/** Removes a PDF output file and its `.hash` sidecar, if present. Used when a walkthrough's page
 * is excluded (not publishable/didn't pass) or fails the QA scan — so a stale `<id>.pdf`/
 * `<id>.card.pdf` from an earlier, passing build is never left on disk (or copied into the help
 * app by `stagePdfsToHelpApp`) once that's no longer true (review finding pdf/build.ts:45). */
export function deletePdfOutput(outFile: string): void {
  if (existsSync(outFile)) rmSync(outFile);
  const sidecar = cacheSidecarPath(outFile);
  if (existsSync(sidecar)) rmSync(sidecar);
}
