// Writes the deterministic HTML player bundle (assets/player/* + timeline.json/.js) that
// Playwright opens to render frame-by-frame, or a human opens directly to preview.
import { fileURLToPath } from "node:url";
import path from "node:path";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import type { Timeline } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// Compiled to dist/render/bundle.js; assets live at <package root>/assets/player.
const PLAYER_ASSETS_CANDIDATES = [
  path.resolve(here, "../../assets/player"), // dist/render -> package root/assets/player
  path.resolve(here, "../assets/player"), // src/render (ts-node/vitest) -> package root/assets/player
];

async function findPlayerAssetsDir(): Promise<string> {
  const { existsSync } = await import("node:fs");
  for (const candidate of PLAYER_ASSETS_CANDIDATES) {
    if (existsSync(path.join(candidate, "index.html"))) return candidate;
  }
  throw new Error(`could not find player assets (looked in: ${PLAYER_ASSETS_CANDIDATES.join(", ")})`);
}

/** The player's own files: part of every render's content hash, so a player change (a new look,
 * a motion or privacy fix) re-renders videos the whole-video cache would otherwise skip. */
export async function playerAssetFiles(): Promise<string[]> {
  const dir = await findPlayerAssetsDir();
  return ["index.html", "player.js", "player.css"].map((f) => path.join(dir, f));
}

/** Writes a fresh player bundle to `outDir`, overwriting any previous contents. */
export async function writePlayerBundle(outDir: string, timeline: Timeline): Promise<void> {
  const assetsDir = await findPlayerAssetsDir();
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  for (const f of ["index.html", "player.js", "player.css"]) {
    await copyFile(path.join(assetsDir, f), path.join(outDir, f));
  }
  await writeFile(path.join(outDir, "timeline.js"), `window.TIMELINE = ${JSON.stringify(timeline)}\n`);
  await writeFile(path.join(outDir, "timeline.json"), `${JSON.stringify(timeline, null, 2)}\n`);
}
