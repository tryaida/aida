// Regression test for the "build" bug: `npm run build -w packages/engine` (plain `tsc -b`) only
// ever emitted TypeScript sources, so `frame-diff-worker.mjs` (hand-written, not compiled from a
// .ts file) never made it into dist/capture — the worker pool construction in frame-diff.ts then
// always failed to load the module and silently fell back to the synchronous path. The fix adds a
// copy step to the engine's `build` script; this proves both `.mjs` files the capture pipeline
// needs at runtime actually land in dist/capture after a real build.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = join(here, "..", "..");

describe("engine build output (bug: frame-diff-worker.mjs never reached dist/capture)", () => {
  it(
    "copies both frame-diff-worker.mjs and png-diff-core.mjs into dist/capture",
    () => {
      const distCapture = join(ENGINE_ROOT, "dist", "capture");
      rmSync(join(distCapture, "frame-diff-worker.mjs"), { force: true });
      rmSync(join(distCapture, "png-diff-core.mjs"), { force: true });

      execFileSync("npm", ["run", "build"], { cwd: ENGINE_ROOT, stdio: "pipe" });

      expect(existsSync(join(distCapture, "frame-diff-worker.mjs"))).toBe(true);
      expect(existsSync(join(distCapture, "png-diff-core.mjs"))).toBe(true);
    },
    120_000,
  );
});
