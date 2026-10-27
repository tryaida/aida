// M28 review fixes for `aida inspect`: `--after` waits for a save's writes to finish before the
// scan blocks writes (a follow-up request isn't cut off, the scan shows the saved screen), and the
// write block covers popups and WebSocket sends, not only the page's own requests. Uses the
// capture fixture server (test/capture/fixture) with a handler standing in for the app's API.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInspectCommand } from "../../src/commands/inspect.js";
import { resetAppDatabaseWarnings } from "../../src/safety/index.js";
import { startFixtureServer, type FixtureServer } from "../capture/fixture-server.js";

const TIMEOUT = 60_000;
const dirs: string[] = [];
let server: FixtureServer;
let posts: string[];
let out: string[];

function handle(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === "GET") return false;
  const path = (req.url ?? "/").split("?")[0];
  posts.push(path);
  // The first save is slow; its follow-up (`/api/audit`) only goes once it answers.
  setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end("{}"), path === "/api/registrations" ? 3_000 : 0);
  return true;
}

beforeEach(async () => {
  posts = [];
  out = [];
  server = await startFixtureServer(handle);
  vi.spyOn(console, "log").mockImplementation((m: string) => void out.push(m));
  vi.spyOn(console, "error").mockImplementation(() => {});
}, TIMEOUT);

afterEach(async () => {
  vi.restoreAllMocks();
  resetAppDatabaseWarnings();
  await server.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
}, TIMEOUT);

function project(wsUrl = "ws://127.0.0.1:9/none"): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-inspect-write-block-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "aida.config.mjs"),
    `export default { app: { baseUrl: ${JSON.stringify(server.url)} }, walkthroughsDir: "./walkthroughs", buildDir: "./.build" };\n`,
  );
  mkdirSync(join(dir, "walkthroughs"));
  writeFileSync(
    join(dir, "walkthroughs", "register.yaml"),
    `walkthrough: register
title: Register someone
start:
  page: /save-chain.html
steps:
  - id: save
    actions:
      - do: click
        target:
          role: button
          name: Save
          exact: true
`,
  );
  // Opens a WebSocket and POSTs on load; its save writes over both.
  writeFileSync(
    join(dir, "walkthroughs", "live.yaml"),
    `walkthrough: live
title: Save with a live connection
start:
  page: /write-on-load.html?ws=${encodeURIComponent(wsUrl)}
steps:
  - id: save
    actions:
      - do: click
        target:
          role: button
          name: Save
          exact: true
      - do: waitFor
        target:
          text: Registration saved
`,
  );
  return join(dir, "aida.config.mjs");
}

const payload = (): Record<string, unknown> => JSON.parse(out[out.length - 1]);

/** A bare WebSocket endpoint that counts the text frames it receives. */
function startWsServer(): Promise<{ url: string; upgrades: () => number; textFrames: () => number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  let upgrades = 0;
  let textFrames = 0;
  const ws: Server = createServer();
  ws.on("upgrade", (req, socket: Socket) => {
    upgrades += 1;
    sockets.add(socket);
    const accept = createHash("sha1")
      .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("data", (buf: Buffer) => {
      if ((buf[0] & 0x0f) === 1) textFrames += 1;
    });
    socket.on("error", () => {});
  });
  return new Promise((resolve) => {
    ws.listen(0, "127.0.0.1", () => {
      const address = ws.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `ws://127.0.0.1:${port}/live`,
        upgrades: () => upgrades,
        textFrames: () => textFrames,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            ws.close(() => r());
          }),
      });
    });
  });
}

describe("inspect --after waits for the save to finish", () => {
  it(
    "lets a slow save's follow-up write through, and scans the saved screen",
    async () => {
      const code = await runInspectCommand({ configPath: project(), walkthrough: "register", after: "save" }, true);
      expect(code).toBe(0);
      expect(posts).toEqual(["/api/registrations", "/api/audit"]);
      expect(payload().snapshot).toContain("Registration saved");
    },
    TIMEOUT,
  );
});

describe("inspect's write block", () => {
  it(
    "blocks a popup's writes",
    async () => {
      const code = await runInspectCommand({ configPath: project(), path: "/popup-ws.html", click: "Open preview" }, true);
      expect(code).toBe(0);
      expect(posts).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "drops what the page sends over a WebSocket",
    async () => {
      const ws = await startWsServer();
      try {
        const path = `/popup-ws.html?ws=${encodeURIComponent(ws.url)}`;
        const code = await runInspectCommand({ configPath: project(), path, click: "Go live" }, true);
        expect(code).toBe(0);
        // The page thinks it sent; the server got the connection but no message.
        expect(payload().snapshot).toContain("sent");
        expect(ws.upgrades()).toBe(1);
        expect(ws.textFrames()).toBe(0);
      } finally {
        await ws.close();
      }
    },
    TIMEOUT,
  );
});

// Security review: the gate goes on when the browser context is created, before any page loads,
// so a page's own load can't write and a socket opened early is still routed (commands/inspect.ts).
describe("inspect's write block, from the first request", () => {
  it(
    "blocks a POST the page fires on load",
    async () => {
      const code = await runInspectCommand({ configPath: project(), path: "/write-on-load.html" }, true);
      expect(code).toBe(0);
      expect(posts).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "drops what a WebSocket opened on load sends after a --click",
    async () => {
      const ws = await startWsServer();
      try {
        const path = `/write-on-load.html?ws=${encodeURIComponent(ws.url)}`;
        const code = await runInspectCommand({ configPath: project(), path, click: "Open live panel" }, true);
        expect(code).toBe(0);
        expect(payload().snapshot).toContain("panel sent");
        expect(ws.upgrades()).toBe(1);
        expect(ws.textFrames()).toBe(0);
        expect(posts).toEqual([]);
      } finally {
        await ws.close();
      }
    },
    TIMEOUT,
  );

  it(
    "lets --after's replay save (POST and socket), then blocks that socket for the --click after it",
    async () => {
      const ws = await startWsServer();
      try {
        const code = await runInspectCommand({ configPath: project(ws.url), walkthrough: "live", after: "save", click: "Open live panel" }, true);
        expect(code).toBe(0);
        const snapshot = payload().snapshot as string;
        expect(snapshot).toContain("Registration saved");
        expect(snapshot).toContain("panel sent");
        // The replay's writes went through: the load-time POST, the save, and its socket message.
        expect(posts).toEqual(["/api/on-load", "/api/save"]);
        expect(ws.upgrades()).toBe(1);
        // Only the replay's "save registration"; the scan's "open panel" was dropped.
        expect(ws.textFrames()).toBe(1);
      } finally {
        await ws.close();
      }
    },
    TIMEOUT,
  );
});

// Security review: what inspect prints never carries a typed secret or a URL's token.
describe("inspect redaction", () => {
  it(
    "masks secret field values and card numbers, and strips the page URL's query and fragment",
    async () => {
      const path = "/secret-fields.html?invite=abc#access_token=Zx9kQ2mT7vB4nR8pL3wY";
      const code = await runInspectCommand({ configPath: project(), path }, true);
      expect(code).toBe(0);
      const p = payload() as { url: string; snapshot: string };
      expect(p.url).toBe(`${server.url}/secret-fields.html`);
      for (const secret of ["Tr0ub4dor", "4821", "plain-looking-value", "4111 1111 1111 1111", "5555555555554444", "token=", "eyJhbGciOiJIUzI1NiJ9"]) {
        expect(p.snapshot).not.toContain(secret);
      }
      expect(p.snapshot).toMatch(/textbox "Login code".*: \[redacted\]/);
      expect(p.snapshot).toContain("Bring a hat");
    },
    TIMEOUT,
  );
});
