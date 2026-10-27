// Cloudflare, via the OpenNext Cloudflare adapter (docs/scope.md host table: "Everything — the
// OpenNext Cloudflare adapter"). Per https://opennext.js.org/cloudflare (fetched 2026-10-22):
// `open-next.config.ts` configures the adapter, `wrangler.jsonc` configures the Worker, the
// build runs via `npx @opennextjs/cloudflare build`, and deploy via `wrangler deploy` (which
// supports `--dry-run`, so this adapter can validate a build without publishing). Cloudflare's
// Workers static-assets limit is 25 MiB per file (`staticAssetLimitBytes` below) — exceeding it
// is one of the two triggers for routing videos through blob storage (see video-size.ts).
import { applyPlannedFiles } from "./apply-files.js";
import type { ApplyResult, CommandRunner, DeployOptions, DeployResult, HostAdapter, PublishPlan } from "../types.js";

const OPEN_NEXT_CONFIG = `import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig();
`;

const WRANGLER_JSONC = `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "aida-help",
  "main": ".open-next/worker.js",
  "compatibility_date": "2026-01-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": ".open-next/assets",
    "binding": "ASSETS"
  }
}
`;

const STATIC_ASSET_LIMIT_BYTES = 25 * 1024 * 1024; // 25 MiB/file

export function createCloudflareAdapter(): HostAdapter {
  return {
    name: "cloudflare",
    supportsChatAndMcp: true,
    staticAssetLimitBytes: STATIC_ASSET_LIMIT_BYTES,
    plan(): PublishPlan {
      return {
        host: "cloudflare",
        useBlobStorage: false,
        files: [
          { path: "open-next.config.ts", contents: OPEN_NEXT_CONFIG, reason: "configures the OpenNext Cloudflare adapter" },
          { path: "wrangler.jsonc", contents: WRANGLER_JSONC, reason: "Worker name, entry point and static-assets binding" },
        ],
        commands: [
          { cmd: "npx", args: ["@opennextjs/cloudflare", "build"], description: "build the Worker bundle" },
          { cmd: "npx", args: ["wrangler", "deploy", "--dry-run"], description: "validate the deploy without publishing" },
          { cmd: "npx", args: ["wrangler", "deploy"], description: "publish to Cloudflare Workers" },
        ],
        secrets: [{ name: "CLOUDFLARE_API_TOKEN", why: "non-interactive auth for `wrangler deploy` in CI/an agent" }],
        gitIntegration: false,
        warnings: [],
        notes: [],
      };
    },
    apply(helpRoot: string, plan: PublishPlan): ApplyResult {
      return applyPlannedFiles(helpRoot, plan);
    },
    async deploy(helpRoot: string, plan: PublishPlan, opts: DeployOptions, runner: CommandRunner): Promise<DeployResult> {
      const build = await runner("npx", ["@opennextjs/cloudflare", "build"], { cwd: helpRoot });
      if (build.code !== 0) {
        return { ok: false, summary: `opennextjs-cloudflare build failed (exit ${build.code}): ${build.stderr || build.stdout}`, ran: [build] };
      }
      // --prod publishes live; otherwise `wrangler versions upload` makes a preview version
      // with its own URL that never receives production traffic. `opts.dryRun` additionally
      // forces wrangler's own `--dry-run`, which validates without uploading anything at all.
      const deployArgs = opts.prod ? ["wrangler", "deploy"] : ["wrangler", "versions", "upload"];
      if (opts.dryRun) deployArgs.push("--dry-run");
      const deploy = await runner("npx", deployArgs, { cwd: helpRoot });
      return {
        ok: deploy.code === 0,
        summary: deploy.code === 0
          ? opts.dryRun
            ? "wrangler --dry-run validated the build (nothing uploaded)"
            : opts.prod
              ? "published to Cloudflare Workers"
              : "uploaded a preview version (no production traffic)"
          : `wrangler failed (exit ${deploy.code}): ${deploy.stderr || deploy.stdout}`,
        ran: [build, deploy],
      };
    },
  };
}
