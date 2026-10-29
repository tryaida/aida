// `npm pack` / `npm publish` lifecycle (prepack): makes packages/engine a self-contained package.
//
//   1. A clean build: dist/ and tsc's build info removed, then `tsc -p tsconfig.build.json` (no
//      source maps or declaration maps; .d.ts kept). An incremental `tsc -b` leaves the output of
//      deleted sources in dist/, and the published package would ship it.
//   2. The help-app template, packages/help-app -> templates/help-app: exactly the files
//      `aida init` copies (listTemplateFiles in src/init/copy-template.ts), limited to files git
//      tracks when git is available, so nothing generated or local-only in a developer's checkout
//      ships. `.gitignore` is stored as `_gitignore` (npm never packs a .gitignore).
//   3. The agent skills, <repo>/skills -> skills/ (git-tracked files, without the repo's own
//      checker, check.mjs).
//   4. The repo's LICENSE and NOTICE.
//
// scripts/postpack.mjs removes 2-4 again (they're git-ignored meanwhile). Plain Node, no shell, so
// it runs the same on Windows. Only ever run from a clone of the aida repo.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { copyDistAssets } from "./copy-dist-assets.mjs";
import { cleanBundled } from "./postpack.mjs";

const engineDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(engineDir, "..", "..");
const helpAppDir = join(repoRoot, "packages", "help-app");
const skillsSrc = join(repoRoot, "skills");

function fail(message) {
  console.error(`prepack: ${message}`);
  process.exit(1);
}

for (const [what, path] of [["help-app template", join(helpAppDir, "package.json")], ["skills", join(skillsSrc, "agents")], ["LICENSE", join(repoRoot, "LICENSE")], ["NOTICE", join(repoRoot, "NOTICE")]]) {
  if (!existsSync(path)) fail(`no ${what} at ${path}; pack from a clone of the aida repo`);
}

// Leftovers from an interrupted pack.
cleanBundled();

// 1. Clean build.
rmSync(join(engineDir, "dist"), { recursive: true, force: true });
rmSync(join(engineDir, "tsconfig.tsbuildinfo"), { force: true });
const tsc = createRequire(join(engineDir, "package.json")).resolve("typescript/bin/tsc");
const build = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], { cwd: engineDir, stdio: "inherit" });
if (build.status !== 0) fail(`tsc failed (exit ${build.status ?? build.error?.message})`);
if (!existsSync(join(engineDir, "dist", "index.js"))) fail("the build left no dist/index.js");
copyDistAssets(engineDir);
// npm makes bin targets executable on install; set it here too so the tarball carries it.
if (process.platform !== "win32") chmodSync(join(engineDir, "dist", "cli.js"), 0o755);

/** Files git tracks under `dir` (relative to it, `/`-separated), or undefined without git. */
function gitTracked(dir) {
  const r = spawnSync("git", ["ls-files", "-z", "--", "."], { cwd: dir, encoding: "utf8" });
  if (r.status !== 0 || r.error) return undefined;
  return new Set(r.stdout.split("\0").filter(Boolean));
}

const toPosix = (p) => p.split(sep).join("/");

function warnUntracked(what, files) {
  if (files.length === 0) return;
  console.warn(`prepack: leaving ${files.length} untracked file(s) out of the ${what}: ${files.slice(0, 10).join(", ")}${files.length > 10 ? ", ..." : ""}`);
}

function listAll(dir, base = "", out = []) {
  for (const entry of readdirSync(join(dir, base), { withFileTypes: true })) {
    const rel = base ? join(base, entry.name) : entry.name;
    if (entry.isDirectory()) listAll(dir, rel, out);
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

// 2. Help-app template, through the freshly built copy logic so the package ships what init copies.
const { listTemplateFiles, DOTFILES_FOR_PACKING } = await import(pathToFileURL(join(engineDir, "dist", "init", "copy-template.js")).href);
const templateDest = join(engineDir, "templates", "help-app");
{
  const tracked = gitTracked(helpAppDir);
  if (!tracked) console.warn("prepack: git unavailable; bundling the help-app template without the tracked-files check");
  const untracked = [];
  let count = 0;
  for (const rel of listTemplateFiles(helpAppDir)) {
    if (tracked && !tracked.has(toPosix(rel))) {
      untracked.push(toPosix(rel));
      continue;
    }
    const name = DOTFILES_FOR_PACKING[rel.split(sep).pop()];
    const destRel = name ? join(dirname(rel), name) : rel;
    mkdirSync(dirname(join(templateDest, destRel)), { recursive: true });
    copyFileSync(join(helpAppDir, rel), join(templateDest, destRel));
    count++;
  }
  warnUntracked("help-app template", untracked);
  if (count === 0) fail("the help-app template came out empty");
  console.log(`prepack: bundled ${count} help-app template files into ${relative(engineDir, templateDest)}`);
}

// 3. Skills.
{
  const skillsDest = join(engineDir, "skills");
  const tracked = gitTracked(skillsSrc);
  const untracked = [];
  let count = 0;
  for (const rel of listAll(skillsSrc)) {
    if (rel === "check.mjs") continue;
    if (tracked && !tracked.has(toPosix(rel))) {
      untracked.push(toPosix(rel));
      continue;
    }
    mkdirSync(dirname(join(skillsDest, rel)), { recursive: true });
    copyFileSync(join(skillsSrc, rel), join(skillsDest, rel));
    count++;
  }
  warnUntracked("skills", untracked);
  if (!existsSync(join(skillsDest, "agents"))) fail("the bundled skills have no agents/ folder");
  console.log(`prepack: bundled ${count} skill files into skills`);
}

// 4. LICENSE and NOTICE.
for (const name of ["LICENSE", "NOTICE"]) copyFileSync(join(repoRoot, name), join(engineDir, name));
