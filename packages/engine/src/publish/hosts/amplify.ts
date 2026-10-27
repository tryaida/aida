// AWS Amplify (docs/scope.md host table: "Everything" — "Amplify Hosting's Next.js support, app
// root `help/`"). Amplify Hosting deploys SSR Next.js apps through its Git integration (connect
// the repo in the console, point "App root" at `help/`); there's no documented Amplify Hosting
// CLI subcommand that deploys an existing SSR Next.js build the way `vercel deploy`/`netlify
// deploy` do, so this adapter only writes `amplify.yml` and explains the Git-integration route
// (https://docs.aws.amazon.com/amplify/latest/userguide/build-settings.html, fetched 2026-10-22).
import { applyPlannedFiles } from "./apply-files.js";
import type { ApplyResult, CommandRunner, DeployOptions, DeployResult, HostAdapter, PublishPlan } from "../types.js";

const AMPLIFY_YML = `version: 1
frontend:
  phases:
    preBuild:
      commands:
        - npm ci
    build:
      commands:
        - npm run build
  artifacts:
    baseDirectory: .next
    files:
      - '**/*'
  cache:
    paths:
      - node_modules/**/*
      - .next/cache/**/*
`;

export function createAmplifyAdapter(): HostAdapter {
  return {
    name: "amplify",
    supportsChatAndMcp: true,
    plan(): PublishPlan {
      return {
        host: "amplify",
        useBlobStorage: false,
        files: [{ path: "amplify.yml", contents: AMPLIFY_YML, reason: "build spec Amplify Hosting reads when the repo includes one, instead of autodetecting" }],
        commands: [],
        secrets: [],
        gitIntegration: true,
        warnings: [],
        notes: [
          "Amplify Hosting deploys on push once the repo is connected in the console, with \"App root\" set to `help/` — there's no CLI command that redeploys an existing SSR app the way `vercel deploy` does.",
          "Secrets/env vars are set in the Amplify console under the app's Environment variables.",
        ],
      };
    },
    apply(helpRoot: string, plan: PublishPlan): ApplyResult {
      return applyPlannedFiles(helpRoot, plan);
    },
    async deploy(_helpRoot: string, plan: PublishPlan, opts: DeployOptions, _runner: CommandRunner): Promise<DeployResult> {
      return {
        ok: true,
        summary: opts.dryRun
          ? "(dry run) Amplify Hosting deploys via Git integration — connect the repo in the console with App root `help/`; nothing to run here."
          : "Amplify Hosting deploys automatically on push once the repo is connected via Git integration in the console (App root `help/`) — aida writes amplify.yml but doesn't trigger a deploy itself.",
        ran: [],
      };
    },
  };
}
