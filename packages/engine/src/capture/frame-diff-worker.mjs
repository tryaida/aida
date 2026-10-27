// Worker-thread entry for parallel frame diffing (M11, docs/build-plan.md). Must be plain JS
// (no TypeScript) — this is loaded by plain `node` via `worker_threads`, which, unlike the main
// process started with `npx tsx ...`, has no tsx ESM loader registered to understand `.ts`.
// Spawned and pooled by frame-diff.ts's `stabilizeFrames`; never imported directly elsewhere.
import { parentPort } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { diffPngBuffers, buffersEqual } from "./png-diff-core.mjs";

if (!parentPort) {
  throw new Error("frame-diff-worker.mjs must be run as a worker_thread");
}

parentPort.on("message", (task) => {
  const { id, newPath, prevPath, tolerance } = task;
  try {
    const newBuf = readFileSync(newPath);
    const prevBuf = readFileSync(prevPath);
    const diff = buffersEqual(newBuf, prevBuf)
      ? { changedFraction: 0, dimensionsMatch: true }
      : diffPngBuffers(newBuf, prevBuf, tolerance);
    parentPort.postMessage({ id, ...diff });
  } catch (err) {
    // Treat any read/decode failure the same way the sync path does: fully changed, never crash
    // the pool over one bad frame.
    parentPort.postMessage({ id, changedFraction: 1, dimensionsMatch: false, error: String(err) });
  }
});
