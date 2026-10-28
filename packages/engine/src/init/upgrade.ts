// `aida upgrade` (build-plan.md M37): brings a scaffolded help app up to this engine's help-app
// template without touching the owner's content. Compares each template file three ways: the
// help app's copy, the template version recorded when it was last written (template-manifest.ts)
// and the current template.
//
//   missing in the help app                        -> added
//   unchanged since recorded                       -> replaced with the new version
//   changed by the owner, template unchanged       -> left alone
//   changed by the owner and in the template       -> left alone; new version beside it as
//                                                     `<file>.aida-new` (a conflict)
//   gone from the template, unchanged by the owner -> deleted
//   gone from the template, changed by the owner   -> left alone and reported
//   deleted by the owner                           -> not added back (reported when the template
//                                                     changed it since)
//   a symbolic link, or inside a linked folder     -> never written through: a linked file counts
//                                                     as changed by the owner, a linked folder is
//                                                     skipped and reported
//
// A help app with no manifest (scaffolded before M37) counts each file identical to the current
// template as the template's and everything else as changed by the owner. package.json is merged
// entry by entry the same way, keeping everything the owner added. Content, walkthroughs, the
// config, the brand theme files, env files and vendor/ are never touched (`isUpgradeable`).
//
// `planUpgrade` only reads; `applyUpgrade` writes what it planned. The engine tarball refresh and
// npm install happen in commands/upgrade.ts, the same way `aida init` does them.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { TEMPLATE_DIR } from "./copy-template.js";
import {
  PACKAGE_FIELDS,
  engineVersion,
  isSafeManifestPath,
  isUpgradeable,
  packageSnapshot,
  readTemplateManifest,
  sha256File,
  upgradeableTemplateFiles,
  writeTemplateManifest,
  type PackageField,
  type PackageSnapshot,
  type TemplateManifest,
} from "./template-manifest.js";

/** Suffix of the new template version written beside a file the owner changed. */
export const NEW_VERSION_SUFFIX = ".aida-new";

export type UpgradeFileAction =
  | "add"
  | "update"
  | "remove"
  | "conflict"
  /** Gone from the template, changed by the owner: left in place. */
  | "kept-removed"
  /** Deleted by the owner and changed in the template since: not added back. */
  | "deleted"
  /** Inside a symbolically linked folder, or not a regular file: left alone. */
  | "skipped";

export interface UpgradeFileChange {
  /** Help-app path (POSIX). */
  path: string;
  action: UpgradeFileAction;
  /** For a conflict: where the new template version goes (`<path>.aida-new`). */
  newFile?: string;
  /** For a conflict: an earlier, different `.aida-new` there is replaced. */
  replacesNewFile?: boolean;
  /** For "skipped": why. */
  reason?: string;
}

export interface PackageJsonChange {
  field: PackageField;
  name: string;
  action: "add" | "update" | "remove" | "conflict";
  /** The help app's value before the upgrade. */
  from?: string;
  /** The value after (for a conflict: the template's, which was not applied). */
  to?: string;
}

export interface UpgradePlan {
  helpDir: string;
  templateDir: string;
  /** False for an app scaffolded before the manifest existed. */
  hadManifest: boolean;
  previousEngineVersion?: string;
  engineVersion: string;
  files: UpgradeFileChange[];
  /** Template files already identical to the current template. */
  unchanged: number;
  /** Template files the owner changed where the template hasn't changed since: left alone. */
  ownerChanged: number;
  packageJson: { changes: PackageJsonChange[]; next?: string };
  manifest: TemplateManifest;
}

export interface PlanUpgradeOptions {
  templateDir?: string;
  engineRoot?: string;
}

/** The absolute path of a help-app path, refusing one that would land outside the help app. */
function appPath(helpDir: string, path: string): string {
  const abs = resolve(helpDir, ...path.split("/"));
  const rel = relative(resolve(helpDir), abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`refusing ${path}: it is outside the help app ${helpDir}`);
  return abs;
}

/** What is at a help-app path, without following symbolic links: nothing, a regular file, a
 * symbolic link, or something upgrade must not touch (a folder on the way is a link, or the path
 * is a folder or other non-file). */
type PathState = { kind: "missing" } | { kind: "file" } | { kind: "link" } | { kind: "blocked"; reason: string };
function pathState(helpDir: string, path: string): PathState {
  const parts = path.split("/");
  let cur = resolve(helpDir);
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return { kind: "missing" };
    }
    const last = i === parts.length - 1;
    if (st.isSymbolicLink()) return last ? { kind: "link" } : { kind: "blocked", reason: `${parts.slice(0, i + 1).join("/")} is a symbolic link` };
    if (last && !st.isFile()) return { kind: "blocked", reason: "not a regular file" };
    if (!last && !st.isDirectory()) return { kind: "blocked", reason: `${parts.slice(0, i + 1).join("/")} is not a folder` };
  }
  return { kind: "file" };
}

function planPackageJson(
  helpDir: string,
  template: PackageSnapshot,
  recorded: PackageSnapshot | undefined,
): { changes: PackageJsonChange[]; next?: string } {
  const file = join(helpDir, "package.json");
  // Not merged through a symbolic link (or with no package.json at all).
  if (pathState(helpDir, "package.json").kind !== "file") return { changes: [] };
  const raw = readFileSync(file, "utf8");
  const pkg = JSON.parse(raw) as Record<string, unknown>;
  const indent = raw.match(/^[ \t]+(?=")/m)?.[0] ?? "  ";
  const changes: PackageJsonChange[] = [];
  const depFields = PACKAGE_FIELDS.filter((f) => f !== "scripts");
  // A dependency the owner moved to another dependency field is still the same dependency.
  const fieldHolding = (field: PackageField, name: string): PackageField | undefined => {
    const has = (f: PackageField) => typeof (pkg[f] as Record<string, unknown> | undefined)?.[name] === "string";
    if (has(field)) return field;
    return field === "scripts" ? undefined : depFields.find(has);
  };

  for (const field of PACKAGE_FIELDS) {
    const want = template[field] ?? {};
    const was = recorded?.[field];
    for (const [name, to] of Object.entries(want)) {
      const at = fieldHolding(field, name);
      if (!at) {
        changes.push({ field, name, action: "add", to });
        ((pkg[field] ??= {}) as Record<string, string>)[name] = to;
        continue;
      }
      const entries = pkg[at] as Record<string, string>;
      const from = entries[name];
      if (from === to) continue;
      const recordedValue = was?.[name];
      if (from === recordedValue) {
        // Unchanged since it was written: take the template's.
        changes.push({ field: at, name, action: "update", from, to });
        entries[name] = to;
      } else if (recordedValue !== to) {
        // The owner changed it (or, with no record, it differs and may be theirs: an older
        // template's range, or their own bump) and the template has another value: keep theirs
        // and say so, never downgrade.
        changes.push({ field: at, name, action: "conflict", from, to });
      }
    }
    // Entries the template dropped: removed when the owner never changed them.
    for (const [name, recordedValue] of Object.entries(was ?? {})) {
      if (name in want) continue;
      const at = fieldHolding(field, name);
      if (!at) continue;
      const entries = pkg[at] as Record<string, string>;
      if (entries[name] === recordedValue) {
        changes.push({ field: at, name, action: "remove", from: recordedValue });
        delete entries[name];
      }
    }
  }
  const next = JSON.stringify(pkg, null, indent) + "\n";
  return { changes, next: next === raw ? undefined : next };
}

/** Works out what `aida upgrade` would do to the help app at `helpDir`. Writes nothing. */
export function planUpgrade(helpDir: string, opts: PlanUpgradeOptions = {}): UpgradePlan {
  const templateDir = opts.templateDir ?? TEMPLATE_DIR;
  if (!existsSync(join(templateDir, "package.json"))) throw new Error(`help-app template not found at ${templateDir}`);
  const previous = readTemplateManifest(helpDir);
  const recorded = previous?.files ?? {};
  const templateFiles = upgradeableTemplateFiles(templateDir);

  const files: UpgradeFileChange[] = [];
  const nextFiles: Record<string, string> = {};
  let unchanged = 0;
  let ownerChanged = 0;

  for (const [path, src] of templateFiles) {
    const newHash = sha256File(src);
    const dest = appPath(helpDir, path);
    const state = pathState(helpDir, path);
    nextFiles[path] = newHash;
    if (state.kind === "blocked") {
      files.push({ path, action: "skipped", reason: state.reason });
      if (recorded[path]) nextFiles[path] = recorded[path];
      else delete nextFiles[path];
      continue;
    }
    if (state.kind === "missing") {
      // Recorded but gone: the owner deleted it (e.g. to turn a route off). Don't bring it back;
      // say so once if the template has changed it since.
      if (recorded[path] === undefined) files.push({ path, action: "add" });
      else if (recorded[path] !== newHash) files.push({ path, action: "deleted" });
      continue;
    }
    // A symbolic link is never read through or written through: it counts as the owner's.
    const current = state.kind === "link" ? undefined : sha256File(dest);
    if (current === newHash) {
      unchanged++;
    } else if (current !== undefined && recorded[path] === current) {
      files.push({ path, action: "update" });
    } else if (recorded[path] === newHash) {
      ownerChanged++;
    } else {
      // Changed by the owner (or, with no record, not known to be the template's) and the
      // template has a different version now. Recording the new hash means the next upgrade
      // won't raise the same conflict again, only a newer one.
      const newFile = path + NEW_VERSION_SUFFIX;
      const at = pathState(helpDir, newFile);
      if (at.kind === "blocked") {
        files.push({ path, action: "skipped", reason: `${newFile}: ${at.reason}` });
        continue;
      }
      // An earlier .aida-new is ours to replace, but say so when it differs (the owner may have
      // been editing it); a link there is removed, never written through.
      const replacesNewFile = at.kind === "link" || (at.kind === "file" && sha256File(appPath(helpDir, newFile)) !== newHash);
      files.push({ path, action: "conflict", newFile, ...(replacesNewFile ? { replacesNewFile } : {}) });
    }
  }

  for (const [path, hash] of Object.entries(recorded)) {
    // readTemplateManifest already drops unsafe keys; checked again so a hand-built plan can't
    // reach outside the help app either.
    if (templateFiles.has(path) || !isSafeManifestPath(path) || !isUpgradeable(path)) continue;
    appPath(helpDir, path);
    const state = pathState(helpDir, path);
    if (state.kind === "missing") continue;
    if (state.kind === "blocked") files.push({ path, action: "skipped", reason: state.reason });
    else files.push({ path, action: state.kind === "file" && sha256File(appPath(helpDir, path)) === hash ? "remove" : "kept-removed" });
  }

  const templatePackage = packageSnapshot(join(templateDir, "package.json"));
  const packageJson = planPackageJson(helpDir, templatePackage, previous?.packageJson);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    helpDir,
    templateDir,
    hadManifest: previous !== undefined,
    previousEngineVersion: previous?.engineVersion,
    engineVersion: engineVersion(opts.engineRoot),
    files,
    unchanged,
    ownerChanged,
    packageJson,
    manifest: { version: 1, engineVersion: engineVersion(opts.engineRoot), files: nextFiles, packageJson: templatePackage },
  };
}

/** Removes `dir` and its parents up to (not including) `stopAt` while they're empty. */
function removeEmptyDirs(dir: string, stopAt: string): void {
  while (dir.startsWith(stopAt) && dir !== stopAt) {
    if (!existsSync(dir) || readdirSync(dir).length > 0) return;
    rmdirSync(dir);
    dir = dirname(dir);
  }
}

/** Writes what `plan` says: copies, conflict files, deletions, the merged package.json and the
 * new manifest. */
export function applyUpgrade(plan: UpgradePlan): void {
  const templateFiles = upgradeableTemplateFiles(plan.templateDir);
  for (const change of plan.files) {
    const dest = appPath(plan.helpDir, change.path);
    switch (change.action) {
      case "add":
      case "update":
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(templateFiles.get(change.path)!, dest);
        break;
      case "conflict": {
        const newFile = appPath(plan.helpDir, change.newFile!);
        if (pathState(plan.helpDir, change.newFile!).kind === "link") unlinkSync(newFile);
        copyFileSync(templateFiles.get(change.path)!, newFile);
        break;
      }
      case "remove":
        rmSync(dest, { force: true });
        removeEmptyDirs(dirname(dest), plan.helpDir);
        break;
      case "kept-removed":
      case "deleted":
      case "skipped":
        break;
    }
  }
  if (plan.packageJson.next) writeFileSync(join(plan.helpDir, "package.json"), plan.packageJson.next, "utf8");
  writeTemplateManifest(plan.helpDir, plan.manifest);
}
