// `aida init` (build-plan.md M25): packs the engine into help/vendor and points the help app at
// it (decisions #29), installs dependencies unless --no-install, writes tunnel hosts, and writes
// an Auth.js sign-in adapter when it sees Auth.js. The npm runner is faked throughout.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInitCommand } from "../../src/commands/init.js";
import { isRegistrySpec } from "../../src/init/install.js";
import { fakeRunner } from "../init/fake-runner.js";

const createdDirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-init-install-test-"));
  createdDirs.push(dir);
  return dir;
}
function write(dir: string, rel: string, content: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
}
afterEach(() => {
  while (createdDirs.length > 0) rmSync(createdDirs.pop()!, { recursive: true, force: true });
});

function fakeApp(dir: string, deps: Record<string, string> = { next: "16.0.0" }): void {
  write(dir, "package.json", JSON.stringify({ name: "acme", dependencies: deps }));
  write(dir, "app/page.tsx", "export default function Page() { return null; }\n");
}

function helpPackage(dir: string): { dependencies: Record<string, string>; devDependencies?: Record<string, string>; scripts: Record<string, string> } {
  return JSON.parse(readFileSync(join(dir, "help", "package.json"), "utf8"));
}

describe("aida init: engine tarball", () => {
  it("never leaves a registry spec for aida in the scaffolded package.json", () => {
    const dir = tmpDir();
    fakeApp(dir);
    const f = fakeRunner(dir);
    const result = runInitCommand({ dir, runner: f.run, engineDir: f.engineDir });

    const pkg = helpPackage(dir);
    expect(pkg.dependencies.aida).toMatch(/^file:vendor\/aida-0\.0\.1-[0-9a-f]{10}\.tgz$/);
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const) {
      const spec = (pkg as Record<string, Record<string, string> | undefined>)[field]?.aida;
      if (spec !== undefined) expect(isRegistrySpec(spec)).toBe(false);
    }
    expect(existsSync(join(dir, "help", pkg.dependencies.aida.slice("file:".length)))).toBe(true);
    expect(result.engine).toMatchObject({ spec: pkg.dependencies.aida, built: true, packageJsonUpdated: true });
  });

  it("the template itself doesn't use a registry spec for aida", () => {
    const template = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "help-app", "package.json"), "utf8"));
    expect(isRegistrySpec(template.dependencies.aida)).toBe(false);
  });

  it("builds, packs, then installs in the help app, in that order", () => {
    const dir = tmpDir();
    fakeApp(dir);
    const f = fakeRunner(dir);
    const result = runInitCommand({ dir, runner: f.run, engineDir: f.engineDir });
    // `npm pack` runs in a staged copy of the engine (the runtime build with a pruned package.json).
    expect(f.calls.map((c) => [c.args[0], c.opts.cwd])).toEqual([
      ["run", f.engineDir],
      ["pack", expect.stringMatching(/aida-pack-/)],
      ["install", join(dir, "help")],
    ]);
    expect(result.installed).toBe(true);
  });

  it("--no-install skips npm install and says how in the next steps", () => {
    const dir = tmpDir();
    fakeApp(dir);
    const f = fakeRunner(dir);
    const result = runInitCommand({ dir, runner: f.run, engineDir: f.engineDir, install: false });
    expect(f.calls.some((c) => c.args[0] === "install")).toBe(false);
    expect(result.installed).toBe(false);
    expect(result.nextSteps[0]).toMatch(/npm install/);
    expect(result.nextSteps.join("\n")).toMatch(/next build && npx next start/);
  });

  it("a re-run refreshes the tarball and the dependency and keeps the user's own edits", () => {
    const dir = tmpDir();
    fakeApp(dir);
    const first = fakeRunner(dir, { version: "0.0.1" });
    const firstResult = runInitCommand({ dir, runner: first.run, engineDir: first.engineDir, install: false });

    const pkgFile = join(dir, "help", "package.json");
    const edited = helpPackage(dir);
    edited.scripts.mine = "echo mine";
    edited.dependencies["left-pad"] = "1.3.0";
    writeFileSync(pkgFile, JSON.stringify(edited, null, 2) + "\n");
    writeFileSync(join(dir, "help", "app", "page.tsx"), "// my page\n");

    const second = fakeRunner(dir, { version: "0.0.2" });
    const result = runInitCommand({ dir, runner: second.run, engineDir: second.engineDir, install: false });
    const pkg = helpPackage(dir);
    expect(pkg.dependencies.aida).toMatch(/^file:vendor\/aida-0\.0\.2-[0-9a-f]{10}\.tgz$/);
    expect(pkg.dependencies["left-pad"]).toBe("1.3.0");
    expect(pkg.scripts.mine).toBe("echo mine");
    expect(readFileSync(join(dir, "help", "app", "page.tsx"), "utf8")).toBe("// my page\n");
    expect(existsSync(firstResult.engine.tarball)).toBe(false);
    expect(result.engine.removed).toEqual([firstResult.engine.spec.slice("file:vendor/".length)]);
  });

  it("fails clearly when packing fails", () => {
    const dir = tmpDir();
    fakeApp(dir);
    const f = fakeRunner(dir, { failOn: "pack" });
    expect(() => runInitCommand({ dir, runner: f.run, engineDir: f.engineDir })).toThrow(/npm pack/);
  });

  it("a re-run whose pack fails keeps the tarball package.json still points at", () => {
    const dir = tmpDir();
    fakeApp(dir);
    const first = fakeRunner(dir);
    const firstResult = runInitCommand({ dir, runner: first.run, engineDir: first.engineDir, install: false });
    const broken = fakeRunner(dir, { version: "0.0.2", badTarball: true });
    expect(() => runInitCommand({ dir, runner: broken.run, engineDir: broken.engineDir, install: false })).toThrow(/gzip/);
    expect(helpPackage(dir).dependencies.aida).toBe(firstResult.engine.spec);
    expect(readdirSync(join(dir, "help", "vendor"))).toEqual([firstResult.engine.spec.slice("file:vendor/".length)]);
  });
});

describe("aida init: tunnel hosts", () => {
  it("writes --tunnel-host into help/.env.local, merging with what's there", () => {
    const dir = tmpDir();
    fakeApp(dir);
    write(dir, "help/.env.local", "ANTHROPIC_API_KEY=keep\n");
    const f = fakeRunner(dir);
    const result = runInitCommand({ dir, runner: f.run, engineDir: f.engineDir, tunnelHosts: ["https://dev.example.com/", "x.example.com"] });
    expect(result.tunnelHosts?.hosts).toEqual(["dev.example.com", "x.example.com"]);
    const env = readFileSync(join(dir, "help", ".env.local"), "utf8");
    expect(env).toMatch(/^ANTHROPIC_API_KEY=keep\n(.|\n)*AIDA_STUDIO_ALLOWED_HOSTS=dev\.example\.com,x\.example\.com\n/);
    const key = env.match(/^AIDA_STUDIO_KEY=([A-Za-z0-9_-]{43})$/m)![1];
    expect(result.tunnelHosts).toMatchObject({
      keyCreated: true,
      secretStudioUrls: [`https://dev.example.com/studio/access#key=${key}`, `https://x.example.com/studio/access#key=${key}`],
      secretLocalStudioUrl: `http://localhost:3000/studio/access#key=${key}`,
    });
    // With a key set the Studio needs the link on localhost too; the next steps say so.
    expect(result.nextSteps.join("\n")).toMatch(/npm run dev \(it listens on 127\.0\.0\.1 only.*private link once per browser, on localhost too/);

    // A second run keeps the key and the link.
    const again = runInitCommand({ dir, runner: f.run, engineDir: f.engineDir, tunnelHosts: ["dev.example.com"] });
    expect(again.tunnelHosts).toMatchObject({ keyCreated: false, secretStudioUrls: [`https://dev.example.com/studio/access#key=${key}`, `https://x.example.com/studio/access#key=${key}`] });
    expect(readFileSync(join(dir, "help", ".env.local"), "utf8")).toBe(env);
  });

  it("the help app template git-ignores .env.local, so the key is never committed", () => {
    const dir = tmpDir();
    fakeApp(dir);
    const f = fakeRunner(dir);
    runInitCommand({ dir, runner: f.run, engineDir: f.engineDir });
    expect(readFileSync(join(dir, "help", ".gitignore"), "utf8")).toMatch(/^\.env\*\.local$/m);
  });

  it("refuses a bad host before writing anything", () => {
    const dir = tmpDir();
    fakeApp(dir);
    const f = fakeRunner(dir);
    expect(() => runInitCommand({ dir, runner: f.run, engineDir: f.engineDir, tunnelHosts: ["*.example.com"] })).toThrow(/wildcard/);
    expect(existsSync(join(dir, "help"))).toBe(false);
  });
});

describe("aida init: Auth.js sign-in", () => {
  it("writes adapters/sign-in.mjs and sets signIn in the config for next-auth", () => {
    const dir = tmpDir();
    fakeApp(dir, { next: "16.0.0", "next-auth": "5.0.0-beta.30" });
    const f = fakeRunner(dir);
    const result = runInitCommand({ dir, runner: f.run, engineDir: f.engineDir });
    expect(result.signIn).toMatchObject({ file: join(dir, "help", "adapters", "sign-in.mjs"), written: true, configured: true });
    expect(readFileSync(join(dir, "help", "aida.config.ts"), "utf8")).toContain('signIn: "./adapters/sign-in.mjs",');
    expect(readFileSync(result.signIn!.file, "utf8")).toContain('"../.."');
  });

  it("recognises @auth/* packages too", () => {
    const dir = tmpDir();
    fakeApp(dir, { next: "16.0.0", "@auth/drizzle-adapter": "1.0.0" });
    const f = fakeRunner(dir);
    expect(runInitCommand({ dir, runner: f.run, engineDir: f.engineDir }).signIn?.written).toBe(true);
  });

  it("writes no adapter for other sign-in libraries", () => {
    const dir = tmpDir();
    fakeApp(dir, { next: "16.0.0", "@clerk/nextjs": "6.0.0" });
    const f = fakeRunner(dir);
    const result = runInitCommand({ dir, runner: f.run, engineDir: f.engineDir });
    expect(result.signIn).toBeUndefined();
    expect(readFileSync(join(dir, "help", "aida.config.ts"), "utf8")).not.toContain("signIn");
  });

  it("asks for signIn by hand when the config already existed", () => {
    const dir = tmpDir();
    fakeApp(dir, { next: "16.0.0", "next-auth": "4.24.0" });
    write(dir, "help/aida.config.ts", "// mine\n");
    const f = fakeRunner(dir);
    const result = runInitCommand({ dir, runner: f.run, engineDir: f.engineDir });
    expect(result.signIn?.configured).toBe(false);
    expect(result.nextSteps.join("\n")).toContain('add signIn: "./adapters/sign-in.mjs"');
    expect(readFileSync(join(dir, "help", "aida.config.ts"), "utf8")).toBe("// mine\n");
  });
});

describe("aida init: re-run with signIn already configured", () => {
  it("doesn't ask to add signIn again", () => {
    const dir = tmpDir();
    fakeApp(dir, { next: "16.0.0", "next-auth": "5.0.0-beta.30" });
    const f = fakeRunner(dir);
    runInitCommand({ dir, runner: f.run, engineDir: f.engineDir, install: false });
    const again = runInitCommand({ dir, runner: f.run, engineDir: f.engineDir, install: false });
    expect(again.signIn).toMatchObject({ written: false, configured: true });
    expect(again.nextSteps.join("\n")).not.toContain("add signIn");
  });
});

describe("aida init: written config", () => {
  it("advises a production build and names the app's folder as app.dir", () => {
    const dir = tmpDir();
    fakeApp(dir);
    const f = fakeRunner(dir);
    runInitCommand({ dir, runner: f.run, engineDir: f.engineDir });
    const config = readFileSync(join(dir, "help", "aida.config.ts"), "utf8");
    expect(config).toContain("`next build && next start`");
    expect(config).toMatch(/app: \{[^}]*dir: "\.\.",/s);
  });
});
