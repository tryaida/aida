// `aida demo --site`: starts the help app's own dev server (`next dev`, loopback only, as its
// `npm run dev` does) once its packages are installed, and waits until it answers. Next.js is
// started directly rather than through npm, in a process group of its own: `next dev` starts its
// server as a child process, and signalling the group reaches that one too. A watchdog stops the
// group if this process dies without stopping it.
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { manage, type ManagedProcess } from "./processes.js";

export interface HelpSite {
  url: string;
  port: number;
  process: ManagedProcess;
}

/** True when nothing listens on `port` at `host`. */
export function portFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

/** The first free port from `start`, trying `tries` ports. */
export async function firstFreePort(start: number, tries = 20, host = "127.0.0.1"): Promise<number> {
  for (let port = start; port < start + tries; port++) if (await portFree(port, host)) return port;
  throw new Error(`no free port between ${start} and ${start + tries - 1}`);
}

/**
 * True when `argv` (a process's command line, split as exec got it) is Node running exactly
 * `script`: the executable is node (by name, or this very Node) and its first argument is the
 * script's full path. Anything else (an editor or `tail -f` on the file, a node with the path
 * further along its arguments) never matches.
 */
export function runsScript(argv: string[], script: string, node: string = process.execPath): boolean {
  if (argv.length < 2 || argv[1] !== script) return false;
  return argv[0] === node || /^node(\.exe)?$/i.test(basename(argv[0]));
}

/** Linux: every process of this user whose `/proc/<pid>/cmdline` runs `script`. */
function linuxPidsRunning(script: string): number[] {
  const uid = process.getuid?.();
  const pids: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      if (uid !== undefined && statSync(`/proc/${entry}`).uid !== uid) continue;
      // NUL-separated, so a path with spaces stays one argument.
      const argv = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
      if (argv[argv.length - 1] === "") argv.pop();
      if (runsScript(argv, script)) pids.push(Number(entry));
    } catch {
      // gone, or not ours to read
    }
  }
  return pids;
}

/** True when `args` (`ps -o args=`, spaces between arguments) is `node` running `script`. The
 * joined form can't be split back, so it's compared whole: executable, space, script, then the
 * end or a space. */
export function psArgsRunScript(args: string, script: string, nodes: string[]): boolean {
  const line = args.trim();
  return nodes.some((node) => line === `${node} ${script}` || line.startsWith(`${node} ${script} `));
}

const execFileAsync = promisify(execFile);

/** macOS (and other Unixes without /proc): this user's node processes from `ps`, then each one's
 * arguments, matched exactly. */
async function psPidsRunning(script: string): Promise<number[]> {
  const uid = process.getuid?.();
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,uid=,comm="], { timeout: 5000 });
  const pids: number[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!m || Number(m[1]) === process.pid || (uid !== undefined && Number(m[2]) !== uid)) continue;
    const comm = m[3].trim();
    if (comm !== process.execPath && !/^node$/i.test(basename(comm))) continue;
    try {
      const { stdout: args } = await execFileAsync("ps", ["-o", "args=", "-p", m[1]], { timeout: 5000 });
      if (psArgsRunScript(args, script, [process.execPath, comm, "node"])) pids.push(Number(m[1]));
    } catch {
      // gone
    }
  }
  return pids;
}

/**
 * On the way out `next dev` starts a detached process to send its telemetry, even with
 * NEXT_TELEMETRY_DISABLED, and that one loads the help app's next.config, whose MDX plugin starts
 * file watchers in dev, so it never exits. The demo started its parent: stop it too. Only this
 * user's node processes whose first argument is exactly that script inside this help app are
 * signalled; nothing else ever is.
 */
export async function stopTelemetryFlush(helpDir: string): Promise<void> {
  const script = join(helpDir, "node_modules", "next", "dist", "telemetry", "detached-flush.js");
  if (process.platform === "win32") return;
  let pids: number[] = [];
  try {
    pids = process.platform === "linux" && existsSync("/proc/self/cmdline") ? linuxPidsRunning(script) : await psPidsRunning(script);
  } catch {
    return;
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

/**
 * The watchdog for a process group (the help site): a small Node process that reads its stdin
 * from this one, and when that closes (this process died, however it died) stops the group:
 * SIGTERM, then SIGKILL after `graceMs`. It also exits once the group is gone. It isn't in the
 * group itself, so the group's SIGKILL can't take it first.
 */
const WATCHDOG = `
const pgid = Number(process.argv[1]);
const grace = Number(process.argv[2]);
const alive = () => { try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const signal = (s) => { try { process.kill(-pgid, s); } catch {} };
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  signal("SIGTERM");
  setTimeout(() => { signal("SIGKILL"); process.exit(0); }, grace);
};
process.stdin.on("end", stop);
process.stdin.on("error", stop);
process.stdin.resume();
setInterval(() => { if (!alive()) process.exit(0); }, 1000);
`;

export function watchGroup(pgid: number, graceMs = 3000): ManagedProcess {
  const child = spawn(process.execPath, ["-e", WATCHDOG, String(pgid), String(graceMs)], { stdio: ["pipe", "ignore", "ignore"] });
  return manage("help site watchdog", child);
}

export async function startHelpSite(opts: { helpDir: string; port?: number; log?: (line: string) => void; timeoutMs?: number }): Promise<HelpSite> {
  const next = join(opts.helpDir, "node_modules", "next", "dist", "bin", "next");
  if (!existsSync(next)) throw new Error(`the help app's packages aren't installed (no ${next})`);
  const port = opts.port ?? (await firstFreePort(3000));
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [next, "dev", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: opts.helpDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    // Its own process group, so a stop reaches next dev's server child as well.
    detached: process.platform !== "win32",
  });
  const watchdog = child.pid && process.platform !== "win32" ? watchGroup(child.pid) : undefined;
  const managed = manage("help site", child, {
    group: true,
    afterStop: async () => {
      await watchdog?.stop();
      await stopTelemetryFlush(opts.helpDir);
    },
  });
  let output = "";
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString("utf8")).slice(-4000);
  };
  child.stdout!.on("data", keep);
  child.stderr!.on("data", keep);

  // The first request compiles the page, which is most of the wait.
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const started = Date.now();
  let lastNote = started;
  while (Date.now() - started < timeoutMs) {
    if (!managed.running()) {
      // Its group and watchdog may outlive it.
      await managed.stop();
      throw new Error(`next dev stopped: ${output.trim().split("\n").slice(-3).join(" / ") || "no output"}`);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      await res.body?.cancel();
      if (res.status < 500) return { url, port, process: managed };
    } catch {
      // not answering yet
    }
    if (Date.now() - lastNote >= 15_000) {
      lastNote = Date.now();
      opts.log?.(`  still starting the help site (${Math.round((Date.now() - started) / 1000)} s)`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  await managed.stop();
  throw new Error(`the help site didn't answer at ${url} within ${Math.round(timeoutMs / 1000)} s`);
}
