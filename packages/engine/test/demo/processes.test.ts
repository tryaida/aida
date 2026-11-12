// The processes the demo starts: the sample app (a loopback port, a free port when the default is
// taken, stopped cleanly, gone when the process that started it is killed outright), the help
// site's next dev with the server it starts (stopped as a group, and gone too when the process
// that started it is killed outright), and next's telemetry leftover (that process only).
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { DEMO_APP_DIR, liveCount, startSampleApp, stopAll } from "../../src/demo/index.js";
import { firstFreePort, portFree, psArgsRunScript, runsScript, startHelpSite, stopTelemetryFlush } from "../../src/demo/site.js";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

/** A temp folder whose name doesn't start with "aida-" (a cleaner on the dev machine deletes those). */
function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `demo-${prefix}-`));
}

const blockers: Server[] = [];
afterEach(async () => {
  await stopAll();
  await Promise.all(blockers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

function block(port = 0): Promise<number> {
  const server = createServer();
  blockers.push(server);
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

// Node takes a second or two to start on a busy machine; each test starts up to three.
describe("startSampleApp", { timeout: 30_000 }, () => {
  it("starts on loopback, answers, and stops with nothing left running", async () => {
    const app = await startSampleApp({ appDir: DEMO_APP_DIR, port: 0 });
    expect(app.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await fetch(`${app.url}/jobs`)).status).toBe(200);
    expect(liveCount()).toBe(1);
    const pid = app.process.child.pid!;
    await app.process.stop();
    expect(alive(pid)).toBe(false);
    expect(liveCount()).toBe(0);
    expect(await portFree(app.port)).toBe(true);
  });

  it("moves to a free port when the default is taken, but not when the port was asked for", async () => {
    const taken = await block();
    const app = await startSampleApp({ appDir: DEMO_APP_DIR, port: taken });
    expect(app.port).not.toBe(taken);
    await app.process.stop();
    await expect(startSampleApp({ appDir: DEMO_APP_DIR, port: taken, explicitPort: true })).rejects.toThrow(`port ${taken} is in use`);
    expect(liveCount()).toBe(0);
  });

  it("stopAll stops every app still running", async () => {
    const a = await startSampleApp({ appDir: DEMO_APP_DIR, port: 0 });
    const b = await startSampleApp({ appDir: DEMO_APP_DIR, port: 0 });
    await stopAll();
    expect(a.process.running() || b.process.running()).toBe(false);
    expect(liveCount()).toBe(0);
  });

  it("the app stops by itself when the process that started it is killed outright", async () => {
    // A parent that starts the app the way the demo does, prints its pid, then waits.
    const script = `
      const { spawn } = require("node:child_process");
      const app = spawn(process.execPath, [${JSON.stringify(join(DEMO_APP_DIR, "server.mjs"))}, "--port", "0", "--exit-with-parent"], { stdio: ["pipe", "pipe", "inherit"] });
      app.stdout.on("data", (d) => { if (/running at/.test(String(d))) console.log("APP " + app.pid); });
      setInterval(() => {}, 1000);
    `;
    const parent = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    const appPid = await new Promise<number>((resolve, reject) => {
      let out = "";
      parent.stdout!.on("data", (d) => {
        out += String(d);
        const m = /APP (\d+)/.exec(out);
        if (m) resolve(Number(m[1]));
      });
      setTimeout(() => reject(new Error(`no app pid: ${out}`)), 15_000);
    });
    expect(alive(appPid)).toBe(true);
    parent.kill("SIGKILL");
    expect(await waitFor(() => !alive(appPid), 5000)).toBe(true);
  });

});

describe("stopTelemetryFlush", { timeout: 30_000 }, () => {
  it("matches node running exactly that script, nothing else", () => {
    const script = "/home/a b/help/node_modules/next/dist/telemetry/detached-flush.js";
    expect(runsScript(["/usr/bin/node", script, "dev", "/home/a b/help"], script)).toBe(true);
    expect(runsScript([process.execPath, script], script)).toBe(true);
    expect(runsScript(["tail", "-f", script], script)).toBe(false);
    expect(runsScript(["/usr/bin/vim", script], script)).toBe(false);
    expect(runsScript(["/usr/bin/node", "/x/other.js", script], script)).toBe(false);
    expect(runsScript(["/usr/bin/node", `${script}.bak`], script)).toBe(false);
    expect(psArgsRunScript(`/usr/local/bin/node ${script} dev /home/a b/help`, script, ["/usr/local/bin/node"])).toBe(true);
    expect(psArgsRunScript(`/usr/local/bin/node ${script}`, script, ["/usr/local/bin/node"])).toBe(true);
    expect(psArgsRunScript(`tail -f ${script}`, script, ["/usr/local/bin/node", "node"])).toBe(false);
    expect(psArgsRunScript(`/usr/local/bin/node ${script}.bak`, script, ["/usr/local/bin/node"])).toBe(false);
    expect(psArgsRunScript(`/usr/local/bin/node /x/other.js ${script}`, script, ["/usr/local/bin/node"])).toBe(false);
  });

  it("stops next's telemetry process in this help app, under a path with a space, and nothing else", async () => {
    const root = tempDir("flush test");
    const kids: ChildProcess[] = [];
    try {
      const help = join(root, "my help app");
      const dir = join(help, "node_modules", "next", "dist", "telemetry");
      mkdirSync(dir, { recursive: true });
      const script = join(dir, "detached-flush.js");
      writeFileSync(script, "setInterval(() => {}, 1000);\n");
      copyFileSync(script, `${script}.bak`);
      const other = join(root, "other.js");
      writeFileSync(other, "setInterval(() => {}, 1000);\n");
      const start = (cmd: string, args: string[]) => {
        const c = spawn(cmd, args, { stdio: "ignore" });
        kids.push(c);
        return c;
      };
      const flush = start(process.execPath, [script, "dev", help]);
      // The same path, but not node running it; node running it as a later argument; a file
      // whose path starts with the script's.
      const tail = start("tail", ["-f", script]);
      const nodeWithArg = start(process.execPath, [other, script]);
      const prefixed = start(process.execPath, [`${script}.bak`]);
      await new Promise((r) => setTimeout(r, 500));
      await stopTelemetryFlush(help);
      expect(await waitFor(() => !alive(flush.pid!), 5000)).toBe(true);
      for (const c of [tail, nodeWithArg, prefixed]) expect(alive(c.pid!), String(c.spawnargs)).toBe(true);
    } finally {
      for (const c of kids) c.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * A stand-in help app whose `next dev` starts a server child that ignores SIGTERM (next dev's
 * own server outlives its parent when only the parent is signalled), and records both pids.
 */
function fakeHelpApp(): { help: string; pids: () => { next?: number; server?: number } } {
  const help = tempDir("site-test");
  const bin = join(help, "node_modules", "next", "dist", "bin");
  mkdirSync(bin, { recursive: true });
  const record = join(help, "pids.json");
  writeFileSync(
    join(bin, "next"),
    `const { spawn } = require("node:child_process");
const port = Number(process.argv[process.argv.indexOf("-p") + 1]);
const server = spawn(process.execPath, ["-e", \`
  process.on("SIGTERM", () => {});
  require("node:http").createServer((q, s) => s.end("help")).listen(\${port}, "127.0.0.1");
\`], { stdio: "ignore" });
require("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({ next: process.pid, server: server.pid }));
setInterval(() => {}, 1000);
`,
  );
  return { help, pids: () => (existsSync(record) ? JSON.parse(readFileSync(record, "utf8")) : {}) };
}

describe("startHelpSite", { timeout: 60_000 }, () => {
  it("stops next dev and the server it started, even one that ignores SIGTERM", async () => {
    const { help, pids } = fakeHelpApp();
    try {
      const site = await startHelpSite({ helpDir: help, port: await firstFreePort(3400) });
      expect(await (await fetch(site.url)).text()).toBe("help");
      const { next, server } = pids();
      expect(alive(next!) && alive(server!)).toBe(true);
      await site.process.stop(1000);
      expect(await waitFor(() => !alive(next!) && !alive(server!), 5000)).toBe(true);
      expect(liveCount()).toBe(0);
    } finally {
      rmSync(help, { recursive: true, force: true });
    }
  });

  it("next dev and its server stop by themselves when the process that started them is killed outright", async () => {
    const { help, pids } = fakeHelpApp();
    let parent: ChildProcess | undefined;
    try {
      const port = await firstFreePort(3420);
      // A parent that starts the site the way the demo does, says so, then waits. Node with tsx's
      // loader, not the tsx command: that one runs the code in a child of its own, which a
      // SIGKILL of the command doesn't reach.
      const engine = join(import.meta.dirname, "..", "..");
      const site = join(engine, "src", "demo", "site.ts");
      const code = `import(${JSON.stringify(site)}).then(async (m) => { await m.startHelpSite({ helpDir: ${JSON.stringify(help)}, port: ${port} }); console.log("SITE UP"); setInterval(() => {}, 1000); });`;
      parent = spawn(process.execPath, ["--import", "tsx", "-e", code], { cwd: engine, stdio: ["ignore", "pipe", "inherit"] });
      const child = parent;
      await new Promise<void>((resolve, reject) => {
        let out = "";
        child.stdout!.on("data", (d) => {
          out += String(d);
          if (out.includes("SITE UP")) resolve();
        });
        setTimeout(() => reject(new Error(`the site didn't start: ${out}`)), 40_000);
      });
      const { next, server } = pids();
      expect(alive(next!) && alive(server!)).toBe(true);
      parent.kill("SIGKILL");
      // The watchdog sends SIGTERM, then SIGKILL after three seconds.
      expect(await waitFor(() => !alive(next!) && !alive(server!), 8000)).toBe(true);
      expect(await portFree(port)).toBe(true);
    } finally {
      for (const pid of Object.values(pids())) if (pid && alive(pid)) process.kill(pid, "SIGKILL");
      if (parent && parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
      rmSync(help, { recursive: true, force: true });
    }
  });
});
