import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "../../src/config/index.js";

const createdDirs: string[] = [];

export function tmpDir(prefix = "aida-publish-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

export function cleanupTmpDirs(): void {
  while (createdDirs.length > 0) {
    rmSync(createdDirs.pop()!, { recursive: true, force: true });
  }
}

const DEFAULT_NEXT_CONFIG = `import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
};

export default withMDX(config);
`;

/** A minimal help-app root: just enough for `findHelpRoot`/adapters to work against. */
export function makeHelpRoot(opts: { nextConfig?: string } = {}): string {
  const dir = tmpDir();
  writeFileSync(join(dir, "next.config.mjs"), opts.nextConfig ?? DEFAULT_NEXT_CONFIG);
  mkdirSync(join(dir, "content", "docs"), { recursive: true });
  mkdirSync(join(dir, "public"), { recursive: true });
  return dir;
}

export function makeResolvedConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  const configDir = overrides.configDir ?? tmpDir();
  return {
    app: { baseUrl: "http://localhost:3000" },
    walkthroughsDir: join(configDir, "walkthroughs"),
    outDir: configDir,
    buildDir: join(configDir, ".build"),
    configDir,
    ...overrides,
  } as ResolvedConfig;
}

export function writePage(
  helpRoot: string,
  id: string,
  opts: { passed?: boolean; video?: string; srt?: string } = {},
): string {
  const dir = join(helpRoot, "content", "docs", id);
  mkdirSync(dir, { recursive: true });
  const passed = opts.passed ?? true;
  const lines = ["---", `title: "${id}"`, `walkthrough: "${id}"`, `passed: ${passed}`];
  if (opts.video) lines.push(`video: "${opts.video}"`);
  if (opts.srt) lines.push(`srt: "${opts.srt}"`);
  lines.push("---", "", `# ${id}`, "");
  const file = join(dir, "index.mdx");
  writeFileSync(file, lines.join("\n"));
  return file;
}

export function writeBuildReport(buildDir: string, ok: boolean): string {
  mkdirSync(buildDir, { recursive: true });
  const file = join(buildDir, "report.json");
  writeFileSync(
    file,
    JSON.stringify({ ok, walkthroughs: ok ? [] : [{ walkthrough: "broken-one", ok: false }] }, null, 2),
  );
  return file;
}
