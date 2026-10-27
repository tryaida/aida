import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runImportPlaywright } from "../../src/commands/import-playwright.js";

const SPEC = `
import { expect, test } from '@playwright/test';

test('ui: add a thing', async ({ page }) => {
  await page.goto('/things');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText('Added')).toBeVisible();
});

test('ui: a second scenario', async ({ page }) => {
  await page.goto('/things');
  await page.getByLabel('Name').fill('Widget');
});
`;

describe("runImportPlaywright", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "aida-import-playwright-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes one draft yaml per test(), next to the input by default", async () => {
    const input = path.join(dir, "things.spec.ts");
    await writeFile(input, SPEC, "utf8");

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await runImportPlaywright(input, undefined, false);
      expect(code).toBe(0);
    } finally {
      log.mockRestore();
    }

    const out1 = await readFile(path.join(dir, "things.ui-add-a-thing.yaml"), "utf8");
    expect(out1).toContain("walkthrough: ui-add-a-thing");
    const out2 = await readFile(path.join(dir, "things.ui-a-second-scenario.yaml"), "utf8");
    expect(out2).toContain("walkthrough: ui-a-second-scenario");
  });

  it("writes drafts into --out when given, and reports mapped/unmapped counts as JSON", async () => {
    const input = path.join(dir, "things.spec.ts");
    await writeFile(input, SPEC, "utf8");
    const outDir = path.join(dir, "drafts");

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let payload: { files: number; drafts: Array<{ mapped: number; unmapped: number }> };
    try {
      const code = await runImportPlaywright(input, outDir, true);
      expect(code).toBe(0);
      payload = JSON.parse(log.mock.calls[0][0] as string);
    } finally {
      log.mockRestore();
    }

    expect(payload.files).toBe(1);
    expect(payload.drafts).toHaveLength(2);
    expect(payload.drafts[0].mapped).toBeGreaterThan(0);
    await readFile(path.join(outDir, "things.ui-add-a-thing.yaml"), "utf8");
  });

  it("refuses to overwrite an existing draft without --force", async () => {
    const input = path.join(dir, "things.spec.ts");
    await writeFile(input, SPEC, "utf8");
    await writeFile(path.join(dir, "things.ui-add-a-thing.yaml"), "existing: true\n", "utf8");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const code = await runImportPlaywright(input, undefined, false);
      expect(code).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
    expect(await readFile(path.join(dir, "things.ui-add-a-thing.yaml"), "utf8")).toBe("existing: true\n");
  });

  it("reports a short error, not a stack, for a glob with no matches", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const code = await runImportPlaywright(path.join(dir, "*.spec.ts"), undefined, false);
      expect(code).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("resolves a glob across a directory of spec files", async () => {
    await writeFile(path.join(dir, "things.spec.ts"), SPEC, "utf8");
    await writeFile(path.join(dir, "other.spec.ts"), SPEC.replace(/add a thing/, "add another thing"), "utf8");

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let payload: { files: number };
    try {
      const code = await runImportPlaywright(path.join(dir, "*.spec.ts"), path.join(dir, "out"), true);
      expect(code).toBe(0);
      payload = JSON.parse(log.mock.calls[0][0] as string);
    } finally {
      log.mockRestore();
    }
    expect(payload.files).toBe(2);
  });
});
