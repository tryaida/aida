// The demo's help app gets an aida-docs dependency that installs from the demo folder (the
// template's `file:../engine` only resolves inside the AIDA repo), and keeps one that already does.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoAidaSpec, fixDemoAidaDependency } from "../../src/demo/help-package.js";
import { ENGINE_ROOT } from "../../src/package-root.js";

const dirs: string[] = [];
function tmp(): string {
  // Not "aida-*": a cleaner on the dev machine deletes /tmp/aida-* folders mid-run.
  const dir = mkdtempSync(join(tmpdir(), "demo-help-package-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** help/package.json as `aida init`'s template leaves it, without the vendored engine. */
function helpApp(spec = "file:../engine"): string {
  const help = join(tmp(), "aida-demo", "help");
  mkdirSync(help, { recursive: true });
  writeFileSync(join(help, "package.json"), `${JSON.stringify({ name: "help", dependencies: { next: "15.5.0", "aida-docs": spec } }, null, 2)}\n`);
  return help;
}
const specOf = (help: string) => (JSON.parse(readFileSync(join(help, "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies["aida-docs"];

describe("demoAidaSpec", () => {
  it("is the installed engine's own version, or a source checkout itself", () => {
    const installed = join(tmp(), "lib", "node_modules", "aida-docs");
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "aida-docs", version: "9.8.7" }));
    expect(demoAidaSpec(installed)).toBe("9.8.7");
    expect(demoAidaSpec("/home/u/aida/packages/engine")).toBe("file:/home/u/aida/packages/engine");
  });

  it("points at a checkout that is this engine, when the tests run from one", () => {
    const spec = demoAidaSpec();
    expect(spec).toBe(`file:${ENGINE_ROOT}`);
    expect(JSON.parse(readFileSync(join(spec.slice("file:".length), "package.json"), "utf8")).name).toBe("aida-docs");
  });
});

describe("fixDemoAidaDependency", () => {
  it("replaces the template's file:../engine, which doesn't exist in a demo folder", () => {
    const help = helpApp();
    expect(fixDemoAidaDependency(help, "0.2.0")).toBe(true);
    expect(specOf(help)).toBe("0.2.0");
    expect(JSON.parse(readFileSync(join(help, "package.json"), "utf8")).dependencies.next).toBe("15.5.0");
  });

  it("keeps a spec that installs: the engine --site packs into help/vendor, or the person's own", () => {
    const help = helpApp("file:vendor/aida-docs-0.2.0-abc.tgz");
    mkdirSync(join(help, "vendor"));
    writeFileSync(join(help, "vendor", "aida-docs-0.2.0-abc.tgz"), "x");
    expect(fixDemoAidaDependency(help, "0.2.0")).toBe(false);
    expect(specOf(help)).toBe("file:vendor/aida-docs-0.2.0-abc.tgz");
    const own = helpApp("^0.2.0");
    expect(fixDemoAidaDependency(own, "0.3.0")).toBe(false);
    expect(specOf(own)).toBe("^0.2.0");
  });
});
