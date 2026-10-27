import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVoiceManifest } from "../../src/commands/voice.js";
import type { ResolvedConfig } from "../../src/config/index.js";
import type { Walkthrough } from "../../src/walkthrough/index.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "aida-voice-cache-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("buildVoiceManifest: voice cache location", () => {
  it("keeps the cache next to the config, whatever folder aida runs from", async () => {
    const configDir = tmp();
    const elsewhere = tmp();
    const config = {
      configDir,
      app: { baseUrl: "http://127.0.0.1:3000" },
      walkthroughsDir: join(configDir, "walkthroughs"),
      outDir: join(configDir, "help"),
      buildDir: join(configDir, ".build"),
    } as ResolvedConfig;
    const wf = {
      walkthrough: "w",
      title: "W",
      voice: { provider: "silent" },
      steps: [{ id: "s1", say: "Hello there.", actions: [] }],
    } as unknown as Walkthrough;

    const cwd = process.cwd();
    process.chdir(elsewhere);
    try {
      const first = await buildVoiceManifest(wf, config, join(configDir, ".build", "w", "voice"));
      expect(first.skipped).toBe(false);
    } finally {
      process.chdir(cwd);
    }

    expect(existsSync(join(configDir, ".aida-cache", "voice"))).toBe(true);
    expect(readdirSync(join(configDir, ".aida-cache", "voice")).length).toBeGreaterThan(0);
    expect(existsSync(join(elsewhere, ".aida-cache"))).toBe(false);

    // A second run from the repo root (a different cwd again) hits the same cache.
    const second = await buildVoiceManifest(wf, config, join(configDir, ".build", "w", "voice"));
    expect(second.skipped).toBe(true);
  });
});
