// Writes `aida.config.ts` into a freshly-copied help app, filling in the
// detected app URL, brand and (as comments) the routes `detectFramework`
// found. Never overwrites an existing config — a second `aida init` leaves
// a config the user has started editing alone and reports it skipped, same as
// every other template file (see copy-template.ts).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { BrandConfig } from "../config/types.js";
import type { DetectResult } from "./detect.js";

export interface WriteConfigOptions {
  destDir: string;
  appUrl: string;
  brand: BrandConfig;
  detected: DetectResult;
  /** Set when `aida init --ci --claude`/`--docs-repo` wrote the matching workflow(s) — mirrors
   * that into `config.ci` so `aida ci`'s own comment text and exit-code defaults line up with
   * what the workflow actually does (build-plan.md M19). */
  ci?: { claudeAction?: boolean; docsRepo?: string };
  /** Module path for `signIn`, relative to the config — set when `aida init` wrote a starter
   * sign-in adapter (sign-in-template.ts). */
  signIn?: string;
  /** The app's own directory, written as `app.dir` relative to the config so capture's database
   * safety check reads the right env files. */
  appDir?: string;
}

export interface WriteConfigResult {
  file: string;
  written: boolean;
}

/** Key order for a written `brand` block (and its `colors`/`dark` objects) — fixed, so the
 * generated config is stable. */
const BRAND_KEY_ORDER = [
  "name", "primaryColor", "accentColor", "colors", "dark", "logo", "logoDark", "icon", "font", "fontUrl", "headingFont", "radius",
];
const COLOR_KEY_ORDER = ["primary", "primaryForeground", "accent", "background", "foreground", "card", "muted", "mutedForeground", "border"];

function ordered(obj: Record<string, unknown>, order: string[]): Array<[string, unknown]> {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined && v !== null);
  const rank = (k: string) => (order.includes(k) ? order.indexOf(k) : order.length);
  return entries.sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}

/** A `brand: { ... }` object literal for aida.config.ts (two-space indent, nested colour
 * objects), or "" when there's nothing to write. Exported for `aida theme --detect`. */
export function formatBrandBlock(brand: BrandConfig, indent = "  "): string {
  const fields = ordered(brand as Record<string, unknown>, BRAND_KEY_ORDER);
  if (fields.length === 0) return "";
  const inner = `${indent}  `;
  const lines: string[] = [];
  for (const [k, v] of fields) {
    if (v && typeof v === "object") {
      const sub = ordered(v as Record<string, unknown>, COLOR_KEY_ORDER);
      if (sub.length === 0) continue;
      lines.push(`${inner}${k}: {`);
      for (const [sk, sv] of sub) lines.push(`${inner}  ${sk}: ${JSON.stringify(sv)},`);
      lines.push(`${inner}},`);
    } else {
      lines.push(`${inner}${k}: ${JSON.stringify(v)},`);
    }
  }
  return `${indent}brand: {\n${lines.join("\n")}\n${indent}},\n`;
}

function brandBlock(brand: BrandConfig): string {
  const block = formatBrandBlock(brand);
  if (!block) return "";
  return `  // Detected from the app by \`aida init\`; \`aida theme\` turns it into the help app's
  // app/brand.css, lib/brand.json and public/brand/. Paths are relative to this file.
${block}`;
}

function ciBlock(ci: WriteConfigOptions["ci"]): string {
  if (!ci || (!ci.claudeAction && !ci.docsRepo)) return "";
  const lines: string[] = [];
  if (ci.claudeAction) lines.push("    claudeAction: true,");
  if (ci.docsRepo) lines.push(`    docsRepo: ${JSON.stringify(ci.docsRepo)},`);
  return `  ci: {\n${lines.join("\n")}\n  },\n`;
}

function signInBlock(signIn: string | undefined): string {
  if (!signIn) return "";
  return `  // Starter Auth.js adapter written by \`aida init\`: it mints the app's own session cookie
  // for each walkthrough's persona. Read the notes at the top of the file before relying on it.
  signIn: ${JSON.stringify(signIn)},
`;
}

function routesComment(detected: DetectResult): string {
  if (detected.framework !== "nextjs") {
    return "// Framework: not detected as Next.js — fill in app.baseUrl by hand below.\n";
  }
  const lines = [`// Detected: Next.js App Router (${detected.appDir ?? "app/"})`];
  if (detected.routes.length > 0) lines.push(`// Routes seen: ${detected.routes.join(", ")}`);
  if (detected.authLibrary) lines.push(`// Sign-in: looks like ${detected.authLibrary} — see docs/scope.md "Capture modes".`);
  return lines.map((l) => `${l}\n`).join("");
}

/** Writes `<destDir>/aida.config.ts`. No-ops (and reports `written: false`) when the file already exists. */
export function writeAidaConfig(opts: WriteConfigOptions): WriteConfigResult {
  const file = join(opts.destDir, "aida.config.ts");
  if (existsSync(file)) {
    return { file, written: false };
  }

  const appDir = opts.appDir ? relative(opts.destDir, opts.appDir).split(sep).join("/") || "." : undefined;
  const content = `// Written by \`aida init\`; safe to edit by hand afterwards. See
// packages/engine/src/config/types.ts for every field, and docs/scope.md
// ("The help app", "Swappable providers") for what each one does.
${routesComment(opts.detected)}import { defineConfig } from "aida";

export default defineConfig({
  app: {
    // Capture against a production build of the app (\`next build && next start\`), not
    // \`next dev\`: the dev server's cache grows to gigabytes over a capture run, and production
    // pages are what readers see.
    baseUrl: ${JSON.stringify(opts.appUrl)},
${appDir ? `    // The app's own folder: capture reads its database setting from here and refuses a live one.
    dir: ${JSON.stringify(appDir)},
` : ""}  },
  walkthroughsDir: "./walkthroughs",
  // This config lives inside the help app itself, so generated output goes
  // right here rather than into a nested \`help/\` folder.
  outDir: ".",
  buildDir: "./.build",
  // This help app is its own target: the index stage mirrors built pages into
  // its own content/docs + public/ so the help site actually shows them.
  helpApp: ".",
${signInBlock(opts.signIn)}${brandBlock(opts.brand)}${ciBlock(opts.ci)}});
`;

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
  return { file, written: true };
}
