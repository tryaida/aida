// `aida upgrade [--dir <help app>] [--dry-run] [--force] [--no-install] [--json]` (build-plan.md
// M37): updates a scaffolded help app to this engine's help-app template without touching the
// owner's content (see init/upgrade.ts for the rules), then refreshes the packed engine tarball
// and runs `npm install` the same way `aida init` does.
//
// Safe by default: refuses when the help app has uncommitted changes in git, or isn't in a git
// repo at all (so every change the upgrade makes shows up on its own in `git diff` and can be
// undone), unless `--force`.
// `--dry-run` reports what would change and writes nothing.
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  defaultCommandRunner,
  ensureEngineBuilt,
  installDependencies,
  packageJsonWriteProblem,
  packEngine,
  pruneOldTarballs,
  setAidaDependency,
  type CommandRunner,
} from "../init/install.js";
import { manifestWriteProblem } from "../init/template-manifest.js";
import { applyUpgrade, planUpgrade, type PackageJsonChange, type UpgradeFileChange } from "../init/upgrade.js";

export interface UpgradeOptions {
  /** The help app, or a repo holding it at `help/`. Default cwd. */
  dir?: string;
  dryRun?: boolean;
  /** Upgrade even with uncommitted changes in the help app, or outside git. */
  force?: boolean;
  /** Runs `npm install` afterwards. Default true (`--no-install` skips). */
  install?: boolean;
  /** Runs npm (build, pack, install). Tests inject a fake. */
  runner?: CommandRunner;
  /** Runs git for the uncommitted-changes check. Default spawns the real git. */
  git?: CommandRunner;
  /** The engine package to pack. Default: this one. */
  engineDir?: string;
  /** The help-app template. Default: this engine's. */
  templateDir?: string;
}

export interface UpgradeResult {
  helpDir: string;
  dryRun: boolean;
  /** False for a help app scaffolded before the template manifest existed. */
  hadManifest: boolean;
  previousEngineVersion?: string;
  engineVersion: string;
  added: string[];
  updated: string[];
  removed: string[];
  /** Files the owner changed that the template also changed: the new version is beside each.
   * `replacesNewFile` when an earlier, different `.aida-new` there was replaced. */
  conflicts: Array<{ path: string; newFile: string; replacesNewFile?: boolean }>;
  /** Files the owner deleted that the template has changed since: not added back. */
  deleted: string[];
  /** Files left alone because they're in a symbolically linked folder or aren't regular files. */
  skipped: Array<{ path: string; reason: string }>;
  /** Files no longer in the template that the owner changed, so were left in place. */
  keptRemoved: string[];
  unchanged: number;
  ownerChanged: number;
  packageJson: { changes: PackageJsonChange[]; conflicts: PackageJsonChange[]; written: boolean };
  /** Why package.json wasn't merged and the engine tarball wasn't refreshed (package.json is a
   * symbolic link), when that happened. */
  engineSkipped?: string;
  /** Why the template record can't be written (on a dry run; a real run refuses). */
  manifestProblem?: string;
  /** The refreshed engine tarball (not on a dry run). */
  engine?: { spec: string; built: boolean; packageJsonUpdated: boolean; removed: string[] };
  installed: boolean;
  nextSteps: string[];
}

const NEXT_CONFIGS = ["next.config.mjs", "next.config.ts", "next.config.js"];

function isHelpApp(dir: string): boolean {
  return existsSync(join(dir, "package.json")) && NEXT_CONFIGS.some((f) => existsSync(join(dir, f)));
}

/** The help app: `dir` itself, or `dir/help` (where `aida init` puts it). */
export function resolveHelpDir(dir: string | undefined): string {
  const base = resolve(dir ?? process.cwd());
  if (isHelpApp(base)) return base;
  if (isHelpApp(join(base, "help"))) return join(base, "help");
  throw new Error(`no help app at ${base} or ${join(base, "help")} (looked for package.json and next.config.*); pass --dir <help app>`);
}

/** Uncommitted changes under `helpDir` per git, or undefined when it isn't in a git repo (or git
 * isn't installed). */
export function uncommittedChanges(helpDir: string, git: CommandRunner = defaultCommandRunner): string[] | undefined {
  const r = git("git", ["status", "--porcelain", "--untracked-files=all", "--", "."], { cwd: helpDir });
  if (r.status !== 0) return undefined;
  return r.stdout.split("\n").filter((l) => l.trim() !== "");
}

const pick = (files: UpgradeFileChange[], action: UpgradeFileChange["action"]) => files.filter((f) => f.action === action);

export function runUpgradeCommand(options: UpgradeOptions): UpgradeResult {
  const helpDir = resolveHelpDir(options.dir);
  const dryRun = Boolean(options.dryRun);
  if (!dryRun && !options.force) {
    const dirty = uncommittedChanges(helpDir, options.git);
    if (dirty === undefined) {
      throw new Error(
        `${helpDir} isn't in a git repository (or git isn't installed), so the upgrade's changes couldn't be reviewed or undone. ` +
          "Commit the help app to git first, see what would change with --dry-run, or pass --force",
      );
    }
    if (dirty.length > 0) {
      const list = dirty.slice(0, 5).map((l) => l.trim()).join(", ");
      throw new Error(
        `${helpDir} has ${dirty.length} uncommitted change(s) (${list}${dirty.length > 5 ? ", ..." : ""}). ` +
          "Commit or stash them first so the upgrade's own changes are easy to review, or pass --force",
      );
    }
  }

  // Checked before anything is written. A linked template record would leave the upgrade with
  // nothing to compare against next time, so refuse; a linked package.json is only skipped.
  const manifestProblem = manifestWriteProblem(helpDir);
  if (manifestProblem && !dryRun) throw new Error(manifestProblem);
  const engineSkipped = packageJsonWriteProblem(helpDir);

  const plan = planUpgrade(helpDir, { templateDir: options.templateDir });
  const runner = options.runner ?? defaultCommandRunner;
  let engine: UpgradeResult["engine"];
  let installed = false;
  if (!dryRun) applyUpgrade(plan);
  if (!dryRun && !engineSkipped) {
    // As in `aida init`: pack this engine and point the help app at it, and only then prune the
    // old tarball, so a failed pack leaves the help app on the one it already has.
    const built = ensureEngineBuilt(runner, options.engineDir);
    const pack = packEngine(helpDir, runner, options.engineDir);
    const packageJsonUpdated = setAidaDependency(helpDir, pack.spec);
    const removed = pruneOldTarballs(helpDir, pack.spec);
    engine = { spec: pack.spec, built, packageJsonUpdated, removed };
    if (options.install !== false) {
      installDependencies(helpDir, runner);
      installed = true;
    }
  }

  const conflicts = pick(plan.files, "conflict").map((f) => ({ path: f.path, newFile: f.newFile!, ...(f.replacesNewFile ? { replacesNewFile: true } : {}) }));
  const keptRemoved = pick(plan.files, "kept-removed").map((f) => f.path);
  const pkgConflicts = plan.packageJson.changes.filter((c) => c.action === "conflict");
  return {
    helpDir,
    dryRun,
    hadManifest: plan.hadManifest,
    previousEngineVersion: plan.previousEngineVersion,
    engineVersion: plan.engineVersion,
    added: pick(plan.files, "add").map((f) => f.path),
    updated: pick(plan.files, "update").map((f) => f.path),
    removed: pick(plan.files, "remove").map((f) => f.path),
    conflicts,
    deleted: pick(plan.files, "deleted").map((f) => f.path),
    skipped: pick(plan.files, "skipped").map((f) => ({ path: f.path, reason: f.reason ?? "" })),
    keptRemoved,
    unchanged: plan.unchanged,
    ownerChanged: plan.ownerChanged,
    packageJson: {
      changes: plan.packageJson.changes.filter((c) => c.action !== "conflict"),
      conflicts: pkgConflicts,
      written: !dryRun && plan.packageJson.next !== undefined,
    },
    ...(engineSkipped ? { engineSkipped } : {}),
    ...(manifestProblem ? { manifestProblem } : {}),
    engine,
    installed,
    nextSteps: nextSteps(helpDir, { dryRun, hadManifest: plan.hadManifest, conflicts, keptRemoved, pkgConflicts, installed, engineSkipped: engineSkipped !== undefined }),
  };
}

function nextSteps(
  helpDir: string,
  o: { dryRun: boolean; hadManifest: boolean; conflicts: Array<{ path: string; newFile: string }>; keptRemoved: string[]; pkgConflicts: PackageJsonChange[]; installed: boolean; engineSkipped: boolean },
): string[] {
  const help = relative(process.cwd(), helpDir) || ".";
  const steps: string[] = [];
  if (o.dryRun) {
    steps.push(`Run without --dry-run to make these changes: aida upgrade --dir ${help}`);
    return steps;
  }
  if (o.engineSkipped) {
    steps.push(`Replace the symbolic link at ${help}/package.json with a regular file, then run aida upgrade again to merge it and refresh the engine tarball`);
  }
  if (o.conflicts.length > 0) {
    steps.push(
      `${o.hadManifest ? `You changed ${o.conflicts.length} file(s) that the template changed too` : `${o.conflicts.length} file(s) differ from the current template`}. ` +
        "For each, compare yours with the new version beside it " +
        `(e.g. diff ${help}/${o.conflicts[0].path} ${help}/${o.conflicts[0].newFile}), bring over what you want, then delete the .aida-new file`,
    );
  }
  if (o.keptRemoved.length > 0) {
    steps.push(`The template no longer has ${o.keptRemoved.join(", ")}; you changed them, so they were kept. Delete them if nothing uses them`);
  }
  if (o.pkgConflicts.length > 0) {
    steps.push(`Check ${help}/package.json: your value was kept for ${o.pkgConflicts.map((c) => `${c.field}.${c.name}`).join(", ")} (the template's is in the summary)`);
  }
  if (!o.installed) steps.push(`Install the help app's dependencies: cd ${help} && npm install`);
  steps.push(`Check the help app still builds (cd ${help} && npx next build), then commit the changes with ${help}/vendor/ and ${help}/.aida/template.json`);
  return steps;
}

function list(label: string, items: string[]): void {
  if (items.length === 0) return;
  const shown = items.length <= 10 ? `: ${items.join(", ")}` : `: ${items.slice(0, 10).join(", ")}, and ${items.length - 10} more`;
  console.log(`  ${label} ${items.length}${shown}`);
}

export async function runUpgrade(options: UpgradeOptions, json: boolean): Promise<number> {
  let result: UpgradeResult;
  try {
    result = runUpgradeCommand(options);
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    if (json) console.log(JSON.stringify({ error: message }));
    else console.error(`error: ${message}`);
    return 1;
  }
  if (json) {
    console.log(JSON.stringify(result));
    return 0;
  }

  const from = result.previousEngineVersion ? ` from ${result.previousEngineVersion}` : "";
  console.log(`${result.dryRun ? "would upgrade" : "upgraded"} ${result.helpDir}${from} to the aida ${result.engineVersion} template`);
  if (!result.hadManifest) {
    console.log("  no record of the template it was made from: files that differ from the current template count as yours");
  }
  list(result.dryRun ? "would add" : "added", result.added);
  list(result.dryRun ? "would update" : "updated", result.updated);
  list(result.dryRun ? "would remove" : "removed", result.removed);
  if (result.conflicts.length > 0) {
    const label = result.hadManifest ? "changed by you and in the template" : "different from the current template";
    console.log(`  ${label} ${result.conflicts.length} (kept yours; new version ${result.dryRun ? "would go" : "is"} beside it):`);
    for (const c of result.conflicts) console.log(`    ${c.path} -> ${c.newFile}${c.replacesNewFile ? " (replaces the earlier, different one)" : ""}`);
  }
  list("deleted by you, not added back (the template changed them since)", result.deleted);
  for (const s of result.skipped) console.log(`  left alone ${s.path}: ${s.reason}`);
  list("no longer in the template, kept because you changed them", result.keptRemoved);
  console.log(`  already current: ${result.unchanged}${result.ownerChanged > 0 ? `; changed by you, template unchanged: ${result.ownerChanged}` : ""}`);
  for (const c of result.packageJson.changes) {
    const what = c.action === "remove" ? `removed ${c.from}` : c.action === "add" ? `added ${c.to}` : `${c.from} -> ${c.to}`;
    console.log(`  package.json ${c.field}.${c.name}: ${what}`);
  }
  for (const c of result.packageJson.conflicts) {
    console.log(`  package.json ${c.field}.${c.name}: kept yours (${c.from}); the template has ${c.to}`);
  }
  if (result.manifestProblem) console.log(`  warning: ${result.manifestProblem} (a real run refuses)`);
  if (result.engineSkipped) {
    console.log(`  skipped the package.json merge and the engine tarball refresh: ${result.engineSkipped}`);
  } else if (result.engine) {
    console.log(`  aida-docs dependency: ${result.engine.spec}${result.engine.built ? " (engine built first)" : ""}`);
    if (result.engine.removed.length > 0) console.log(`  removed older tarball(s): ${result.engine.removed.join(", ")}`);
    console.log(result.installed ? "  installed dependencies (npm install)" : "  skipped npm install (--no-install)");
  } else {
    console.log("  would refresh the aida-docs engine tarball in vendor/ and run npm install");
  }
  console.log("");
  console.log("next steps:");
  result.nextSteps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  return 0;
}
