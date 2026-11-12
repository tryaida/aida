#!/usr/bin/env node
// Acme Repairs: a small fictional repair-shop app that `aida demo` captures. One Node server with
// no dependencies, no database and no sign-in: its data lives in memory and starts from the same
// seed every time (lib/store.mjs). It only ever listens on this machine.
//
//   node server.mjs                 http://127.0.0.1:4310
//   node server.mjs --port 4400     another port (0 picks a free one)
//
// Settings > Sample data (POST /settings/sample-data) puts the seed back without a restart.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createStore } from "./lib/store.mjs";
import { jobPage, jobsPage, newJobPage, notFoundPage, settingsPage } from "./lib/pages.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PORT = 4310;
const MAX_BODY_BYTES = 64 * 1024;
/** After a body has gone over the limit, how much more is read (and dropped) so the 413 reaches
 * the client before the connection closes; past this the connection is cut. */
const MAX_DISCARD_BYTES = 1024 * 1024;

const STATIC_FILES = {
  "/styles.css": ["src/styles.css", "text/css; charset=utf-8"],
  "/app.js": ["public/app.js", "text/javascript; charset=utf-8"],
  "/icon.svg": ["public/icon.svg", "image/svg+xml"],
  "/favicon.ico": ["public/icon.svg", "image/svg+xml"],
  "/logo.svg": ["public/logo.svg", "image/svg+xml"],
  "/logo-white.svg": ["public/logo-white.svg", "image/svg+xml"],
  "/manifest.json": ["public/manifest.json", "application/manifest+json"],
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** True for an address on this machine (IPv4, IPv6 and IPv4-mapped IPv6 loopback). */
export function isLoopbackAddress(address) {
  if (!address) return false;
  return address === "::1" || /^(::ffff:)?127\./.test(address);
}

/** The Host header names this machine. A page served to another name (DNS rebinding) is refused. */
function hostIsLocal(hostHeader) {
  if (!hostHeader) return false;
  const host = hostHeader.startsWith("[") ? hostHeader.slice(1, hostHeader.indexOf("]")) : hostHeader.split(":")[0];
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

function send(res, status, body, type = "text/html; charset=utf-8", extra = {}) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(303, { location, "cache-control": "no-store" });
  res.end();
}

/** The 413 answer; the connection closes once it's sent. */
const tooLarge = () => Object.assign(new Error("That form is too large."), { status: 413, close: true });

/**
 * The form body, at most MAX_BODY_BYTES. A larger one is refused with 413: what's past the limit
 * is read and dropped (not kept) until the client has sent it all, then the answer goes out and
 * the connection closes. Answering while the client is still sending would close the socket on
 * unread data, and the reset that causes can lose the answer on the way.
 */
function readForm(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (over) {
        if (size > MAX_BODY_BYTES + MAX_DISCARD_BYTES) {
          req.removeAllListeners("data");
          reject(tooLarge());
        }
        return;
      }
      if (size > MAX_BODY_BYTES) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => (over ? reject(tooLarge()) : resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))))));
    req.on("error", reject);
  });
}

/**
 * True when a form post comes from one of this app's own pages: its Origin (or, without one, its
 * Referer) is this app's address. Every browser sends Origin on a form post, so a post from
 * another site (cross-site request forgery: a page elsewhere posting to 127.0.0.1) is refused,
 * and so is one with neither header.
 */
export function sameOrigin(headers) {
  const own = `http://${headers.host}`.toLowerCase();
  const origin = headers.origin;
  if (origin !== undefined) return origin.toLowerCase() === own;
  try {
    return new URL(headers.referer ?? "").origin.toLowerCase() === own;
  } catch {
    return false;
  }
}

/** The app's request handler and its store (tests drive both directly). */
export function createApp() {
  const store = createStore();

  async function handle(req, res) {
    if (!hostIsLocal(req.headers.host)) return send(res, 403, "This app only answers on this machine (127.0.0.1 or localhost).", "text/plain; charset=utf-8");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    if (method === "GET" && STATIC_FILES[path]) {
      const [file, type] = STATIC_FILES[path];
      return send(res, 200, readFileSync(join(here, file)), type);
    }
    if (method === "GET" && path === "/") return redirect(res, "/jobs");
    if (method === "POST" && !sameOrigin(req.headers)) {
      return send(res, 403, "This form can only be sent from Acme Repairs' own pages.", "text/plain; charset=utf-8");
    }

    if (path === "/jobs" && method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const status = url.searchParams.get("status") ?? "";
      return send(res, 200, jobsPage({ jobs: store.listJobs({ q, status }), counts: store.counts(), q, status }));
    }
    if (path === "/jobs/new" && method === "GET") {
      return send(res, 200, newJobPage({ settings: store.getSettings() }));
    }
    if (path === "/jobs" && method === "POST") {
      const result = store.createJob(await readForm(req));
      if (result.errors) return send(res, 422, newJobPage({ values: result.values, errors: result.errors, settings: store.getSettings() }));
      return redirect(res, `/jobs/${result.job.id}?done=created`);
    }
    const jobMatch = /^\/jobs\/(J-\d+)(\/status)?$/.exec(path);
    if (jobMatch) {
      const job = store.getJob(jobMatch[1]);
      if (!job) return send(res, 404, notFoundPage());
      if (!jobMatch[2] && method === "GET") {
        return send(res, 200, jobPage({ job, done: url.searchParams.get("done") ?? "", settings: store.getSettings() }));
      }
      if (jobMatch[2] && method === "POST") {
        const form = await readForm(req);
        const moved = store.advance(job.id, form.status, form.note);
        return redirect(res, moved ? `/jobs/${job.id}?done=${encodeURIComponent(moved.status)}` : `/jobs/${job.id}`);
      }
    }
    if (path === "/settings" && method === "GET") {
      return send(res, 200, settingsPage({ values: store.getSettings(), done: url.searchParams.get("done") ?? "" }));
    }
    if (path === "/settings" && method === "POST") {
      const result = store.saveSettings(await readForm(req));
      if (result.errors) return send(res, 422, settingsPage({ values: result.values, errors: result.errors }));
      return redirect(res, "/settings?done=settings");
    }
    if (path === "/settings/sample-data" && method === "POST") {
      // The server only listens on loopback; checked again here because this wipes every change.
      if (!isLoopbackAddress(req.socket.remoteAddress)) return send(res, 403, "Only from this machine.", "text/plain; charset=utf-8");
      store.reset();
      return redirect(res, "/settings?done=sample-data");
    }
    return send(res, 404, notFoundPage());
  }

  const handler = (req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) send(res, err.status ?? 500, err.status ? err.message : "Something went wrong.", "text/plain; charset=utf-8", err.close ? { connection: "close" } : {});
      else res.destroy();
    });
  };
  return { handler, store };
}

/**
 * Starts the app on `host` (a loopback address only) and `port` (0 picks a free one). Resolves
 * once it's listening, with its address and a `close()` that stops it.
 */
export function startServer({ port = DEFAULT_PORT, host = "127.0.0.1" } = {}) {
  if (!LOOPBACK_HOSTS.has(host)) return Promise.reject(new Error(`Acme Repairs only listens on this machine; ${host} isn't a loopback address`));
  const { handler, store } = createApp();
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      const shown = address.family === "IPv6" ? `[${address.address}]` : address.address;
      resolve({
        server,
        store,
        port: address.port,
        url: `http://${shown}:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())).then(() => server.closeAllConnections?.()),
      });
    });
  });
}

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(args) {
  const raw = argValue(args, "--port") ?? process.env.PORT ?? String(DEFAULT_PORT);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`--port must be a port number (0 to 65535), not "${raw}"`);
    process.exit(2);
  }
  let app;
  try {
    app = await startServer({ port });
  } catch (err) {
    console.error(err.code === "EADDRINUSE" ? `Port ${port} is in use. Try another: node server.mjs --port 4311` : err.message);
    process.exit(err.code === "EADDRINUSE" ? 3 : 1);
  }
  console.log(`Acme Repairs is running at ${app.url}`);
  console.log("Press Ctrl-C to stop it.");
  const stop = () => app.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // Started by `aida demo`: stop when it goes away, even if it was killed without a chance to
  // stop us (its end of stdin closes).
  if (args.includes("--exit-with-parent")) {
    process.stdin.on("end", stop);
    process.stdin.on("error", stop);
    process.stdin.resume();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
