// `aida init` writes the detected brand into aida.config.ts (asset paths relative to the
// config) and the help app's generated theme files; `aida theme` rewrites them from config.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInitCommand } from "../../src/commands/init.js";
import { fakeInstall } from "../init/fake-runner.js";
import { runThemeCommand } from "../../src/commands/theme.js";

const createdDirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-init-theme-test-"));
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

function fakeApp(dir: string): void {
  write(dir, "package.json", JSON.stringify({ name: "acme-portal" }));
  write(dir, "app/layout.tsx", `export const metadata = { title: "Acme - Field service" };\n`);
  write(dir, "app/globals.css", `:root { --primary: 160 84% 30%; --background: 0 0% 98%; --radius: 0.5rem; }\n.dark { --primary: 160 70% 50%; }\n`);
  write(dir, "public/acme-logo.svg", "<svg/>");
  write(dir, "public/acme-logo-white.svg", "<svg fill='white'/>");
}

describe("aida init brand + theme", () => {
  it("writes the detected brand into config and the scaffolded app's theme files", () => {
    const dir = tmpDir();
    fakeApp(dir);

    const result = runInitCommand({ dir, ...fakeInstall(dir) });
    expect(result.brand.name).toBe("Acme");
    expect(result.brand.logo).toBe("../public/acme-logo.svg");
    expect(result.brand.logoDark).toBe("../public/acme-logo-white.svg");
    expect(result.theme?.warnings).toEqual([]);

    const help = join(dir, "help");
    const config = readFileSync(join(help, "aida.config.ts"), "utf8");
    expect(config).toContain('name: "Acme"');
    expect(config).toContain('logo: "../public/acme-logo.svg"');
    expect(config).toMatch(/dark: \{\n\s+primary: "160 70% 50%",/);

    const css = readFileSync(join(help, "app", "brand.css"), "utf8");
    expect(css).toContain("--brand-primary: hsl(160 84% 30%);");
    expect(css).toContain("--brand-radius: 0.5rem;");
    expect(readFileSync(join(help, "public", "brand", "logo.svg"), "utf8")).toBe("<svg/>");
    expect(JSON.parse(readFileSync(join(help, "lib", "brand.json"), "utf8")).logoDark).toBe("/brand/logo-dark.svg");
  });

  it("leaves theme files alone when the config already existed", () => {
    const dir = tmpDir();
    fakeApp(dir);
    write(dir, "help/aida.config.ts", "// mine\n");
    const result = runInitCommand({ dir, ...fakeInstall(dir) });
    expect(result.config.written).toBe(false);
    expect(result.theme).toBeUndefined();
  });

  it("aida theme rewrites the theme from config, and --detect only prints a suggestion", async () => {
    const dir = tmpDir();
    fakeApp(dir);
    write(
      dir,
      "help/aida.config.mjs",
      `export default { app: { baseUrl: "http://localhost:3000" }, walkthroughsDir: "./walkthroughs", helpApp: ".", brand: { name: "Acme", primaryColor: "#0f766e", logo: "../public/acme-logo.svg" } };\n`,
    );

    const out = await runThemeCommand({ dir });
    expect(out.mode).toBe("write");
    const css = readFileSync(join(dir, "help", "app", "brand.css"), "utf8");
    expect(css).toContain("--brand-primary: #0f766e;");
    expect(existsSync(join(dir, "help", "public", "brand", "logo.svg"))).toBe(true);

    const again = await runThemeCommand({ dir });
    expect(again.mode === "write" && again.result.written).toEqual([]);

    const detect = await runThemeCommand({ dir, detect: true, appRepo: dir });
    expect(detect.mode).toBe("detect");
    if (detect.mode === "detect") {
      expect(detect.brand.primaryColor).toBe("160 84% 30%");
      expect(detect.brand.logo).toBe("../public/acme-logo.svg");
      expect(detect.block).toContain('primaryColor: "160 84% 30%"');
    }
    // --detect never touches the theme files.
    expect(readFileSync(join(dir, "help", "app", "brand.css"), "utf8")).toBe(css);
  });
});
