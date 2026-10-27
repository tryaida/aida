// GitHub Pages, S3, or any static host (docs/scope.md host table: "Site and search; no chat or
// MCP — Static export"). Needs Next.js `output: "export"` in `next.config.mjs`
// (https://nextjs.org/docs/app/guides/static-exports, current for Next 15/16 — fetched
// 2026-10-22: `next build` writes straight to `out/`, no separate export step). That file
// already exists in every scaffolded help app (it's the MDX config, not something `apply()`
// can just skip-if-exists like the other hosts' files), so this adapter merges `output: "export"`
// into it instead of overwriting it — and refuses to touch it if it already sets a different
// `output`, since that means a person customized it.
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApplyResult, CommandRunner, DeployOptions, DeployResult, HostAdapter, PublishPlan } from "../types.js";
import { createStaticExportStage } from "../static-export-stage.js";

const DEFAULT_NEXT_CONFIG = `import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
};

export default withMDX(config);
`;

interface MergeResult {
  content: string;
  changed: boolean;
  warning?: string;
}

/** Next's static export has no server to run the default `/_next/image` optimizer route on —
 * every `next/image` (the generated pages' screenshots, via getMDXComponents) 404s on the real
 * image and silently falls back to nothing without this (caught by actually loading an exported
 * page in a browser: every screenshot request came back 404). `images.unoptimized: true` serves
 * the original file unmodified, which is all a static export can do.
 * https://nextjs.org/docs/app/guides/static-exports#image-optimization — fetched 2026-10-22. */
function mergeUnoptimizedImages(existing: string): MergeResult {
  if (/\bimages\s*:/.test(existing)) {
    if (/\bimages\s*:\s*\{[^}]*\bunoptimized\s*:\s*true/.test(existing)) return { content: existing, changed: false };
    return {
      content: existing,
      changed: false,
      warning: "next.config.mjs already sets `images` — add `unoptimized: true` to it yourself, or screenshots 404 in the static export",
    };
  }
  const marker = "const config = {";
  if (!existing.includes(marker)) return { content: existing, changed: false };
  return { content: existing.replace(marker, `${marker}\n  images: { unoptimized: true },`), changed: true };
}

function mergeStaticExport(existing: string): MergeResult {
  if (/\boutput\s*:/.test(existing)) {
    if (!/\boutput\s*:\s*["']export["']/.test(existing)) {
      // A different `output` already set — this isn't (yet) a static export at all, so leave
      // everything else (including images) alone too; same behavior as before this merge grew
      // an `images` step.
      return {
        content: existing,
        changed: false,
        warning: "next.config.mjs already sets a different `output` — add `output: \"export\"` yourself to enable static export",
      };
    }
    // Already `output: "export"` — still need the images fix if it's missing.
    const images = mergeUnoptimizedImages(existing);
    return { content: images.content, changed: images.changed, warning: images.warning };
  }

  const marker = "const config = {";
  if (!existing.includes(marker)) {
    return {
      content: existing,
      changed: false,
      warning: 'could not find `const config = {` in next.config.mjs to merge `output: "export"` automatically — add it yourself',
    };
  }
  const withOutput = existing.replace(marker, `${marker}\n  output: "export",`);
  const images = mergeUnoptimizedImages(withOutput);
  return { content: images.content, changed: true, warning: images.warning };
}

function readNextConfig(helpRoot: string): string {
  const file = join(helpRoot, "next.config.mjs");
  return existsSync(file) ? readFileSync(file, "utf8") : DEFAULT_NEXT_CONFIG;
}

const CHAT_MCP_WARNING =
  "static export disables chat and the MCP server (both need server routes) — the site and search still work.";

export function createStaticAdapter(): HostAdapter {
  return {
    name: "static",
    supportsChatAndMcp: false,
    plan(helpRoot: string): PublishPlan {
      const merge = mergeStaticExport(readNextConfig(helpRoot));
      const files = merge.changed
        ? [{ path: "next.config.mjs", contents: merge.content, reason: 'merges `output: "export"` for static export' }]
        : [];
      const warnings = [CHAT_MCP_WARNING];
      if (merge.warning) warnings.push(merge.warning);
      return {
        host: "static",
        useBlobStorage: false,
        files,
        commands: [
          {
            cmd: "npm",
            args: ["run", "build"],
            description: "next build, writing the static site to out/",
            // Read by app/api/chat/route.ts and app/api/mcp/route.ts: without this, `next build
            // --output export` still compiles their POST/DELETE handlers in (Next's static
            // export doesn't reject non-GET route handlers at build time by itself), so a
            // request to them in the exported `out/` would hit code built to call provider
            // SDKs with no server to run on. The flag makes both routes answer a plain 501
            // instead, which is also what lets the chat UI detect "unavailable" and hide itself.
            // `NEXT_PUBLIC_*` is inlined into the client bundle at build time (Next.js can't
            // read plain `AIDA_STATIC_EXPORT` in browser code) — ChatWidget.tsx checks it to
            // hide the chat button entirely rather than show it and fail on click.
            env: { AIDA_STATIC_EXPORT: "1", NEXT_PUBLIC_AIDA_STATIC_EXPORT: "1" },
          },
        ],
        secrets: [],
        gitIntegration: true,
        warnings,
        notes: [
          "No CLI deploy — push `out/` to GitHub Pages (e.g. the `actions/deploy-pages` workflow) or sync it to an S3 bucket however you already do (`aws s3 sync out/ s3://<bucket>`).",
        ],
      };
    },
    apply(helpRoot: string, _plan: PublishPlan): ApplyResult {
      const file = join(helpRoot, "next.config.mjs");
      const current = readNextConfig(helpRoot);
      const merge = mergeStaticExport(current);
      if (!merge.changed) {
        return {
          files: [
            {
              path: "next.config.mjs",
              action: "skipped",
              reason: merge.warning ?? "already set up for static export",
            },
          ],
        };
      }
      writeFileSync(file, merge.content);
      return { files: [{ path: "next.config.mjs", action: "written", reason: 'merged output: "export"' }] };
    },
    async deploy(helpRoot: string, plan: PublishPlan, opts: DeployOptions, runner: CommandRunner): Promise<DeployResult> {
      if (opts.dryRun) {
        return {
          ok: true,
          summary:
            "(dry run) would stage a copy of the help app with app/api and app/studio removed, " +
            "run: npm run build there, then copy out/ back and report its size",
          ran: [],
        };
      }
      // Carry the env from the plan's build command (AIDA_STATIC_EXPORT=1) through to the
      // actual run — plan() only *describing* it isn't enough, deploy() must set it too, or a
      // real static export still compiles the chat/MCP routes as if they could run on a server.
      const buildCommand = plan.commands.find((c) => c.cmd === "npm" && c.args.join(" ") === "run build");

      // Build from a staged copy with app/api and app/studio removed (see
      // static-export-stage.ts's doc comment for why: Next's static export can't serve either
      // tree, and fails the whole build the moment it finds one) — never the user's own
      // `helpRoot`, so a crash mid-build never leaves their repo missing files.
      const stage = createStaticExportStage(helpRoot);
      const result = await runner("npm", ["run", "build"], { cwd: stage, env: buildCommand?.env });
      if (result.code !== 0) {
        return { ok: false, summary: `next build failed (exit ${result.code}): ${result.stderr || result.stdout}`, ran: [result] };
      }
      const stagedOut = join(stage, "out");
      const outDir = join(helpRoot, "out");
      if (existsSync(stagedOut)) {
        rmSync(outDir, { recursive: true, force: true });
        cpSync(stagedOut, outDir, { recursive: true });
      }
      const { files, bytes } = dirStats(outDir);
      return {
        ok: true,
        summary: existsSync(outDir)
          ? `static export built: ${files} file(s), ${(bytes / 1024 / 1024).toFixed(2)} MiB in ${outDir} — not uploaded anywhere`
          : `next build succeeded, but no out/ directory was produced at ${stagedOut} — check output: "export" is set`,
        ran: [result],
      };
    },
  };
}

function dirStats(dir: string): { files: number; bytes: number } {
  if (!existsSync(dir)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        files += 1;
        bytes += statSync(full).size;
      }
    }
  };
  walk(dir);
  return { files, bytes };
}
