// Copies the plain .mjs files tsc doesn't emit into dist/ (the frame-diff worker and its core).
// Run by `npm run build` and by scripts/prepack.mjs.
import { copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const engineDir = join(dirname(fileURLToPath(import.meta.url)), "..");

export const DIST_ASSETS = ["capture/frame-diff-worker.mjs", "capture/png-diff-core.mjs"];

export function copyDistAssets(dir = engineDir) {
  for (const file of DIST_ASSETS) copyFileSync(join(dir, "src", file), join(dir, "dist", file));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) copyDistAssets();
