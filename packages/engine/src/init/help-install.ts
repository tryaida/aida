// Installs the help app's own packages in CI (the `aida init --ci` workflow and action.yml run
// `node <aida>/packages/engine/dist/init/help-install.js <config>` after installing aida), so
// adapters and state hooks that import the help app's dependencies find them. aida itself never
// comes from here: loadConfig pins `aida` to the running engine (config/pin-aida.ts).
//
// Installing still runs install scripts, so it refuses when the help app would pull `aida` from
// the npm registry, where the name belongs to an unrelated package (decisions #29): an `aida`
// dependency that isn't a local tarball or path, or a lockfile entry for aida resolved from a
// registry. Re-run `aida init` to point the help app at a packed engine tarball.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultCommandRunner, isRegistrySpec, type CommandRunner } from "./install.js";

export type HelpInstallPlan =
  | { action: "skip"; reason: string }
  | { action: "refuse"; reason: string }
  | { action: "install"; command: "npm"; args: string[] };

const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

/** What to run in `helpDir`: `npm ci` with a lockfile, `npm install` without, nothing when there's
 * no package.json, and a refusal when aida would come from a registry. */
export function planHelpAppInstall(helpDir: string): HelpInstallPlan {
  const pkgFile = join(helpDir, "package.json");
  if (!existsSync(pkgFile)) return { action: "skip", reason: `${helpDir} has no package.json` };
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as Record<string, Record<string, string> | undefined>;
  for (const field of DEP_FIELDS) {
    const spec = pkg[field]?.aida;
    if (typeof spec === "string" && isRegistrySpec(spec)) {
      return {
        action: "refuse",
        reason: `${pkgFile} has "aida": "${spec}" in ${field}, which npm would fetch from the registry (an unrelated package). Re-run \`aida init\` to use a packed engine tarball.`,
      };
    }
  }
  const lockFile = join(helpDir, "package-lock.json");
  if (!existsSync(lockFile)) return { action: "install", command: "npm", args: ["install", "--no-audit", "--no-fund"] };
  const lock = JSON.parse(readFileSync(lockFile, "utf8")) as { packages?: Record<string, { resolved?: string; link?: boolean }> };
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!/(^|\/)node_modules\/aida$/.test(path) || entry.link) continue;
    const resolved = entry.resolved ?? "";
    if (!resolved.startsWith("file:")) {
      return {
        action: "refuse",
        reason: `${lockFile} resolves ${path} from ${resolved || "the registry"}, not a local tarball. Re-run \`aida init\` to use a packed engine tarball.`,
      };
    }
  }
  return { action: "install", command: "npm", args: ["ci", "--no-audit", "--no-fund"] };
}

/** Runs the plan for the help app that holds `configPath`. Throws on a refusal or a failed install. */
export function installHelpAppForCi(configPath: string, runner: CommandRunner = defaultCommandRunner): HelpInstallPlan {
  const helpDir = dirname(resolve(configPath));
  const plan = planHelpAppInstall(helpDir);
  if (plan.action === "refuse") throw new Error(plan.reason);
  if (plan.action === "install") {
    const r = runner(plan.command, plan.args, { cwd: helpDir, output: "stream" });
    if (r.status !== 0) throw new Error(`npm ${plan.args[0]} in ${helpDir} failed (exit ${r.status})`);
  }
  return plan;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error("usage: node help-install.js <path to aida.config.ts>");
    process.exit(2);
  }
  try {
    const plan = installHelpAppForCi(configPath);
    if (plan.action === "skip") console.error(`aida: ${plan.reason}; no help app packages to install`);
  } catch (err) {
    console.error(`aida: ${(err as Error).message}`);
    process.exit(1);
  }
}
