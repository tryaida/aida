// The processes `aida demo` starts (the sample app, and with `--site` the help site's dev server)
// and how they're stopped. Every one is tracked from the moment it's spawned until it has exited,
// so a failure, Ctrl-C or a plain exit never leaves one behind: `stopAll()` stops them in order,
// and an exit hook kills any still running if the process ends without calling it.
//
// The sample app stays in this process's group, so Ctrl-C in a terminal reaches it directly too,
// and it watches its stdin (`--exit-with-parent`) to stop when this process goes away without a
// chance to stop it. The help site's `next dev` starts a server process of its own, so it runs in
// a process group of its own (`group`), every signal goes to the whole group, and a watchdog
// stops the group when this process dies (site.ts).
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

export interface ManagedProcess {
  readonly name: string;
  readonly child: ChildProcess;
  /** Resolves with the exit code (or signal name) once the process has exited. */
  readonly exited: Promise<number | string>;
  /** SIGTERM, then SIGKILL if it hasn't exited within `graceMs`. Safe to call more than once. */
  stop(graceMs?: number): Promise<void>;
  running(): boolean;
}

const live = new Set<ManagedProcess>();
/** Managed processes that lead a process group of their own. */
const groups = new WeakSet<ManagedProcess>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Last resort, synchronous: `exit` handlers can't wait for anything.
  process.on("exit", () => {
    for (const p of live) signalChild(p.child, "SIGKILL", groups.has(p));
  });
}

/** Sends `signal` to `child`, or to its whole process group when it leads one. Never throws. */
function signalChild(child: ChildProcess, signal: NodeJS.Signals, group: boolean): void {
  try {
    if (group && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // already gone
  }
}

/** True while any process is left in the group `pgid` leads. */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Tracks `child` until it exits. `afterStop` runs once `stop()` has seen it exit. `group`: the
 * child was spawned `detached` and leads its own process group; signals go to the group, and
 * `stop()` also waits for (then SIGKILLs) what's left of the group after the child itself exits.
 */
export function manage(name: string, child: ChildProcess, opts: { afterStop?: () => Promise<void> | void; group?: boolean } = {}): ManagedProcess {
  installExitHook();
  const group = Boolean(opts.group && child.pid && process.platform !== "win32");
  let done = false;
  const exited = new Promise<number | string>((resolve) => {
    const finish = (code: number | string) => {
      if (done) return;
      done = true;
      live.delete(managed);
      resolve(code);
    };
    child.once("exit", (code, signal) => finish(code ?? signal ?? "unknown"));
    child.once("error", () => finish("error"));
  });
  let stopping: Promise<void> | undefined;
  const managed: ManagedProcess = {
    name,
    child,
    exited,
    running: () => !done,
    stop(graceMs = 3000) {
      stopping ??= (async () => {
        const deadline = Date.now() + graceMs;
        if (!done) {
          child.stdin?.end();
          signalChild(child, "SIGTERM", group);
          const timer = setTimeout(() => {
            if (!done) signalChild(child, "SIGKILL", group);
          }, graceMs);
          await exited;
          clearTimeout(timer);
        }
        // The leader is gone; a child of its own (next dev's server) may not be.
        if (group) {
          while (groupAlive(child.pid!) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
          signalChild(child, "SIGKILL", true);
        }
        await opts.afterStop?.();
      })();
      return stopping;
    },
  };
  if (group) groups.add(managed);
  live.add(managed);
  if (child.exitCode !== null || child.signalCode !== null) {
    done = true;
    live.delete(managed);
  }
  return managed;
}

/** Stops every process still running, newest first. */
export async function stopAll(): Promise<void> {
  for (const p of [...live].reverse()) await p.stop();
}

/** How many tracked processes are still running (tests). */
export function liveCount(): number {
  return live.size;
}

export interface SampleApp {
  url: string;
  port: number;
  process: ManagedProcess;
}

export class SampleAppError extends Error {
  constructor(
    message: string,
    readonly portInUse = false,
  ) {
    super(message);
    this.name = "SampleAppError";
  }
}

const READY = /running at (http:\/\/\S+)/;

function startOnce(appDir: string, port: number, timeoutMs: number): Promise<SampleApp> {
  const child = spawn(process.execPath, [join(appDir, "server.mjs"), "--port", String(port), "--exit-with-parent"], {
    cwd: appDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PORT: undefined },
  });
  const managed = manage("sample app", child);
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    const fail = (error: SampleAppError) => {
      clearTimeout(timer);
      void managed.stop().then(() => reject(error));
    };
    const timer = setTimeout(() => fail(new SampleAppError(`the sample app didn't start within ${Math.round(timeoutMs / 1000)} s${err ? `: ${err.trim().split("\n")[0]}` : ""}`)), timeoutMs);
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      out += chunk;
      const m = READY.exec(out);
      if (m) {
        clearTimeout(timer);
        const url = m[1];
        resolve({ url, port: Number(new URL(url).port), process: managed });
      }
    });
    child.stderr!.on("data", (chunk: string) => {
      err += chunk;
    });
    void managed.exited.then((code) => {
      if (READY.test(out)) return;
      clearTimeout(timer);
      // server.mjs exits with 3 when the port is taken.
      reject(new SampleAppError(err.trim().split("\n")[0] || `the sample app stopped before it started (exit ${code})`, code === 3));
    });
  });
}

/**
 * Starts the sample app (`<appDir>/server.mjs`) on 127.0.0.1. When `port` is taken and wasn't
 * asked for explicitly, it starts on a free port instead.
 */
export async function startSampleApp(opts: { appDir: string; port: number; explicitPort?: boolean; timeoutMs?: number }): Promise<SampleApp> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  try {
    return await startOnce(opts.appDir, opts.port, timeoutMs);
  } catch (err) {
    if (err instanceof SampleAppError && err.portInUse && !opts.explicitPort) return startOnce(opts.appDir, 0, timeoutMs);
    if (err instanceof SampleAppError && err.portInUse) throw new SampleAppError(`port ${opts.port} is in use; pick another with --port <port>`, true);
    throw err;
  }
}
