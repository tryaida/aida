// A `CommandRunner` for init tests: records every npm call and fakes `npm pack` by writing a
// tarball-named file, so tests never really build, pack or install. `engineDir` is a stand-in
// engine (package.json + dist/index.js) inside the test's own temp dir.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { CommandRunner, RunOptions } from "../../src/init/install.js";

export interface FakeRunner {
  run: CommandRunner;
  calls: Array<{ command: string; args: string[]; opts: RunOptions }>;
  engineDir: string;
  /** The package.json `npm pack` saw, read from its working directory. */
  packed?: Record<string, unknown>;
}

/** `content` is the fake tarball's (gzipped) payload; `badTarball` makes `npm pack` succeed but
 * leave a partial, non-gzip file behind. */
export function fakeRunner(root: string, opts: { version?: string; content?: string; failOn?: string; badTarball?: boolean; emptyBuild?: boolean } = {}): FakeRunner {
  const version = opts.version ?? "0.0.1";
  const engineDir = join(root, ".fake-engine");
  mkdirSync(join(engineDir, "dist"), { recursive: true });
  writeFileSync(
    join(engineDir, "package.json"),
    JSON.stringify({
      name: "aida-docs",
      version,
      description: "AIDA engine",
      bin: { aida: "dist/cli.js" },
      scripts: { build: "tsc -b" },
      dependencies: { yaml: "^2.6.1", zod: "^3.24.1", playwright: "^1.49.1", "kokoro-js": "^1.2.0" },
      devDependencies: { typescript: "^5.7.3" },
      // typescript is optional and only needed by `aida import playwright` — the help app's
      // lean runtime install must never see it (runtimePackageJson drops it).
      peerDependencies: { typescript: "^5.7.3" },
      peerDependenciesMeta: { typescript: { optional: true } },
    }),
  );
  const writeDist = () => {
    mkdirSync(join(engineDir, "dist"), { recursive: true });
    writeFileSync(join(engineDir, "dist", "index.js"), "export {};\n");
  };
  writeDist();

  const calls: FakeRunner["calls"] = [];
  const fake: FakeRunner = { run: () => ({ status: 0, stdout: "", stderr: "" }), calls, engineDir };
  const run: CommandRunner = (command, args, runOpts) => {
    calls.push({ command, args, opts: runOpts });
    if (args[0] === "pack" && (opts.failOn === "pack" || opts.badTarball)) {
      // A failed or interrupted pack can leave a partial file in its destination.
      const dest = args[args.indexOf("--pack-destination") + 1];
      writeFileSync(join(dest, `aida-docs-${version}.tgz`), "partial");
      if (opts.failOn) return { status: 1, stdout: "", stderr: "npm pack broke" };
      return { status: 0, stdout: JSON.stringify([{ filename: `aida-docs-${version}.tgz` }]), stderr: "" };
    }
    if (opts.failOn && args[0] === opts.failOn) return { status: 1, stdout: "", stderr: `npm ${args[0]} broke` };
    // `npm run build` in the engine: a clean build writes dist/ again (unless emptyBuild).
    if (args[0] === "run" && args[1] === "build" && runOpts.cwd === engineDir && !opts.emptyBuild) writeDist();
    if (args[0] === "pack") {
      fake.packed = JSON.parse(readFileSync(join(runOpts.cwd, "package.json"), "utf8")) as Record<string, unknown>;
      const dest = args[args.indexOf("--pack-destination") + 1];
      const filename = `aida-docs-${version}.tgz`;
      writeFileSync(join(dest, filename), gzipSync(opts.content ?? "fake tarball"));
      return { status: 0, stdout: JSON.stringify([{ filename }]), stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  fake.run = run;
  return fake;
}

/** `runInitCommand` options that keep a test off the real npm. */
export function fakeInstall(root: string): { runner: CommandRunner; engineDir: string } {
  const f = fakeRunner(root);
  return { runner: f.run, engineDir: f.engineDir };
}
