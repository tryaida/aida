import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractBrand, parseCssBlocks, rebaseBrandPaths, stripTagline } from "../../src/init/brand.js";

const createdDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-brand-test-"));
  createdDirs.push(dir);
  return dir;
}

function write(dir: string, rel: string, content: string | Buffer = ""): void {
  const file = join(dir, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

afterEach(() => {
  while (createdDirs.length > 0) {
    rmSync(createdDirs.pop()!, { recursive: true, force: true });
  }
});

// A cut-down copy of a real app's globals.css: Google Fonts @import, shadcn vars nested in
// `@layer base`, `var()` indirection through brand vars, a pale shadcn --accent, a .dark block.
const SHADCN_V3_CSS = `@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
@tailwind base;
body { font-family: 'Inter', sans-serif; }
@container metrics (min-width: 560px) { .grid { grid-template-columns: repeat(2, 1fr); } }
@layer base {
  :root {
    /* brand */
    --acme-primary: 183 68% 30%;   /* teal */
    --acme-accent: 259 58% 55%;
    --acme-background: 222 26% 97%;
    --acme-text: 224 42% 14%;
    --background: var(--acme-background);
    --foreground: var(--acme-text);
    --card: 0 0% 100%;
    --primary: 235 55% 42%;
    --primary-foreground: 0 0% 100%;
    --muted: 220 24% 93%;
    --muted-foreground: 222 16% 40%;
    --accent: 232 40% 94%;
    --border: 220 20% 89%;
    --sidebar-primary: 183 55% 44%;
    --shadow-card: 0 1px 2px hsl(var(--shadow-color) / 0.06);
    --radius: 10px;
  }
  .dark {
    --background: 224 44% 7%;
    --foreground: 213 34% 96%;
    --primary: 236 72% 71%;
    --primary-foreground: 234 52% 12%;
    --acme-primary: 181 58% 48%;
  }
}
`;

const TAILWIND_V4_CSS = `@import "tailwindcss";
@custom-variant dark (&:is(.dark *));
:root {
  --radius: 0.75rem;
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --primary: oklch(0.55 0.2 260);
  --primary-foreground: oklch(0.985 0 0);
  --accent: oklch(0.97 0 0);
  --border: oklch(0.922 0 0);
  --brand-accent: oklch(0.7 0.15 160);
}
.dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --primary: oklch(0.75 0.15 260);
}
@theme inline {
  --color-background: var(--background);
  --color-primary: var(--primary);
  --color-card: #ffffff;
  --font-sans: var(--font-geist-sans);
}
`;

describe("extractBrand", () => {
  it("reads colours, dark overrides, a distinct accent, radius and font from a shadcn globals.css with nested @layer base", () => {
    const dir = tmpDir();
    write(dir, "app/globals.css", SHADCN_V3_CSS);

    const brand = extractBrand(dir);
    expect(brand.primaryColor).toBe("235 55% 42%");
    // --acme-primary (teal) — not shadcn's pale --accent fill, not --sidebar-primary.
    expect(brand.accentColor).toBe("183 68% 30%");
    expect(brand.colors).toEqual({
      primaryForeground: "0 0% 100%",
      background: "222 26% 97%",
      foreground: "224 42% 14%",
      card: "0 0% 100%",
      muted: "220 24% 93%",
      mutedForeground: "222 16% 40%",
      border: "220 20% 89%",
    });
    expect(brand.dark).toEqual({
      primary: "236 72% 71%",
      primaryForeground: "234 52% 12%",
      accent: "181 58% 48%",
      background: "224 44% 7%",
      foreground: "213 34% 96%",
    });
    expect(brand.radius).toBe("10px");
    expect(brand.font).toBe("Inter");
    expect(brand.fontUrl).toBe("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap");
  });

  it("reads a Tailwind v4 app: oklch vars, @theme inline, next/font/google, --brand-accent", () => {
    const dir = tmpDir();
    write(dir, "src/app/globals.css", TAILWIND_V4_CSS);
    write(
      dir,
      "src/app/layout.tsx",
      `import type { Metadata } from "next";\nimport { Geist, Geist_Mono } from "next/font/google";\nexport const metadata: Metadata = {\n  title: { default: "Orbit | Plan your week", template: "%s | Orbit" },\n};\n`,
    );
    write(dir, "package.json", JSON.stringify({ name: "orbit-web" }));

    const brand = extractBrand(dir);
    expect(brand.name).toBe("Orbit");
    expect(brand.primaryColor).toBe("oklch(0.55 0.2 260)");
    expect(brand.accentColor).toBe("oklch(0.7 0.15 160)");
    expect(brand.colors?.background).toBe("oklch(1 0 0)");
    expect(brand.colors?.card).toBe("#ffffff");
    expect(brand.dark?.primary).toBe("oklch(0.75 0.15 260)");
    expect(brand.dark?.background).toBe("oklch(0.145 0 0)");
    expect(brand.radius).toBe("0.75rem");
    expect(brand.font).toBe("Geist");
    expect(brand.fontUrl).toBe("https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap");
  });

  it("builds a Google Fonts URL from a --font-sans family name", () => {
    const dir = tmpDir();
    write(dir, "app/globals.css", `:root {\n  --primary: 235 55% 42%;\n  --font-sans: "Manrope", sans-serif;\n}\n`);

    const brand = extractBrand(dir);
    expect(brand.primaryColor).toBe("235 55% 42%");
    expect(brand.font).toBe("Manrope");
    expect(brand.fontUrl).toContain("family=Manrope:wght@400;500;600;700");
  });

  it("does not invent a font URL for a non-Google family, and ignores a plain system stack", () => {
    const dir = tmpDir();
    write(dir, "app/globals.css", `body { font-family: "Acme Sans", sans-serif; }\n`);
    expect(extractBrand(dir)).toEqual({ font: "Acme Sans" });

    const dir2 = tmpDir();
    write(dir2, "app/globals.css", `body { font-family: system-ui, -apple-system, Roboto, sans-serif; }\n`);
    expect(extractBrand(dir2).font).toBeUndefined();
  });

  it("reads a Tailwind config's fontFamily, including a custom key", () => {
    const dir = tmpDir();
    write(dir, "tailwind.config.ts", `export default { theme: { extend: { fontFamily: { 'inter': ['Inter', 'sans-serif'], mono: ['JetBrains Mono'] } } } };`);
    const brand = extractBrand(dir);
    expect(brand.font).toBe("Inter");
    expect(brand.fontUrl).toContain("family=Inter");
  });

  it("falls back to a Tailwind config's literal primary colour", () => {
    const dir = tmpDir();
    write(dir, "tailwind.config.ts", `export default { theme: { extend: { colors: { primary: { DEFAULT: "#4338ca" } } } } };`);
    expect(extractBrand(dir).primaryColor).toBe("#4338ca");
  });

  it("ignores a Tailwind primary colour that just points back at a CSS var", () => {
    const dir = tmpDir();
    write(dir, "tailwind.config.ts", `export default { theme: { extend: { colors: { primary: { DEFAULT: "hsl(var(--primary))" } } } } };`);
    expect(extractBrand(dir).primaryColor).toBeUndefined();
  });

  it("ignores a pale or grey shadcn --accent and an accent equal to the primary", () => {
    const dir = tmpDir();
    write(dir, "app/globals.css", `:root { --primary: #2563eb; --accent: 210 40% 96%; --secondary: 0 0% 45%; --brand-primary: #2563eb; }`);
    const brand = extractBrand(dir);
    expect(brand.primaryColor).toBe("#2563eb");
    expect(brand.accentColor).toBeUndefined();
  });

  it("reads dark colours from @media (prefers-color-scheme: dark)", () => {
    const dir = tmpDir();
    write(dir, "app/globals.css", `:root { --background: #fff; --primary: #2563eb; }\n@media (prefers-color-scheme: dark) { :root { --background: #0a0a0a; } }\n@media (min-width: 600px) { :root { --primary: red; } }`);
    const brand = extractBrand(dir);
    expect(brand.primaryColor).toBe("#2563eb");
    expect(brand.dark).toEqual({ background: "#0a0a0a" });
  });

  it("picks the main logo, a white logo for dark backgrounds, and an icon — skipping placeholders", () => {
    const dir = tmpDir();
    for (const f of [
      "AcmeEvents-Logo-Flat-Black.png",
      "AcmeEvents-Logo-Flat-Colored-Bars.png",
      "AcmeEvents-Logo-Flat-White.png",
      "AcmeEvents-Logo-Main.png",
      "placeholder-logo.svg",
      "favicon.ico",
      "favicon-32x32.png",
      "android-chrome-192x192.png",
    ]) {
      write(dir, `public/${f}`, "x");
    }
    write(dir, "public/apple-touch-icon.png", "x");

    const brand = extractBrand(dir);
    expect(brand.logo).toBe(join("public", "AcmeEvents-Logo-Main.png"));
    expect(brand.logoDark).toBe(join("public", "AcmeEvents-Logo-Flat-White.png"));
    expect(brand.icon).toBe(join("public", "apple-touch-icon.png"));
  });

  it("prefers an .svg logo and an app/icon.svg; falls back to a placeholder logo only when nothing else exists", () => {
    const dir = tmpDir();
    write(dir, "public/acme-logo.png", "x");
    write(dir, "public/images/acme-logo.svg", "x");
    write(dir, "app/icon.svg", "<svg/>");
    write(dir, "public/favicon.ico", "x");
    const brand = extractBrand(dir);
    expect(brand.logo).toBe(join("public", "images", "acme-logo.svg"));
    expect(brand.icon).toBe(join("app", "icon.svg"));

    const dir2 = tmpDir();
    write(dir2, "public/placeholder-logo.png", "x");
    expect(extractBrand(dir2).logo).toBe(join("public", "placeholder-logo.png"));
  });

  it("names the product from metadata.title, then the manifest, then package.json", () => {
    const a = tmpDir();
    write(a, "app/layout.tsx", `export const metadata: Metadata = {\n  title: 'Acme Events - Show Management Platform',\n  appleWebApp: { title: 'Other' },\n}\n`);
    expect(extractBrand(a).name).toBe("Acme Events");

    const b = tmpDir();
    write(b, "public/site.webmanifest", JSON.stringify({ name: "Acme Portal — Admin", short_name: "Acme" }));
    expect(extractBrand(b).name).toBe("Acme");

    const c = tmpDir();
    write(c, "package.json", JSON.stringify({ name: "@acme/field-notes" }));
    expect(extractBrand(c).name).toBe("Field Notes");

    const d = tmpDir();
    write(d, "package.json", JSON.stringify({ name: "my-v0-project" }));
    expect(extractBrand(d).name).toBeUndefined();
  });

  it("returns an empty object for a repo with none of these patterns", () => {
    const dir = tmpDir();
    expect(extractBrand(dir)).toEqual({});
  });
});

describe("parseCssBlocks", () => {
  it("handles nested blocks, comments, strings and url() with semicolons", () => {
    const blocks = parseCssBlocks(`@import url('a;b{c}');\n/* :root { --x: 1; } */\n@layer base { :root { --a: 1; .n { --b: 2; } --c: "x;y"; } }`);
    const root = blocks.find((b) => b.selector === ":root")!;
    expect(root.ancestors).toEqual(["@layer base"]);
    expect(root.decls).toEqual([
      ["--a", "1"],
      ["--c", `"x;y"`],
    ]);
    expect(blocks.find((b) => b.selector === ".n")!.decls).toEqual([["--b", "2"]]);
  });
});

describe("stripTagline / rebaseBrandPaths", () => {
  it("strips a ' - tagline' / ' | tagline'", () => {
    expect(stripTagline("Acme Events - Show Management Platform")).toBe("Acme Events");
    expect(stripTagline("Orbit | Plan your week")).toBe("Orbit");
    expect(stripTagline("Self-Serve")).toBe("Self-Serve");
  });

  it("re-expresses asset paths relative to the config dir", () => {
    const out = rebaseBrandPaths({ logo: join("public", "logo.svg"), icon: "/abs/icon.png", font: "Inter" }, "/repo", "/repo/help");
    expect(out).toEqual({ logo: "../public/logo.svg", icon: "/abs/icon.png", font: "Inter" });
  });
});
