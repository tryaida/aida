// `aida init [dir] [--app-repo <path>] [--json]` — scope.md "First run:
// engineer" step 1. Copies the help-app template into `<dir>/help`, detects
// the target app's framework/routes (comments only) and brand, and writes
// `aida.config.ts`, then writes the help app's theme files (app/brand.css, lib/brand.json,
// public/brand/) from that brand. Never overwrites a file that's already there — except the
// generated theme files, and only when the config was freshly written.
//
// M25 (decisions #29): packs this engine into `help/vendor/aida-docs-<version>-<hash>.tgz` and
// points the help app's `aida-docs` dependency at it (re-runs refresh both), then runs `npm install` there
// unless `--no-install`. `--tunnel-host` adds hosts and a Studio access key to help/.env.local
// and prints the private access link, and an Auth.js app gets a starter sign-in adapter
// (help/adapters/sign-in.mjs).
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { detectFramework } from "../init/detect.js";
import { extractBrand, rebaseBrandPaths } from "../init/brand.js";
import { copyTemplate } from "../init/copy-template.js";
import { writeAidaConfig } from "../init/write-config.js";
import { writeCiWorkflow, writeClaudeRepairWorkflow } from "../init/ci.js";
import {
  defaultCommandRunner,
  ensureEngineBuilt,
  installDependencies,
  packEngine,
  pruneOldTarballs,
  setAidaDependency,
  type CommandRunner,
} from "../init/install.js";
import {
  ensureStudioKey,
  localStudioAccessUrl,
  normalizeTunnelHost,
  studioAccessUrl,
  writeTunnelHosts,
  STUDIO_HOSTS_VAR,
  TUNNEL_HOST_WARNING,
} from "../init/env-local.js";
import { isAuthJs, writeAuthJsSignIn, SIGN_IN_ADAPTER_PATH } from "../init/sign-in-template.js";
import { excludeHelpFromAppTsconfig, type ExcludeHelpResult } from "../init/app-tsconfig.js";
import { checkAppDatabase } from "../safety/index.js";
import type { BrandConfig } from "../config/types.js";
import { writeHelpAppTheme } from "../theme/write.js";

export interface InitOptions {
  /** Repo to add the help app to; `<dir>/help` is the destination. Default cwd. */
  dir?: string;
  /** App repo to detect brand/framework/routes from. Default: same as `dir`. */
  appRepo?: string;
  /** App directory within a workspace monorepo (relative to appRepo, or absolute). Required when
   * `appRepo` is a monorepo with several Next.js apps. */
  app?: string;
  /** Default app URL written into aida.config.ts when nothing better is known. */
  appUrl?: string;
  /** Also writes `.github/workflows/aida.yml` (build-plan.md M18). */
  ci?: boolean;
  /** `--ci`'s app-start command. Default "npm run dev". */
  ciStartCommand?: string;
  /** `--ci`'s `uses:` line for the aida action. Default "tryaida/aida@main" (decisions #25). */
  ciUses?: string;
  /** Also writes `.github/workflows/aida-repair.yml` (build-plan.md M19 item 2) — opt-in Claude
   * Code repair on an `@claude` comment or the `docs:repair` label. Requires `ci`. */
  ciClaude?: boolean;
  /** `--claude`'s trigger phrase. Default "@claude". */
  ciClaudeTriggerPhrase?: string;
  /** `--claude`'s label trigger. Default "docs:repair". */
  ciClaudeLabel?: string;
  /** `owner/repo` of a separate docs repo (build-plan.md M19 item 3) — sets `config.ci.docsRepo`
   * and has the generated workflow check it out to `.aida-docs` with `AIDA_DOCS_TOKEN`. */
  ciDocsRepo?: string;
  /** Runs `npm install` in the help app after scaffolding. Default true (`--no-install` skips). */
  install?: boolean;
  /** Hosts a dev tunnel or proxy serves the help app on (`--tunnel-host`, repeatable), added to
   * `AIDA_STUDIO_ALLOWED_HOSTS` in help/.env.local. */
  tunnelHosts?: string[];
  /** Runs npm (build, pack, install). Tests inject a fake; default spawns the real command. */
  runner?: CommandRunner;
  /** The engine package to pack. Default: this one (`ENGINE_DIR`); tests use a stand-in. */
  engineDir?: string;
}

export interface InitResult {
  destDir: string;
  appRepoDir: string;
  /** The app's own directory (the repo, or `--app` inside a workspace). */
  appRoot: string;
  framework: string;
  routes: string[];
  brand: BrandConfig;
  copied: number;
  skipped: string[];
  config: { file: string; written: boolean };
  /** Theme files written from the detected brand (only when the config was freshly written —
   * an existing config is the source of truth; run `aida theme` for it). */
  theme?: { files: string[]; written: string[]; warnings: string[] };
  ci?: { file: string; written: boolean };
  claudeRepair?: { file: string; written: boolean };
  /** The packed engine and the help app's dependency on it. */
  engine: { tarball: string; spec: string; built: boolean; packageJsonUpdated: boolean; removed: string[] };
  /** Whether `npm install` ran in the help app. */
  installed: boolean;
  /** help/.env.local's Studio hosts and access key, when `--tunnel-host` was given.
   * `secretStudioUrls` holds one access link per host and `secretLocalStudioUrl` the same link on
   * localhost (with a key set the Studio needs it there too), key included: anyone with one can
   * edit the help app's files, so never log or share it. `keyCreated` is false when an existing
   * key was kept. */
  tunnelHosts?: {
    file: string;
    hosts: string[];
    added: string[];
    keyCreated: boolean;
    secretStudioUrls: string[];
    secretLocalStudioUrl: string;
  };
  /** The starter sign-in adapter, when the app uses Auth.js. `configured` is false when an
   * existing config with no `signIn` was left alone (add it by hand). */
  signIn?: { file: string; written: boolean; configured: boolean };
  /** The help folder added to the app's own tsconfig `exclude`, so the app's `next build` doesn't
   * typecheck the help app. */
  appTsconfig: ExcludeHelpResult;
  /** What to do next, in order — printed by `runInit`. */
  nextSteps: string[];
}

export function runInitCommand(options: InitOptions): InitResult {
  const dir = resolve(options.dir ?? process.cwd());
  const appRepoDir = resolve(options.appRepo ?? dir);
  const destDir = resolve(dir, "help");

  const detected = detectFramework(appRepoDir, { app: options.app });
  if (detected.apps && detected.apps.length > 1) {
    const list = detected.apps.map((a) => `${a.path} (${a.routeCount} routes)`).join(", ");
    throw new Error(`found ${detected.apps.length} Next.js apps in this workspace — pass --app <path> to pick one: ${list}`);
  }
  // Asset paths come back relative to the app repo; the config wants them relative to itself.
  const brand = rebaseBrandPaths(extractBrand(appRepoDir), appRepoDir, destDir);
  const runner = options.runner ?? defaultCommandRunner;
  // Checked before anything is written, so a bad --tunnel-host doesn't leave a half-done scaffold.
  const tunnelHostsInput = (options.tunnelHosts ?? []).map(normalizeTunnelHost);
  const { copied, skipped } = copyTemplate(destDir);
  const appTsconfig = excludeHelpFromAppTsconfig(detected.appRoot ?? appRepoDir, destDir);

  let signInFile: { file: string; written: boolean } | undefined;
  if (isAuthJs(detected.authLibrary) && detected.appRoot) {
    signInFile = writeAuthJsSignIn(destDir, detected.appRoot);
  }
  const config = writeAidaConfig({
    destDir,
    appUrl: options.appUrl ?? "http://localhost:3000",
    brand,
    detected,
    ci: options.ci ? { claudeAction: options.ciClaude, docsRepo: options.ciDocsRepo } : undefined,
    signIn: signInFile ? SIGN_IN_ADAPTER_PATH : undefined,
    appDir: detected.appRoot,
  });
  const signInConfigured = config.written || /\bsignIn\s*:/.test(readFileSync(config.file, "utf8"));
  let theme: InitResult["theme"];
  if (config.written) {
    const t = writeHelpAppTheme({ brand, configDir: destDir }, destDir);
    theme = { files: t.files, written: t.written, warnings: t.warnings };
  }

  let tunnelHosts: InitResult["tunnelHosts"];
  if (tunnelHostsInput.length > 0) {
    const t = writeTunnelHosts(destDir, tunnelHostsInput);
    const k = ensureStudioKey(destDir);
    tunnelHosts = {
      file: t.file,
      hosts: t.hosts,
      added: t.added,
      keyCreated: k.created,
      secretStudioUrls: t.hosts.map((h) => studioAccessUrl(h, k.key)),
      secretLocalStudioUrl: localStudioAccessUrl(k.key),
    };
  }

  let ci: { file: string; written: boolean } | undefined;
  let claudeRepair: { file: string; written: boolean } | undefined;
  if (options.ci) {
    ci = writeCiWorkflow({
      appRepo: appRepoDir,
      configPath: options.ciDocsRepo ? undefined : `${relative(appRepoDir, destDir)}/aida.config.ts`,
      startCommand: options.ciStartCommand,
      uses: options.ciUses,
      docsRepo: options.ciDocsRepo,
    });
    if (options.ciClaude) {
      claudeRepair = writeClaudeRepairWorkflow({
        appRepo: appRepoDir,
        triggerPhrase: options.ciClaudeTriggerPhrase,
        labelTrigger: options.ciClaudeLabel,
      });
    }
  }

  // Last, after every file is written, so a failed build or install leaves a complete scaffold
  // to re-run init on. Decisions #29: never a bare registry name. Pack this engine (built first when running from
  // source, so the tarball matches the code) and point the help app at the tarball.
  const built = ensureEngineBuilt(runner, options.engineDir);
  const pack = packEngine(destDir, runner, options.engineDir);
  const packageJsonUpdated = setAidaDependency(destDir, pack.spec);
  // Only now that package.json points at the new tarball: a failure before here leaves the old
  // tarball the help app still depends on.
  const removed = pruneOldTarballs(destDir, pack.spec);
  const install = options.install !== false;
  if (install) installDependencies(destDir, runner);

  return {
    destDir,
    appRepoDir,
    appRoot: detected.appRoot ?? appRepoDir,
    framework: detected.framework,
    routes: detected.routes,
    brand,
    copied: copied.length,
    skipped,
    config,
    theme,
    ci,
    claudeRepair,
    engine: { tarball: pack.file, spec: pack.spec, built, packageJsonUpdated, removed },
    installed: install,
    tunnelHosts,
    signIn: signInFile ? { ...signInFile, configured: signInConfigured } : undefined,
    appTsconfig,
    nextSteps: nextSteps({
      appTsconfig,
      destDir,
      appRoot: detected.appRoot ?? appRepoDir,
      installed: install,
      signIn: signInFile,
      signInConfigured,
      tunnel: tunnelHosts !== undefined || hasStudioHosts(destDir),
    }),
  };
}

function hasStudioHosts(destDir: string): boolean {
  const file = join(destDir, ".env.local");
  return existsSync(file) && new RegExp(`^\\s*(export\\s+)?${STUDIO_HOSTS_VAR}\\s*=\\s*\\S`, "m").test(readFileSync(file, "utf8"));
}

function nextSteps(o: {
  appTsconfig: ExcludeHelpResult;
  destDir: string;
  appRoot: string;
  installed: boolean;
  signIn?: { file: string };
  signInConfigured: boolean;
  tunnel: boolean;
}): string[] {
  const help = relative(process.cwd(), o.destDir) || ".";
  const app = relative(process.cwd(), o.appRoot) || ".";
  const steps: string[] = [];
  const inApp = app === "." ? "" : `cd ${app} && `;
  if (o.appTsconfig.status === "manual") {
    steps.push(`Add "${o.appTsconfig.entry}" to "exclude" in ${relative(process.cwd(), o.appTsconfig.file)}, so the app's own build doesn't typecheck the help app`);
  }
  if (!o.installed) steps.push(`Install the help app's dependencies: cd ${help} && npm install`);
  steps.push(
    `Run the app as a production build for capture: ${inApp}npx next build && npx next start ` +
      "(the dev server's cache grows to gigabytes over a capture run)",
  );
  if (o.signIn) {
    steps.push(
      `Check ${relative(process.cwd(), o.signIn.file)}: it mints an Auth.js session cookie per persona; make claims() match the app's jwt callback` +
        (o.signInConfigured ? "" : `, and add signIn: "${SIGN_IN_ADAPTER_PATH}" to the existing aida.config.ts`),
    );
  }
  const port = "use another port if the app is on 3000: npm run dev -- -p 3001";
  if (o.tunnel) {
    steps.push(
      `Open the help site and the Studio: cd ${help} && npm run dev (it listens on 127.0.0.1 only; point the tunnel at http://127.0.0.1:<port>), ` +
        `then open the Studio's private link once per browser, on localhost too: http://localhost:3000/studio/access#key=<AIDA_STUDIO_KEY from ${help}/.env.local> (${port})`,
    );
  } else {
    steps.push(`Open the help site and the Studio: cd ${help} && npm run dev (it listens on 127.0.0.1 only), then http://localhost:3000/studio (${port})`);
    steps.push(`Opening the Studio through a tunnel? Re-run init with --tunnel-host <host> (adds it to ${STUDIO_HOSTS_VAR} in ${help}/.env.local and prints a private access link, which localhost then needs too)`);
  }
  steps.push(`Commit ${help}/vendor/ along with the help app: hosts install the engine (aida-docs) from that tarball`);
  steps.push(`Make the docs: ask your coding agent (aida skills install --target ${app}), or write walkthroughs and run aida build`);
  return steps;
}

/** The app's database setting (decisions #27), checked once the help app is scaffolded. A warning
 * only: init never refuses, but capture will, so say so now. Undefined when the check itself
 * couldn't run. */
async function databaseWarning(appDir: string): Promise<{ status: string; message: string; suggestions: string[] } | undefined> {
  try {
    const check = await checkAppDatabase({ appDir });
    if (check.status === "local" || check.status === "throwaway") return undefined;
    return { status: check.status, message: check.message, suggestions: check.suggestions };
  } catch {
    return undefined;
  }
}

export async function runInit(options: InitOptions, json: boolean): Promise<number> {
  let result: InitResult;
  try {
    result = runInitCommand(options);
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    if (json) {
      console.log(JSON.stringify({ error: message }));
    } else {
      console.error(`error: ${message}`);
    }
    return 1;
  }

  const database = await databaseWarning(result.appRoot);
  if (json) {
    console.log(JSON.stringify({ ...result, database }));
    return 0;
  }

  console.log(`help app scaffolded at ${result.destDir}`);
  console.log(`  app repo: ${result.appRepoDir} (${result.framework})`);
  if (result.routes.length > 0) console.log(`  routes seen: ${result.routes.join(", ")}`);
  const brandEntries = Object.entries(result.brand).filter(([, v]) => typeof v === "string");
  if (brandEntries.length > 0) {
    console.log(`  brand: ${brandEntries.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  console.log(`  files written: ${result.copied}`);
  if (result.skipped.length > 0) {
    const list = result.skipped.length <= 8 ? `: ${result.skipped.join(", ")}` : "";
    console.log(`  skipped ${result.skipped.length} file(s) already present${list}`);
  }
  console.log(result.config.written ? `  wrote ${result.config.file}` : `  left existing ${result.config.file} untouched`);
  if (result.theme) {
    console.log(`  theme: ${result.theme.written.length} file(s) written (app/brand.css, lib/brand.json, public/brand/)`);
    for (const w of result.theme.warnings) console.log(`  warning: ${w}`);
  }
  if (result.ci) {
    console.log(result.ci.written ? `  wrote ${result.ci.file}` : `  left existing ${result.ci.file} untouched`);
  }
  if (result.claudeRepair) {
    console.log(result.claudeRepair.written ? `  wrote ${result.claudeRepair.file}` : `  left existing ${result.claudeRepair.file} untouched`);
  }
  console.log(`  aida-docs dependency: ${result.engine.spec}${result.engine.built ? " (engine built first)" : ""}`);
  if (result.engine.removed.length > 0) console.log(`  removed older tarball(s): ${result.engine.removed.join(", ")}`);
  console.log(result.installed ? "  installed dependencies (npm install)" : "  skipped npm install (--no-install)");
  if (result.tunnelHosts) {
    const t = result.tunnelHosts;
    console.log(`  Studio hosts in ${t.file}: ${t.hosts.join(", ")}`);
    console.log(`  Studio access key ${t.keyCreated ? "written to" : "already in"} ${t.file} (AIDA_STUDIO_KEY; restart the dev server)`);
    console.log("  Open the Studio with one of these private links (keep them secret). With a key set it needs one on localhost too:");
    for (const url of t.secretStudioUrls) console.log(`    ${url}`);
    console.log(`    ${t.secretLocalStudioUrl}  (this machine; use your dev server's port)`);
    console.log(`  warning: ${TUNNEL_HOST_WARNING}`);
  }
  if (result.appTsconfig.status === "added") {
    console.log(`  added "${result.appTsconfig.entry}" to "exclude" in ${result.appTsconfig.file}`);
  }
  if (result.appTsconfig.note) console.log(`  note: ${result.appTsconfig.note}`);
  if (result.signIn) {
    console.log(result.signIn.written ? `  wrote ${result.signIn.file} (Auth.js sign-in)` : `  left existing ${result.signIn.file} untouched`);
  }
  if (database) {
    console.log(`  warning: ${database.message}`);
    for (const s of database.suggestions) console.log(`    - ${s}`);
  }
  console.log("");
  console.log("next steps:");
  result.nextSteps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  return 0;
}
