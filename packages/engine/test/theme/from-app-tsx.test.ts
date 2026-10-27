// `aida theme --from-app` under tsx (M36): it masks the page before the logo shot with capture's
// masking, whose page.evaluate callbacks get esbuild's `__name(...)` wrapping under tsx and threw
// `masking failed: … __name is not defined`. Vitest's transform doesn't add that wrapping, so
// this runs readBrandFromApp in a real `npx tsx` child against a fictional Acme page.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const engineRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// In the system temp dir, never the repo: the script imports only node built-ins and from-app.ts
// (by absolute path), which resolves `playwright` from the engine package itself.
const dir = mkdtempSync(join(tmpdir(), "aida-tsx-from-app-"));
const script = join(dir, "from-app.mts");
writeFileSync(
  script,
  `import { createServer } from "node:http";
import { readBrandFromApp } from ${JSON.stringify(join(engineRoot, "src/theme/from-app.ts"))};
const html = '<!doctype html><html><head><title>Acme Events</title></head><body style="margin:0;display:flex">' +
  '<aside style="width:220px;min-height:100vh;background:#1e1b4b;padding:16px"><a class="home" href="/" style="color:#fff;font-weight:800">' +
  '<svg width="28" height="28"><rect width="28" height="28" rx="7" fill="#818cf8"/></svg><span>Acme Events</span></a></aside>' +
  '<main style="padding:32px"><table><tr><td>Call <b>Jo</b> on 0412 345 678 or jo@example.com</td></tr></table>' +
  '<button style="background:#4f46e5;color:#fff;border:0;border-radius:8px;height:38px;padding:0 16px">New event</button></main></body></html>';
const server = createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end(html); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
try {
  const out = await readBrandFromApp({ baseUrl: "http://127.0.0.1:" + port, pages: ["/"], assetsDir: ${JSON.stringify(join(dir, "assets"))}, mask: { selectors: [".home span"] } });
  console.log("ok pages=" + out.pages.length);
} catch (e) {
  console.log("error=" + String(e).split("\\n")[0]);
} finally {
  server.close();
}
`,
);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function runTsx(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", script], { cwd: engineRoot });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("tsx theme --from-app run timed out"));
    }, 90_000);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

describe("theme --from-app under tsx", () => {
  it("masks and reads the brand without `__name is not defined`", async () => {
    const out = await runTsx();
    expect(out).not.toMatch(/__name/);
    expect(out).toMatch(/ok pages=1/);
  }, 120_000);
});
