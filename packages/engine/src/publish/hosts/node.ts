// Any Node server (docs/scope.md host table: "Everything — `next start`"). There's no CLI to
// deploy to "a server" in general; this adapter writes a short README with the systemd/pm2
// options and runs `next build` locally to prove it builds (never anything that reaches a
// network or needs credentials) — actually copying the build to a server is the person's own
// rsync/scp/CI step, named in NODE_DEPLOY.md but not run here.
import { applyPlannedFiles } from "./apply-files.js";
import type { ApplyResult, CommandRunner, DeployOptions, DeployResult, HostAdapter, PublishPlan } from "../types.js";

const NODE_DEPLOY_MD = `# Deploying to a plain Node server

This help app is an ordinary Next.js app — any server that runs Node works.

1. Build: \`npm run build\` (runs \`next build\`).
2. Copy the app (or just \`.next\`, \`public\`, \`package.json\`, \`node_modules\`) to the server,
   however you already deploy — rsync, scp, a CI artifact, a container image.
3. Start it: \`npm start\` (runs \`next start\`), on whatever port you point a reverse proxy at.

## Keeping it running

Pick whichever matches how you already run Node services.

### systemd

\`\`\`ini
[Unit]
Description=aida help app
After=network.target

[Service]
WorkingDirectory=/path/to/help
ExecStart=/usr/bin/npm start
Restart=on-failure
Environment=NODE_ENV=production
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
\`\`\`

### pm2

\`\`\`bash
pm2 start npm --name aida-help -- start
pm2 save
\`\`\`
`;

export function createNodeAdapter(): HostAdapter {
  return {
    name: "node",
    supportsChatAndMcp: true,
    plan(): PublishPlan {
      return {
        host: "node",
        useBlobStorage: false,
        files: [{ path: "NODE_DEPLOY.md", contents: NODE_DEPLOY_MD, reason: "how to run this app on a plain Node server (systemd/pm2 notes)" }],
        commands: [{ cmd: "npm", args: ["run", "build"], description: "next build" }],
        secrets: [],
        gitIntegration: false,
        warnings: [],
        notes: ["No deploy command — copy the built app to the server however you already deploy, then `npm start`."],
      };
    },
    apply(helpRoot: string, plan: PublishPlan): ApplyResult {
      return applyPlannedFiles(helpRoot, plan);
    },
    async deploy(helpRoot: string, plan: PublishPlan, opts: DeployOptions, runner: CommandRunner): Promise<DeployResult> {
      if (opts.dryRun) {
        return { ok: true, summary: "(dry run) would run: npm run build — then copy the app to the server and `npm start`", ran: [] };
      }
      const result = await runner("npm", ["run", "build"], { cwd: helpRoot });
      return {
        ok: result.code === 0,
        summary: result.code === 0
          ? "build succeeded — copy the app to the server and run `npm start` (see NODE_DEPLOY.md)"
          : `next build failed (exit ${result.code}): ${result.stderr || result.stdout}`,
        ran: [result],
      };
    },
  };
}
