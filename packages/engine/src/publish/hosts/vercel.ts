// Vercel (docs/scope.md host table: "Everything" — "Import the `help/` folder as a project").
// CLI flags per https://vercel.com/docs/cli/deploy (fetched 2026-10-22): `vercel deploy` prints
// the deployment URL on stdout; `--prod` makes it a production deployment (otherwise preview);
// `--yes` skips the interactive project-setup prompts so this runs unattended in CI/an agent;
// `--cwd` points it at the help app without the caller having to `cd`.
import { applyPlannedFiles } from "./apply-files.js";
import type { ApplyResult, CommandRunner, DeployOptions, DeployResult, HostAdapter, PublishPlan } from "../types.js";

const VERCEL_JSON = `{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "nextjs"
}
`;

export function createVercelAdapter(): HostAdapter {
  return {
    name: "vercel",
    supportsChatAndMcp: true,
    plan(): PublishPlan {
      return {
        host: "vercel",
        useBlobStorage: false,
        files: [{ path: "vercel.json", contents: VERCEL_JSON, reason: "declares the Next.js framework so Vercel skips build-command detection" }],
        commands: [
          { cmd: "npx", args: ["vercel", "deploy", "--yes", "--cwd", "."], description: "preview deploy" },
          { cmd: "npx", args: ["vercel", "deploy", "--yes", "--prod", "--cwd", "."], description: "production deploy (--prod)" },
        ],
        secrets: [{ name: "VERCEL_TOKEN", why: "non-interactive auth for `vercel deploy` in CI/an agent (--token, or VERCEL_TOKEN env)" }],
        gitIntegration: false,
        warnings: [],
        notes: ["Git integration (importing the `help/` folder as a Vercel project in the dashboard) works too, and is the simpler route for most people."],
      };
    },
    apply(helpRoot: string, plan: PublishPlan): ApplyResult {
      return applyPlannedFiles(helpRoot, plan);
    },
    async deploy(helpRoot: string, plan: PublishPlan, opts: DeployOptions, runner: CommandRunner): Promise<DeployResult> {
      const args = ["vercel", "deploy", "--yes", "--cwd", helpRoot];
      if (opts.prod) args.push("--prod");
      if (opts.dryRun) {
        return { ok: true, summary: `(dry run) would run: npx ${args.join(" ")}`, ran: [] };
      }
      const result = await runner("npx", args, { cwd: helpRoot });
      const url = result.stdout.trim().split("\n").pop();
      return {
        ok: result.code === 0,
        url: result.code === 0 ? url : undefined,
        summary: result.code === 0 ? `deployed to ${url}` : `vercel deploy failed (exit ${result.code}): ${result.stderr || result.stdout}`,
        ran: [result],
      };
    },
  };
}
