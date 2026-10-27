// Personal-data masking runs on every screenshot and now fails closed, so a `__name is not
// defined` error under tsx (see capture/init-scripts.ts) would fail every captured step in dev.
// Vitest's transform doesn't add tsx's `__name` wrapping, so this runs the masking code in a real
// `npx tsx` child process, with and without the shim the capture runner installs.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const engineRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Inside the engine package so the script can resolve `playwright`.
const dir = mkdtempSync(join(engineRoot, ".tsx-mask-test-"));
const script = join(dir, "mask.mts");
writeFileSync(
  script,
  `import { chromium } from "playwright";
import { applyPersonalDataMask } from ${JSON.stringify(join(engineRoot, "src/capture/mask.ts"))};
import { NAME_SHIM_SCRIPT } from ${JSON.stringify(join(engineRoot, "src/capture/init-scripts.ts"))};
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  if (process.argv[2] === "shim") await context.addInitScript(NAME_SHIM_SCRIPT);
  const page = await context.newPage();
  await page.setContent("<table><tr><td>Call <b>Jo</b> on 0412 345 678 or jo@realmail.com</td></tr></table>");
  await applyPersonalDataMask(page);
  console.log("masked=" + (await page.evaluate("document.querySelectorAll('[data-aida-masked]').length")));
} catch (e) {
  console.log("error=" + String(e).split("\\n")[0]);
} finally {
  await browser.close();
}
`,
);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function runTsx(arg: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", script, arg], { cwd: engineRoot });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("tsx masking run timed out"));
    }, 90_000);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

describe("personal-data masking under tsx", () => {
  it("masks mixed content when the __name shim is installed", async () => {
    const out = await runTsx("shim");
    expect(out).toMatch(/masked=[1-9]/);
  }, 120_000);

  it("would fail without the shim (proves the test reproduces the tsx bug)", async () => {
    const out = await runTsx("noshim");
    expect(out).toMatch(/__name is not defined/);
  }, 120_000);
});
