// A tiny static-file server for inspect's own fixtures (test/inspect/fixture/*.html), on an
// ephemeral port — the same shape as test/capture/fixture-server.ts (not imported from there:
// capture's test dir is owned by another concurrent change, so this is a small, independent
// copy rather than a cross-directory dependency).
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(here, "fixture");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
};

export interface FixtureServer {
  url: string;
  /** Count of requests this server received with a non-GET method — used to prove `aida
   * inspect`'s network-level block (commands/inspect.ts) kept a write from ever leaving the
   * browser: this stays 0 even when a fixture page's click handler fires a `fetch(..., {method:
   * "POST"})`. */
  readonly postCount: number;
  close(): Promise<void>;
}

/** Serves `test/inspect/fixture/*.html` from a plain node:http server, on an ephemeral port. Any
 * non-GET request is counted (see `postCount`) and answered directly, never touching the
 * filesystem — a real app endpoint stands in for here. */
export function startFixtureServer(): Promise<FixtureServer> {
  return new Promise((resolve, reject) => {
    const state = { postCount: 0 };
    const server: Server = createServer((req, res) => {
      if (req.method && req.method !== "GET") {
        state.postCount += 1;
        res.writeHead(201, { "content-type": "text/plain" });
        res.end("ok");
        return;
      }
      const path = req.url === "/" ? "/index.html" : (req.url ?? "/index.html");
      const ext = path.slice(path.lastIndexOf("."));
      readFile(join(FIXTURE_DIR, path))
        .then((body) => {
          res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
          res.end(body);
        })
        .catch(() => {
          res.writeHead(404);
          res.end("not found");
        });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        get postCount() {
          return state.postCount;
        },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
