import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.join(__dirname, "..", "..");

const createdDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-config-test-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    rmSync(createdDirs.pop()!, { recursive: true, force: true });
  }
});

describe("loadConfig", () => {
  it("loads a .mjs config with defineConfig and resolves paths relative to it", async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, "aida.config.mjs"),
      `
      export default {
        app: { baseUrl: "http://127.0.0.1:3100" },
        walkthroughsDir: "./walkthroughs",
        viewport: { width: 1440, height: 810 },
      };
      `,
    );
    const config = await loadConfig(join(dir, "aida.config.mjs"));
    expect(config.app.baseUrl).toBe("http://127.0.0.1:3100");
    expect(config.walkthroughsDir).toBe(join(dir, "walkthroughs"));
    expect(config.outDir).toBe(join(dir, "help"));
    expect(config.buildDir).toBe(join(dir, ".build"));
  });

  it("resolves a signIn adapter given as a module path", async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, "sign-in.mjs"),
      `export default async function signIn() { globalThis.__signedIn = true; }`,
    );
    writeFileSync(
      join(dir, "aida.config.mjs"),
      `
      export default {
        app: { baseUrl: "http://127.0.0.1:3100" },
        walkthroughsDir: "./walkthroughs",
        signIn: "./sign-in.mjs",
      };
      `,
    );
    const config = await loadConfig(join(dir, "aida.config.mjs"));
    expect(typeof config.signIn).toBe("function");
    await config.signIn?.({ page: {} as never, context: {} as never, baseUrl: "x", env: {} });
    expect((globalThis as { __signedIn?: boolean }).__signedIn).toBe(true);
  });

  it("resolves capture frame-diff defaults, and keeps explicit overrides", async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, "aida.config.mjs"),
      `export default { app: { baseUrl: "http://127.0.0.1:3100" }, walkthroughsDir: "./w" };`,
    );
    const defaults = await loadConfig(join(dir, "aida.config.mjs"));
    expect(defaults.capture).toEqual({ frameDiffThreshold: 0.001, frameDiffTolerance: 8, maxTypeMs: 1500 });

    // Separate dir: loadConfig's `?t=Date.now()` cache-buster can collide within one millisecond.
    const dir2 = tmpDir();
    writeFileSync(
      join(dir2, "aida.config.mjs"),
      `export default { app: { baseUrl: "http://127.0.0.1:3100" }, walkthroughsDir: "./w", capture: { frameDiffThreshold: 0.01 } };`,
    );
    const overridden = await loadConfig(join(dir2, "aida.config.mjs"));
    expect(overridden.capture).toEqual({ frameDiffThreshold: 0.01, frameDiffTolerance: 8, maxTypeMs: 1500 });
  });

  it("throws a clear error when app.baseUrl is missing", async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, "aida.config.mjs"),
      `export default { walkthroughsDir: "./walkthroughs" };`,
    );
    await expect(loadConfig(join(dir, "aida.config.mjs"))).rejects.toThrow(/baseUrl/);
  });
});

// Loading a `.ts` config needs to work both when the calling process already has tsx's own ESM
// loader active (started as `tsx <script>` / `npx tsx <script>`, as the CLI usually is — see
// cli.ts) and when it doesn't (a plain `node` process, e.g. the published, built CLI). Both are
// exercised with real child processes — not vitest's own module runner, which transparently
// transforms `.ts` imports regardless of what loadConfig does, so it would mask either bug (the
// "tsx must be loaded with --import instead of --loader" crash this fixes).
describe("loadConfig — .ts config, real process boundary", () => {
  const distLoadFile = join(engineRoot, "dist", "config", "load.js");

  beforeAll(() => {
    if (!existsSync(distLoadFile)) {
      // The engine's own build script (not a bare `tsc -b`) — it also copies the capture
      // worker .mjs files dist needs, matching how a real published build is produced.
      execSync("npm run build", { cwd: engineRoot, stdio: "pipe" });
    }
  }, 120_000);

  function writeTsConfigFixture(dir: string): string {
    const walkthroughsDir = join(dir, "walkthroughs");
    writeFileSync(
      join(dir, "aida.config.ts"),
      `
      const config = {
        app: { baseUrl: "http://127.0.0.1:3100" },
        walkthroughsDir: ${JSON.stringify(walkthroughsDir)},
      };
      export default config;
      `,
    );
    return join(dir, "aida.config.ts");
  }

  it("loads a .ts config when the process is already running under tsx", () => {
    const dir = tmpDir();
    const configFile = writeTsConfigFixture(dir);
    const harness = join(dir, "harness.mjs");
    const loadTs = join(__dirname, "..", "..", "src", "config", "load.ts");
    writeFileSync(
      harness,
      `
      import { loadConfig } from ${JSON.stringify(pathToFileUrl(loadTs))};
      const config = await loadConfig(${JSON.stringify(configFile)});
      console.log(JSON.stringify({ baseUrl: config.app.baseUrl }));
      `,
    );
    const out = execFileSync("npx", ["tsx", harness], { cwd: engineRoot, encoding: "utf8" });
    expect(JSON.parse(out.trim())).toEqual({ baseUrl: "http://127.0.0.1:3100" });
  }, 30_000);

  it("loads a .ts config from a plain (non-tsx) node process, via tsx/esm/api's register()", () => {
    const dir = tmpDir();
    const configFile = writeTsConfigFixture(dir);
    const harness = join(dir, "harness.mjs");
    writeFileSync(
      harness,
      `
      import { loadConfig } from ${JSON.stringify(pathToFileUrl(distLoadFile))};
      const config = await loadConfig(${JSON.stringify(configFile)});
      console.log(JSON.stringify({ baseUrl: config.app.baseUrl }));
      `,
    );
    const out = execFileSync(process.execPath, [harness], { cwd: engineRoot, encoding: "utf8" });
    expect(JSON.parse(out.trim())).toEqual({ baseUrl: "http://127.0.0.1:3100" });
  }, 30_000);

  // Regression for the bug found measuring first-capture rate on a pilot app: a plain `.mjs`
  // config (no tsx needed for itself) whose `signIn` adapter is a `.ts` file used to throw
  // ERR_UNKNOWN_FILE_EXTENSION ".ts" under a plain `node dist/cli.js inspect|capture` — adapters
  // were resolved after the config's own extension check, with a plain dynamic `import()` that
  // never registered tsx. Exercised the same way as the two tests above: a real child process
  // running the built dist, not vitest's module runner.
  it("loads a .mjs config whose signIn adapter is a .ts file, from a plain (non-tsx) node process", () => {
    const dir = tmpDir();
    // Plain-JS-shaped body, like the `.ts` config fixture above: a `.ts` adapter whose own
    // syntax needs esbuild's TS transform (type annotations, `interface`, etc.) hits a separate,
    // pre-existing tsx/Node interaction — a dynamic `import()` of a bare `.ts` path, registered
    // via runtime `tsx/esm/api` `register()` rather than tsx's own `--import`-started loader,
    // can fall to Node's CJS loader (which never runs tsx's esbuild transform) when the file
    // isn't inside a package declaring `"type": "module"`. That also affects the plain `.ts`
    // *config* case above the same way, so it's not specific to adapter resolution — out of scope
    // for this fix, which is only that an adapter gets tsx support *at all* (previously it never
    // did, regardless of syntax).
    writeFileSync(
      join(dir, "sign-in.ts"),
      `
      export default async function signIn(_ctx) {
        globalThis.__signedInTs = true;
      }
      `,
    );
    writeFileSync(
      join(dir, "aida.config.mjs"),
      `
      export default {
        app: { baseUrl: "http://127.0.0.1:3100" },
        walkthroughsDir: "./walkthroughs",
        signIn: "./sign-in.ts",
      };
      `,
    );
    const harness = join(dir, "harness.mjs");
    writeFileSync(
      harness,
      `
      import { loadConfig } from ${JSON.stringify(pathToFileUrl(distLoadFile))};
      const config = await loadConfig(${JSON.stringify(join(dir, "aida.config.mjs"))});
      await config.signIn({ page: {}, context: {}, baseUrl: "x", env: {} });
      console.log(JSON.stringify({ signedIn: globalThis.__signedInTs === true, type: typeof config.signIn }));
      `,
    );
    const out = execFileSync(process.execPath, [harness], { cwd: engineRoot, encoding: "utf8" });
    expect(JSON.parse(out.trim())).toEqual({ signedIn: true, type: "function" });
  }, 30_000);
});

function pathToFileUrl(p: string): string {
  return new URL(`file://${p}`).href;
}
