// Installing a scaffolded help app (build-plan.md M25, decisions #29). Until aida is published
// under its final name, the help app never depends on a bare registry name — `"aida": "*"`
// once resolved to an unrelated npm package that owns the name. Instead `aida init` packs this
// engine into `<help>/vendor/aida-<version>-<hash>.tgz` and points the dependency at that file.
// A tarball installs as a real copy (not a symlink, which Turbopack rejects), and a host that only
// runs `npm install && next build` installs it the same way.
//
// The tarball is a lean runtime build, not the whole engine (decision 17: hosts only run
// `next build`). The help app only loads the search, chat, agent connector, Studio edit and
// walkthrough modules, so the packed package.json keeps only the npm dependencies those reach
// (HELP_APP_RUNTIME_DEPENDENCIES) and has no `bin`: capture, voice, render and PDFs run from the
// aida checkout (later the published package), which loads the help app's config from here. That
// leaves out Playwright, Kokoro/onnxruntime, ffmpeg and pdf-lib (~830 MB). The same `dist/` ships,
// so any module the help app imports is there; test/package/runtime-imports.test.ts fails when one
// of them starts importing a dependency outside the list.
//
// The content hash is in the name because npm treats a `file:` tarball whose path hasn't changed
// as already installed: a re-run with a changed engine under the same name would leave the old
// copy in node_modules and a stale integrity in package-lock.json, which `npm ci` on a host then
// refuses. The hash is over the staged files (paths and bytes), not the gzip bytes, which differ
// across npm and zlib versions, so an unchanged engine keeps the same name everywhere.
//
// Every external command goes through a `CommandRunner`, so tests never really build, pack or
// install.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd: string;
  /** "pipe" captures output (the default); "stream" sends the command's output to this
   * process's stderr as it runs, keeping stdout free for `--json`. */
  output?: "pipe" | "stream";
}

export type CommandRunner = (command: string, args: string[], opts: RunOptions) => CommandResult;

export const defaultCommandRunner: CommandRunner = (command, args, opts) => {
  const r = spawnSync(command, args, {
    cwd: opts.cwd,
    encoding: "utf8",
    // npm is npm.cmd on Windows, which spawnSync can only start through a shell.
    shell: process.platform === "win32",
    stdio: opts.output === "stream" ? ["ignore", 2, 2] : ["ignore", "pipe", "pipe"],
  });
  if (r.error) return { status: 1, stdout: "", stderr: r.error.message };
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

const here = dirname(fileURLToPath(import.meta.url));
/** The engine package root: this file is `src/init/install.ts` under tsx, `dist/init/install.js`
 * when built. */
export const ENGINE_DIR = join(here, "..", "..");

/** True when this process runs the engine from its TypeScript sources (tsx), so `dist` may be
 * missing or older than the code that's running. */
export function runningFromSource(): boolean {
  return import.meta.url.endsWith(".ts");
}

function fail(what: string, r: CommandResult): Error {
  const detail = (r.stderr || r.stdout).trim().split("\n").slice(-5).join("\n");
  return new Error(`${what} failed (exit ${r.status})${detail ? `:\n${detail}` : ""}`);
}

/** Makes sure the engine's `dist` exists and matches the running code: builds it when running
 * from source or when it's missing. The build is clean (`dist` and tsc's build info removed
 * first): the whole `dist` ships in the help app's tarball, and an incremental `tsc -b` leaves the
 * compiled output of deleted sources in place. Returns true when a build ran. */
export function ensureEngineBuilt(
  runner: CommandRunner = defaultCommandRunner,
  engineDir: string = ENGINE_DIR,
  fromSource: boolean = runningFromSource(),
): boolean {
  if (!fromSource && existsSync(join(engineDir, "dist", "index.js"))) return false;
  rmSync(join(engineDir, "dist"), { recursive: true, force: true });
  rmSync(join(engineDir, "tsconfig.tsbuildinfo"), { force: true });
  const r = runner("npm", ["run", "build"], { cwd: engineDir });
  if (r.status !== 0) throw fail("building the aida engine (npm run build)", r);
  if (!existsSync(join(engineDir, "dist", "index.js"))) {
    throw new Error(`building the aida engine left no ${join(engineDir, "dist", "index.js")}`);
  }
  return true;
}

/** The engine's npm dependencies that the help app's imports of aida (and the `aida` main
 * entry its config imports) actually load. Everything else in the engine's `dependencies` is
 * CLI-only and left out of the help app's install. */
export const HELP_APP_RUNTIME_DEPENDENCIES: readonly string[] = ["@anthropic-ai/sdk", "@modelcontextprotocol/sdk", "yaml", "zod"];

interface EnginePackageJson {
  name: string;
  version: string;
  description?: string;
  license?: string;
  type?: string;
  main?: string;
  types?: string;
  dependencies?: Record<string, string>;
}

/** The package.json of the help app's runtime build: the engine's, minus `bin`, scripts, dev
 * dependencies and every dependency the help app never loads. `aidaRuntime` lets `aida doctor`
 * tell it from an unrelated `aida` package. */
export function runtimePackageJson(engine: EnginePackageJson): Record<string, unknown> {
  const dependencies: Record<string, string> = {};
  for (const name of HELP_APP_RUNTIME_DEPENDENCIES) {
    const range = engine.dependencies?.[name];
    if (range) dependencies[name] = range;
  }
  return {
    name: engine.name,
    version: engine.version,
    description: "aida engine, help app runtime: the modules the help app loads. The CLI runs from aida itself.",
    ...(engine.license ? { license: engine.license } : {}),
    type: engine.type ?? "module",
    main: engine.main ?? "dist/index.js",
    types: engine.types ?? "dist/index.d.ts",
    files: ["dist", "schema"],
    aidaRuntime: true,
    dependencies,
  };
}

/** Copies what the runtime build ships (`dist/` without source maps, `schema/`, licence and
 * readme) from the engine into `stageDir` and writes its pruned package.json there. */
export function stageRuntimePackage(engineDir: string, stageDir: string): void {
  const engine = JSON.parse(readFileSync(join(engineDir, "package.json"), "utf8")) as EnginePackageJson;
  for (const dir of ["dist", "schema"]) {
    const from = join(engineDir, dir);
    if (!existsSync(from)) continue;
    cpSync(from, join(stageDir, dir), { recursive: true, filter: (src) => !src.endsWith(".map") && !src.endsWith(".tsbuildinfo") });
  }
  for (const file of ["README.md", "LICENSE"]) {
    if (existsSync(join(engineDir, file))) cpSync(join(engineDir, file), join(stageDir, file));
  }
  writeFileSync(join(stageDir, "package.json"), JSON.stringify(runtimePackageJson(engine), null, 2) + "\n", "utf8");
}

export interface PackResult {
  /** Absolute path to the tarball. */
  file: string;
  /** The help app's dependency spec, e.g. "file:vendor/aida-0.0.1-1a2b3c4d.tgz". */
  spec: string;
}

/** sha256 over the staged package: every file's POSIX path relative to `dir`, sorted, then its
 * bytes. Unlike the tarball's own bytes it doesn't depend on npm's or zlib's version, so the same
 * engine gets the same tarball name on every machine. */
export function hashStagedPackage(dir: string): string {
  const files: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  walk("");
  files.sort();
  const hash = createHash("sha256");
  for (const file of files) {
    const bytes = readFileSync(join(dir, file));
    hash.update(`${file}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

/** `npm pack`s the engine's help-app runtime build (see `stageRuntimePackage`) into
 * `<helpDir>/vendor/aida-<version>-<hash>.tgz`. npm packs into a temporary folder; the tarball
 * is checked there and only then copied into vendor/ (via a temporary name and a rename), so a
 * failed pack never leaves a partial tarball behind. Older tarballs stay until
 * `pruneOldTarballs`, which runs after package.json points at the new one. */
export function packEngine(helpDir: string, runner: CommandRunner = defaultCommandRunner, engineDir: string = ENGINE_DIR): PackResult {
  const vendor = join(helpDir, "vendor");
  const work = mkdtempSync(join(tmpdir(), "aida-pack-"));
  try {
    const stage = join(work, "stage");
    const out = join(work, "out");
    mkdirSync(stage);
    mkdirSync(out);
    stageRuntimePackage(engineDir, stage);
    const hash = hashStagedPackage(stage).slice(0, 10);
    const r = runner("npm", ["pack", "--json", "--pack-destination", out], { cwd: stage });
    if (r.status !== 0) throw fail("packing the aida engine (npm pack)", r);
    let reported: string | undefined;
    try {
      // npm may print lifecycle-script output before the JSON array.
      const json = r.stdout.slice(r.stdout.indexOf("["));
      reported = (JSON.parse(json) as Array<{ filename?: string }>)[0]?.filename;
    } catch {
      reported = undefined;
    }
    const tarballs = readdirSync(out).filter((name) => name.endsWith(".tgz"));
    const packedName = reported && tarballs.includes(reported) ? reported : tarballs.length === 1 ? tarballs[0] : undefined;
    if (!packedName) throw new Error(`npm pack left no single tarball in ${out}${reported ? ` (it reported ${reported})` : ""}`);
    const packed = join(out, packedName);
    const head = readFileSync(packed).subarray(0, 2);
    if (statSync(packed).size === 0 || head[0] !== 0x1f || head[1] !== 0x8b) {
      throw new Error(`npm pack wrote ${packedName}, which isn't a gzip tarball`);
    }

    const version = (JSON.parse(readFileSync(join(stage, "package.json"), "utf8")) as { version: string }).version;
    const filename = `aida-${version}-${hash}.tgz`;
    mkdirSync(vendor, { recursive: true });
    const file = join(vendor, filename);
    const partial = join(vendor, `.${filename}.partial`);
    try {
      copyFileSync(packed, partial);
      renameSync(partial, file);
    } finally {
      rmSync(partial, { force: true });
    }
    return { file, spec: `file:vendor/${filename}` };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Removes every `aida-*.tgz` in `<helpDir>/vendor` except `keep` (a file name or `file:` spec).
 * Run only once the help app's package.json points at `keep`. Returns the removed names. */
export function pruneOldTarballs(helpDir: string, keep: string): string[] {
  const vendor = join(helpDir, "vendor");
  const keepName = keep.replace(/^file:vendor\//, "");
  if (!existsSync(join(vendor, keepName))) throw new Error(`not pruning ${vendor}: ${keepName} isn't there`);
  const removed: string[] = [];
  for (const name of readdirSync(vendor)) {
    if (name !== keepName && /^aida-.*\.tgz$/.test(name)) {
      rmSync(join(vendor, name), { force: true });
      removed.push(name);
    }
  }
  return removed;
}

/** True when an npm dependency spec would be looked up on a registry by name (a semver range,
 * a dist-tag, `npm:` alias, or empty) rather than a local file, directory, git or URL. */
export function isRegistrySpec(spec: string): boolean {
  const s = spec.trim();
  if (/^(file|link|workspace|git|git\+[a-z]+|https?):/.test(s)) return false;
  if (/^[./~]/.test(s)) return false;
  if (/^[\w.-]+\/[\w.-]+(#.*)?$/.test(s)) return false; // GitHub shorthand: owner/repo
  return true;
}

const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

/** Points `<helpDir>/package.json`'s `aida` dependency at `spec`, leaving every other field
 * (and the file's indentation) as it was. A `aida` entry with a registry spec in any other
 * dependency field is removed. Returns true when the file changed. */
export function setAidaDependency(helpDir: string, spec: string): boolean {
  const file = join(helpDir, "package.json");
  const raw = readFileSync(file, "utf8");
  const pkg = JSON.parse(raw) as Record<string, Record<string, string> | unknown>;
  const indent = raw.match(/^[ \t]+(?=")/m)?.[0] ?? "  ";

  for (const field of DEP_FIELDS) {
    if (field === "dependencies") continue;
    const deps = pkg[field] as Record<string, string> | undefined;
    if (deps && typeof deps.aida === "string" && isRegistrySpec(deps.aida)) delete deps.aida;
  }
  const deps = (pkg.dependencies ??= {}) as Record<string, string>;
  deps.aida = spec;

  const next = JSON.stringify(pkg, null, indent) + "\n";
  if (next === raw) return false;
  writeFileSync(file, next, "utf8");
  return true;
}

/** `npm install` in the help app, with npm's output streamed to stderr. */
export function installDependencies(helpDir: string, runner: CommandRunner = defaultCommandRunner): void {
  const r = runner("npm", ["install"], { cwd: helpDir, output: "stream" });
  if (r.status !== 0) throw fail(`npm install in ${helpDir}`, r);
}
