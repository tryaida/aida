import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(here, "fixture");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
};

export interface FixtureServer {
  url: string;
  close(): Promise<void>;
}

/** Serves `test/capture/fixture/*.html` from a plain node:http server, on an ephemeral port.
 * `handle`, when given, sees each request first and returns true when it answered it (an API). */
export function startFixtureServer(handle?: (req: IncomingMessage, res: ServerResponse) => boolean): Promise<FixtureServer> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      if (handle?.(req, res)) return;
      const url = (req.url ?? "/").split("?")[0];
      const path = url === "/" ? "/index.html" : url;
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
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
