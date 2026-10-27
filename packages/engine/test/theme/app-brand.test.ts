import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveArtifactBrand } from "../../src/render/brand.js";
import { detectedReplaces, mergeAppBrand, withAppBrand, writeAppBrand } from "../../src/theme/app-brand.js";
import { writeHelpAppTheme } from "../../src/theme/write.js";

const APP = {
  name: "Acme Events",
  primaryColor: "#4f46e5",
  accentColor: "#0d9488",
  font: "Manrope",
  radius: "12px",
  shadow: "soft" as const,
  logoDark: "brand/from-app-logo-dark.png",
};

describe("mergeAppBrand: explicit config > running app > repo (M34)", () => {
  it("fills every gap in the config from the app", () => {
    const { brand, fromApp } = mergeAppBrand({ name: "Acme" }, APP);
    expect(brand).toMatchObject({ name: "Acme", primaryColor: "#4f46e5", accentColor: "#0d9488", font: "Manrope", radius: "12px", shadow: "soft" });
    expect(fromApp).not.toContain("name");
    expect(fromApp).toContain("primary");
  });

  it("keeps a value someone typed, even when the app draws something else", () => {
    const { brand } = mergeAppBrand({ primaryColor: "#dc2626", colors: { primary: "#111111" } }, APP);
    expect(brand?.primaryColor).toBe("#dc2626");
  });

  it("replaces a repo-detected value while it's unchanged, not once someone edits it", () => {
    const replaces = { primary: "235 55% 42%" };
    expect(mergeAppBrand({ primaryColor: "235 55% 42%" }, APP, replaces).brand?.primaryColor).toBe("#4f46e5");
    expect(mergeAppBrand({ primaryColor: "hsl(235 55% 42%)" }, APP, replaces).brand?.primaryColor).toBe("#4f46e5");
    expect(mergeAppBrand({ primaryColor: "#123456" }, APP, replaces).brand?.primaryColor).toBe("#123456");
  });

  it("keeps repo logo files that exist; the drawn logo fills in for a missing one", () => {
    const exists = (p: string) => p === "public/logo.svg";
    expect(mergeAppBrand({ logoDark: "public/logo.svg" }, APP, {}, exists).brand?.logoDark).toBe("public/logo.svg");
    expect(mergeAppBrand({ logoDark: "public/gone.svg" }, APP, {}, exists).brand?.logoDark).toBe("brand/from-app-logo-dark.png");
  });

  it("never takes an app-provided logo or icon that isn't a PNG aida rendered", () => {
    const { brand } = mergeAppBrand({}, { ...APP, logoDark: "brand/from-app-logo-dark.svg", icon: "brand/from-app-icon.svg" });
    expect(brand?.logoDark).toBeUndefined();
    expect(brand?.icon).toBeUndefined();
  });

  it("moves a font's stylesheet with it, and leaves it alone when the font is the same", () => {
    const repo = { font: "Inter", fontUrl: "https://fonts.googleapis.com/css2?family=Inter" };
    expect(mergeAppBrand(repo, APP, { font: "Inter" }).brand?.fontUrl).toBeUndefined();
    expect(mergeAppBrand(repo, { ...APP, font: "Inter" }, { font: "Inter" }).brand?.fontUrl).toBe(repo.fontUrl);
  });

  it("only treats config values equal to repo detection as replaceable", () => {
    expect(detectedReplaces({ primaryColor: "#4338ca", radius: "8px", name: "Mine" }, { primaryColor: "rgb(67, 56, 202)", radius: "10px", name: "Mine" })).toEqual({
      primary: "#4338ca",
      name: "Mine",
    });
  });
});

describe("the saved app brand reaches every output", () => {
  it("site theme files and artifact brands both merge brand/from-app.json under the config", () => {
    const dir = mkdtempSync(join(tmpdir(), "aida-app-brand-"));
    mkdirSync(join(dir, "brand"), { recursive: true });
    writeFileSync(join(dir, "brand", "from-app-logo-dark.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    writeAppBrand(dir, { version: 1, source: { baseUrl: "http://localhost:3000", pages: ["/"] }, brand: APP, replaces: {} });
    const config = { configDir: dir, brand: { name: "Acme", accentColor: "#f59e0b" } };

    expect(withAppBrand(config).brand).toMatchObject({ primaryColor: "#4f46e5", accentColor: "#f59e0b" });
    const artifact = resolveArtifactBrand(config);
    expect(artifact.colors.primary).toMatch(/#4f46e5|79,\s*70,\s*229|hsl/i);
    expect(artifact.logoDarkPath).toBe(join(dir, "brand", "from-app-logo-dark.png"));
    expect(artifact.style).toBe("friendly"); // 12px corners

    const helpApp = join(dir, "help");
    writeHelpAppTheme(config, helpApp);
    const css = readFileSync(join(helpApp, "app", "brand.css"), "utf8");
    expect(css).toMatch(/Manrope/);
    const json = JSON.parse(readFileSync(join(helpApp, "lib", "brand.json"), "utf8"));
    expect(json).toMatchObject({ name: "Acme", logoDark: "/brand/logo-dark.png", style: "friendly" });
  });
});
