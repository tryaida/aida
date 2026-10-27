// Netlify (docs/scope.md host table: "Everything" — "Netlify's Next.js support"). CLI flags per
// https://docs.netlify.com/cli/get-started/ and https://cli.netlify.com/commands/deploy/ (fetched
// 2026-10-22): `netlify deploy --build` runs the configured build first; `--prod` publishes to
// the site's main URL (omit for a draft/preview URL); auth comes from `NETLIFY_AUTH_TOKEN` in CI.
import { applyPlannedFiles } from "./apply-files.js";
import type { ApplyResult, CommandRunner, DeployOptions, DeployResult, HostAdapter, PublishPlan } from "../types.js";

const NETLIFY_TOML = `[build]
  command = "npm run build"
  publish = ".next"
`;

export function createNetlifyAdapter(): HostAdapter {
  return {
    name: "netlify",
    supportsChatAndMcp: true,
    plan(): PublishPlan {
      return {
        host: "netlify",
        useBlobStorage: false,
        files: [{ path: "netlify.toml", contents: NETLIFY_TOML, reason: "build command + publish dir — Netlify's Next.js runtime handles routes/functions from here automatically" }],
        commands: [
          { cmd: "npx", args: ["netlify-cli", "deploy", "--build"], description: "preview deploy" },
          { cmd: "npx", args: ["netlify-cli", "deploy", "--build", "--prod"], description: "production deploy (--prod)" },
        ],
        secrets: [
          { name: "NETLIFY_AUTH_TOKEN", why: "non-interactive auth for `netlify deploy` in CI/an agent" },
          { name: "NETLIFY_SITE_ID", why: "which Netlify site to deploy to, when not already linked" },
        ],
        gitIntegration: false,
        warnings: [],
        notes: ["Git integration (connecting the repo in the Netlify dashboard, with base directory `help/`) is the simpler route for most people."],
      };
    },
    apply(helpRoot: string, plan: PublishPlan): ApplyResult {
      return applyPlannedFiles(helpRoot, plan);
    },
    async deploy(helpRoot: string, plan: PublishPlan, opts: DeployOptions, runner: CommandRunner): Promise<DeployResult> {
      const args = ["netlify-cli", "deploy", "--build"];
      if (opts.prod) args.push("--prod");
      if (opts.dryRun) {
        return { ok: true, summary: `(dry run) would run: npx ${args.join(" ")}`, ran: [] };
      }
      const result = await runner("npx", args, { cwd: helpRoot });
      return {
        ok: result.code === 0,
        summary: result.code === 0 ? "netlify deploy succeeded" : `netlify deploy failed (exit ${result.code}): ${result.stderr || result.stdout}`,
        ran: [result],
      };
    },
  };
}
