import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../../src/config/types.js";
import type { Walkthrough } from "../../src/walkthrough/index.js";
import { runCapture } from "../../src/capture/runner.js";
import { startFixtureServer, type FixtureServer } from "./fixture-server.js";

const __createdTmpDirs: string[] = [];

let server: FixtureServer;

beforeEach(async () => {
  server = await startFixtureServer();
});

afterEach(async () => {
  await server.close();
  while (__createdTmpDirs.length) rmSync(__createdTmpDirs.pop()!, { recursive: true, force: true });
});

function baseConfig(baseUrl: string): ResolvedConfig {
  return {
    app: { baseUrl },
    configDir: tmpdir(),
    walkthroughsDir: tmpdir(),
    outDir: tmpdir(),
    buildDir: tmpdir(),
    viewport: { width: 1024, height: 768 },
    deviceScaleFactor: 1,
  };
}

function tmpOutDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-capture-redact-test-"));
  __createdTmpDirs.push(dir);
  return dir;
}

describe(
  "runCapture masked-field redaction (bug: typed text into a masked field was stored in plain text in manifest/validation checks)",
  () => {
    it(
      "redacts the typed text and resulting value for a field named in step.mask",
      async () => {
        const walkthrough: Walkthrough = {
          walkthrough: "fixture-redact-masked-type",
          title: "t",
          start: { page: "/" },
          steps: [
            {
              id: "enter-email",
              mask: ["Email"],
              actions: [
                { do: "click", target: { label: "Email" } },
                { do: "type", target: { label: "Email" }, text: "secret.person@example.com" },
              ],
            },
          ],
        };

        const result = await runCapture({ walkthrough, config: baseConfig(server.url), outDir: tmpOutDir() });
        expect(result.validation.ok).toBe(true);

        const step = result.manifest.steps.find((s) => s.id === "enter-email");
        const typeCheck = step?.checks.find((c) => "type" in c) as { text?: string; value?: unknown } | undefined;
        expect(typeCheck?.text).toBe("[REDACTED]");
        expect(typeCheck?.value).toBe("[REDACTED]");
        expect(JSON.stringify(result.manifest)).not.toContain("secret.person@example.com");
        expect(JSON.stringify(result.validation)).not.toContain("secret.person@example.com");
      },
      20_000,
    );

    it(
      "leaves an unmasked field's typed text/value as-is",
      async () => {
        const walkthrough: Walkthrough = {
          walkthrough: "fixture-no-redact-unmasked-type",
          title: "t",
          start: { page: "/" },
          steps: [
            {
              id: "enter-name",
              actions: [
                { do: "click", target: { label: "First name" } },
                { do: "type", target: { label: "First name" }, text: "Ada Lovelace" },
              ],
            },
          ],
        };

        const result = await runCapture({ walkthrough, config: baseConfig(server.url), outDir: tmpOutDir() });
        const step = result.manifest.steps.find((s) => s.id === "enter-name");
        const typeCheck = step?.checks.find((c) => "type" in c) as { text?: string; value?: unknown } | undefined;
        expect(typeCheck?.text).toBe("Ada Lovelace");
        expect(typeCheck?.value).toBe("Ada Lovelace");
      },
      20_000,
    );
  },
);
