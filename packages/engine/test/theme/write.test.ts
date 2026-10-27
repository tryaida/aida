import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BrandConfig } from "../../src/config/types.js";
import { contrastRatio } from "../../src/theme/color.js";
import { brandThemeVars, renderBrandCss, writeHelpAppTheme } from "../../src/theme/write.js";

const createdDirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-theme-test-"));
  createdDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (createdDirs.length > 0) rmSync(createdDirs.pop()!, { recursive: true, force: true });
});

const ACME: BrandConfig = {
  name: "Acme Events",
  primaryColor: "235 55% 42%",
  accentColor: "183 68% 30%",
  colors: { primaryForeground: "0 0% 100%", background: "222 26% 97%", foreground: "224 42% 14%", card: "0 0% 100%", muted: "220 24% 93%", mutedForeground: "222 16% 40%", border: "220 20% 89%" },
  dark: { primary: "236 72% 71%", primaryForeground: "234 52% 12%", accent: "181 58% 48%", background: "224 44% 7%", foreground: "213 34% 96%" },
  logo: "assets/Logo-Main.png",
  logoDark: "assets/Logo-White.png",
  icon: "assets/apple-touch-icon.png",
  font: "Inter",
  fontUrl: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
  radius: "10px",
};

function vars(list: Array<[string, string]>): Record<string, string> {
  return Object.fromEntries(list);
}

describe("brandThemeVars / renderBrandCss", () => {
  it("maps a full brand onto --brand-* and every fumadocs colour var, light and dark", () => {
    const { light, dark } = brandThemeVars(ACME);
    const l = vars(light);
    expect(l["--brand-primary"]).toBe("hsl(235 55% 42%)");
    expect(l["--brand-primary-foreground"]).toBe("hsl(0 0% 100%)");
    expect(l["--brand-accent"]).toBe("hsl(183 68% 30%)");
    expect(l["--brand-radius"]).toBe("10px");
    expect(l["--font-sans"]).toMatch(/^"Inter", system-ui/);
    for (const n of ["background", "foreground", "muted", "muted-foreground", "popover", "popover-foreground", "card", "card-foreground", "border", "primary", "primary-foreground", "secondary", "secondary-foreground", "accent", "accent-foreground", "ring"]) {
      expect(l[`--color-fd-${n}`], n).toBeDefined();
    }
    expect(l["--color-fd-background"]).toBe("hsl(222 26% 97%)");
    const d = vars(dark);
    expect(d["--brand-primary"]).toBe("hsl(236 72% 71%)");
    expect(d["--brand-primary-foreground"]).toBe("hsl(234 52% 12%)");
    expect(d["--brand-accent"]).toBe("hsl(181 58% 48%)");
    expect(d["--color-fd-background"]).toBe("hsl(224 44% 7%)");
  });

  it("with only a primary: derives a readable foreground and a lighter dark primary, leaves fumadocs surfaces alone", () => {
    const { light, dark } = brandThemeVars({ primaryColor: "#1e3a8a" });
    const l = vars(light);
    const d = vars(dark);
    expect(l["--brand-primary-foreground"]).toBe("hsl(0 0% 100%)");
    expect(l["--color-fd-background"]).toBeUndefined();
    expect(l["--color-fd-card"]).toBeUndefined();
    expect(d["--color-fd-background"]).toBeUndefined();
    expect(d["--brand-primary"]).not.toBe("#1e3a8a");
    expect(contrastRatio(d["--brand-primary"], "hsl(0 0% 7%)")!).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(d["--brand-primary-foreground"], d["--brand-primary"])!).toBeGreaterThanOrEqual(4.5);
    expect(l["--brand-accent"]).toBe("var(--brand-primary)");
  });

  it("never copies a light canvas into dark mode; derives a tinted dark one and a lighter card", () => {
    const { light, dark } = brandThemeVars({ primaryColor: "235 55% 42%", colors: { background: "#f5f7fa", foreground: "#111827" } });
    const l = vars(light);
    const d = vars(dark);
    expect(l["--color-fd-card"]).toBeDefined();
    expect(l["--color-fd-card"]).not.toBe(l["--color-fd-background"]);
    expect(d["--color-fd-background"]).toBeDefined();
    expect(d["--color-fd-background"]).not.toBe(l["--color-fd-background"]);
    expect(contrastRatio(d["--color-fd-background"], "#000")!).toBeLessThan(1.5);
    expect(d["--color-fd-foreground"]).toBeUndefined(); // fumadocs' light-on-dark default stays
  });

  it("replaces an unreadable configured primary foreground", () => {
    const l = vars(brandThemeVars({ primaryColor: "#fde047", colors: { primaryForeground: "#ffffff" } }).light);
    expect(contrastRatio(l["--brand-primary-foreground"], "#fde047")!).toBeGreaterThanOrEqual(4.5);
  });

  it("renders deterministic CSS with no @import and the template's variable names", () => {
    const a = renderBrandCss(ACME);
    expect(renderBrandCss(structuredClone(ACME))).toBe(a);
    expect(a).not.toContain("@import");
    expect(a).toMatch(/:root \{\n  --brand-primary: hsl\(235 55% 42%\);/);
    expect(a).toContain(".dark,\n:root.dark,\n:root.dark #nd-sidebar {");
    const empty = renderBrandCss(undefined);
    expect(empty).toContain("--brand-primary: hsl(235 55% 42%);");
    expect(empty).toContain("--brand-radius: 0.625rem;");
  });
});

describe("writeHelpAppTheme", () => {
  function setup() {
    const configDir = tmpDir();
    const helpApp = join(configDir, "site");
    mkdirSync(join(configDir, "assets"), { recursive: true });
    writeFileSync(join(configDir, "assets", "Logo-Main.png"), "main");
    writeFileSync(join(configDir, "assets", "Logo-White.png"), "white");
    writeFileSync(join(configDir, "assets", "apple-touch-icon.png"), "icon");
    return { configDir, helpApp };
  }

  it("writes brand.css, brand.json, public/brand assets and theme.json", () => {
    const { configDir, helpApp } = setup();
    const result = writeHelpAppTheme({ brand: ACME, configDir }, helpApp);

    expect(result.warnings).toEqual([]);
    expect(result.files.map((f) => f.slice(helpApp.length + 1))).toEqual([
      join("app", "brand.css"),
      join("lib", "brand.json"),
      join("public", "brand", "logo.png"),
      join("public", "brand", "logo-dark.png"),
      join("public", "brand", "icon.png"),
      join("public", "brand", "theme.json"),
    ]);
    expect(result.written).toHaveLength(6);
    expect(JSON.parse(readFileSync(join(helpApp, "lib", "brand.json"), "utf8"))).toEqual({
      name: "Acme Events",
      logo: "/brand/logo.png",
      logoDark: "/brand/logo-dark.png",
      icon: "/brand/icon.png",
      fontUrl: ACME.fontUrl,
    });
    expect(JSON.parse(readFileSync(join(helpApp, "public", "brand", "theme.json"), "utf8"))).toEqual({
      name: "Acme Events",
      primary: "hsl(235 55% 42%)",
      primaryForeground: "hsl(0 0% 100%)",
      logo: "/brand/logo.png",
      fontFamily: `"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`,
    });
    expect(readFileSync(join(helpApp, "public", "brand", "logo-dark.png"), "utf8")).toBe("white");
    expect(readFileSync(join(helpApp, "app", "brand.css"), "utf8")).toBe(renderBrandCss(ACME));
  });

  it("does not rewrite unchanged files (Next dev hot reload) and is byte-identical across runs", () => {
    const { configDir, helpApp } = setup();
    writeHelpAppTheme({ brand: ACME, configDir }, helpApp);
    const css = join(helpApp, "app", "brand.css");
    const old = new Date("2020-01-01T00:00:00Z");
    utimesSync(css, old, old);
    const before = readFileSync(css, "utf8");

    const again = writeHelpAppTheme({ brand: ACME, configDir }, helpApp);
    expect(again.written).toEqual([]);
    expect(statSync(css).mtime.getTime()).toBe(old.getTime());
    expect(readFileSync(css, "utf8")).toBe(before);
  });

  it("removes stale brand assets but keeps other files in public/brand", () => {
    const { configDir, helpApp } = setup();
    writeHelpAppTheme({ brand: ACME, configDir }, helpApp);
    writeFileSync(join(helpApp, "public", "brand", "hero.jpg"), "user file");
    writeFileSync(join(configDir, "assets", "logo.svg"), "<svg/>");

    const result = writeHelpAppTheme({ brand: { ...ACME, logoDark: undefined, logo: "assets/logo.svg" }, configDir }, helpApp);
    expect(result.warnings).toEqual([]);
    expect(existsSync(join(helpApp, "public", "brand", "logo-dark.png"))).toBe(false);
    expect(existsSync(join(helpApp, "public", "brand", "logo.png"))).toBe(false);
    expect(existsSync(join(helpApp, "public", "brand", "logo.svg"))).toBe(true);
    expect(existsSync(join(helpApp, "public", "brand", "icon.png"))).toBe(true);
    expect(existsSync(join(helpApp, "public", "brand", "hero.jpg"))).toBe(true);
    const json = JSON.parse(readFileSync(join(helpApp, "lib", "brand.json"), "utf8"));
    expect(json.logo).toBe("/brand/logo.svg");
    expect(json.logoDark).toBeNull();
  });

  it("keeps the last copied asset when the configured source is missing (fresh clone, CI)", () => {
    const { configDir, helpApp } = setup();
    writeHelpAppTheme({ brand: ACME, configDir }, helpApp);
    rmSync(join(configDir, "assets"), { recursive: true });

    const result = writeHelpAppTheme({ brand: ACME, configDir }, helpApp);
    expect(result.warnings).toEqual([
      expect.stringContaining("keeping public/brand/logo.png"),
      expect.stringContaining("keeping public/brand/logo-dark.png"),
      expect.stringContaining("keeping public/brand/icon.png"),
    ]);
    expect(readFileSync(join(helpApp, "public", "brand", "logo.png"), "utf8")).toBe("main");
    const json = JSON.parse(readFileSync(join(helpApp, "lib", "brand.json"), "utf8"));
    expect(json).toMatchObject({ logo: "/brand/logo.png", logoDark: "/brand/logo-dark.png", icon: "/brand/icon.png" });
  });

  it("writes defaults for a config with no brand", () => {
    const configDir = tmpDir();
    writeHelpAppTheme({ configDir }, configDir);
    expect(JSON.parse(readFileSync(join(configDir, "lib", "brand.json"), "utf8"))).toEqual({ name: "Help", logo: null, logoDark: null, icon: null, fontUrl: null });
    expect(JSON.parse(readFileSync(join(configDir, "public", "brand", "theme.json"), "utf8")).fontFamily).toBeNull();
  });

  it("builds a Google Fonts URL when only a known family is configured", () => {
    const configDir = tmpDir();
    writeHelpAppTheme({ brand: { font: "Manrope" }, configDir }, configDir);
    expect(JSON.parse(readFileSync(join(configDir, "lib", "brand.json"), "utf8")).fontUrl).toBe(
      "https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&display=swap",
    );
  });
});
