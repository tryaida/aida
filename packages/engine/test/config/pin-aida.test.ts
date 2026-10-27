// A config's `import ... from "aida"` must load the running engine, never a `node_modules/aida`
// next to the config: the registry name belongs to an unrelated package (decisions #29), and CI
// loads the config with GITHUB_TOKEN set. Each fixture puts an impostor there that throws and sets
// a global, then loads the config in vitest, under `tsx` from source, and from the built dist.
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { runningEngineFile } from "../../src/config/pin-aida.js";

const engineRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const createdDirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-pin-test-"));
  createdDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (createdDirs.length > 0) rmSync(createdDirs.pop()!, { recursive: true, force: true });
});

/** A folder with an impostor `node_modules/aida` (CJS and ESM entries both throw), a config that
 * imports `defineConfig` and an `aida/...` subpath, and a sign-in adapter that imports aida too. */
function fixture(ext: "mjs" | "ts", opts: { typeModule?: boolean } = {}): string {
  const dir = tmpDir();
  const impostor = join(dir, "node_modules", "aida");
  mkdirSync(join(impostor, "dist"), { recursive: true });
  const boom = `globalThis.__aidaImpostor = true; throw new Error("impostor aida loaded");\n`;
  writeFileSync(join(impostor, "package.json"), JSON.stringify({ name: "aida", version: "9.9.9", main: "index.js" }));
  writeFileSync(join(impostor, "index.js"), boom);
  writeFileSync(join(impostor, "dist", "index.js"), boom);
  writeFileSync(join(impostor, "dist", "engine.js"), boom);
  if (opts.typeModule) writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(
    join(dir, `sign-in.${ext}`),
    `import { defineConfig } from "aida";\nexport default async function signIn() { globalThis.__pinnedAdapter = typeof defineConfig; }\n`,
  );
  writeFileSync(
    join(dir, `aida.config.${ext}`),
    `import { defineConfig, DEFAULT_CAPTURE_SETTINGS } from "aida";
import * as defineModule from "aida/dist/config/define.js";
export default defineConfig({
  app: { baseUrl: "http://127.0.0.1:3100", name: String(typeof DEFAULT_CAPTURE_SETTINGS) + "/" + String(typeof defineModule.defineConfig) },
  walkthroughsDir: "./walkthroughs",
  signIn: "./sign-in.${ext}",
});
`,
  );
  return join(dir, `aida.config.${ext}`);
}

const HARNESS = (loadUrl: string, configFile: string, legacy?: string) => `
${legacy ? `import { pinAidaToRunningEngine } from ${JSON.stringify(legacy)}; console.error(pinAidaToRunningEngine({ legacy: true }));` : ""}
import { loadConfig } from ${JSON.stringify(loadUrl)};
const config = await loadConfig(${JSON.stringify(configFile)});
await config.signIn({ page: {}, context: {}, baseUrl: "x", env: {} });
console.log(JSON.stringify({ name: config.app.name, adapter: globalThis.__pinnedAdapter, impostor: globalThis.__aidaImpostor ?? false }));
`;

/** The parent's env without VITEST, so children take loadConfig's production import path. */
const { VITEST: _vitest, ...childEnv } = process.env;

const EXPECTED = { name: "object/function", adapter: "function", impostor: false };

describe("runningEngineFile", () => {
  it("maps aida and aida/... to the running engine, from source or dist", () => {
    expect(runningEngineFile("aida", "/e", false)).toBe("/e/dist/index.js");
    expect(runningEngineFile("aida", "/e", true)).toBe("/e/src/index.ts");
    expect(runningEngineFile("aida/dist/engine.js", "/e", false)).toBe("/e/dist/engine.js");
    expect(runningEngineFile("aida/dist/engine.js", engineRoot, true)).toBe(join(engineRoot, "src", "engine.ts"));
    expect(runningEngineFile("aida-other", "/e", false)).toBeUndefined();
    expect(runningEngineFile("@scope/aida", "/e", false)).toBeUndefined();
    expect(() => runningEngineFile("aida/../../etc/passwd", "/e", false)).toThrow(/outside/);
  });
});

describe("loadConfig never loads a node_modules/aida impostor", () => {
  const distLoad = join(engineRoot, "dist", "config", "load.js");
  beforeAll(() => {
    if (!existsSync(join(engineRoot, "dist", "config", "pin-aida.js"))) execSync("npm run build", { cwd: engineRoot, stdio: "pipe" });
  }, 180_000);

  it("in vitest (.mjs config and adapter)", async () => {
    const config = await loadConfig(fixture("mjs"));
    await config.signIn?.({ page: {} as never, context: {} as never, baseUrl: "x", env: {} });
    const g = globalThis as { __aidaImpostor?: boolean; __pinnedAdapter?: string };
    expect({ name: config.app.name, adapter: g.__pinnedAdapter, impostor: g.__aidaImpostor ?? false }).toEqual(EXPECTED);
  });

  const cases: Array<{ name: string; ext: "mjs" | "ts"; typeModule?: boolean }> = [
    { name: ".mjs config", ext: "mjs" },
    { name: ".ts config compiled to CommonJS (no type: module)", ext: "ts" },
    { name: ".ts config in a type: module folder", ext: "ts", typeModule: true },
  ];
  for (const c of cases) {
    it(`${c.name}, under tsx from source`, () => {
      const configFile = fixture(c.ext, c);
      const harness = join(dirname(configFile), "harness.mjs");
      writeFileSync(harness, HARNESS(pathToFileURL(join(engineRoot, "src", "config", "load.ts")).href, configFile));
      const out = execFileSync("npx", ["tsx", harness], { cwd: engineRoot, encoding: "utf8", env: childEnv });
      expect(JSON.parse(out.trim())).toEqual(EXPECTED);
    }, 30_000);

    it(`${c.name}, under node from dist`, () => {
      const configFile = fixture(c.ext, c);
      const harness = join(dirname(configFile), "harness.mjs");
      writeFileSync(harness, HARNESS(pathToFileURL(distLoad).href, configFile));
      const out = execFileSync(process.execPath, [harness], { cwd: engineRoot, encoding: "utf8", env: childEnv });
      expect(JSON.parse(out.trim())).toEqual(EXPECTED);
    }, 30_000);

    it(`${c.name}, under node from dist with the pre-22.15 hooks`, () => {
      const configFile = fixture(c.ext, c);
      const harness = join(dirname(configFile), "harness.mjs");
      const pin = pathToFileURL(join(engineRoot, "dist", "config", "pin-aida.js")).href;
      writeFileSync(harness, HARNESS(pathToFileURL(distLoad).href, configFile, pin));
      const out = execFileSync(process.execPath, [harness], { cwd: engineRoot, encoding: "utf8", env: childEnv });
      expect(JSON.parse(out.trim())).toEqual(EXPECTED);
    }, 30_000);
  }
});
