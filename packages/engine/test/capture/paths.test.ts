// M33: capture runs every walkthrough path from the same starting data and flags paths that save
// differently (decision 34). Real browser against the fixture server, like capture-command.test.ts.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCaptureCommand } from "../../src/commands/capture.js";
import { comparePathWrites, pathClipSources, routePattern, writeKey, writeKeys } from "../../src/capture/index.js";
import { loadWalkthroughText } from "../../src/walkthrough/index.js";
import { startFixtureServer, type FixtureServer } from "./fixture-server.js";

describe("path write keys", () => {
  it("ignores reads and record ids, and keys a server action by its id", () => {
    expect(writeKey({ method: "GET", path: "/api/payments" })).toBeUndefined();
    expect(writeKey({ method: "POST", path: "/api/bookings/12/payments#top" })).toBe("POST /api/bookings/:id/payments");
    expect(routePattern("/api/people/3f2b8c1e-1a2b-4c3d-8e9f-0123456789ab/notes")).toBe("/api/people/:id/notes");
    expect(routePattern("/api/shows/summer-show")).toBe("/api/shows/summer-show");
    expect(routePattern("/api/shows/riverbend-show-2026")).toBe("/api/shows/:id");
    expect(routePattern("/api/x/V1StGXR8_Z5jdHi6B-myT")).toBe("/api/x/:id");
    // Query values dropped, parameter names kept (sorted): a different parameter can be a different save.
    expect(routePattern("/api/payments?split=1&booking=12")).toBe("/api/payments?booking&split");
    expect(writeKey({ method: "POST", path: "/api/payments?split=1" })).not.toBe(writeKey({ method: "POST", path: "/api/payments" }));
    expect(writeKey({ method: "POST", path: "/attendees/7", action: "7f3a9c" })).toBe("POST action 7f3a9c");
  });

  it("compares a path's writes with the main run's", () => {
    const main = writeKeys({
      steps: [
        { impact: { urls: [], requests: [{ method: "GET", path: "/api/x" }, { method: "POST", path: "/api/payments" }] } },
      ] as never,
    });
    expect(comparePathWrites("same", main, ["POST /api/payments"])).toBeUndefined();
    expect(comparePathWrites("from-attendee", main, ["POST /api/payments/allocate"])?.message).toBe(
      "path from-attendee saves differently: POST /api/payments/allocate vs POST /api/payments",
    );
    expect(comparePathWrites("quiet", main, [])?.message).toBe("path quiet saves differently: no save vs POST /api/payments");
    // Counted per key: saving the same thing twice is a difference.
    expect(comparePathWrites("twice", main, ["POST /api/payments", "POST /api/payments"])?.message).toBe(
      "path twice saves differently: POST /api/payments ×2 vs POST /api/payments",
    );
  });
});

describe("pathClipSources (for a later per-path clip render)", () => {
  it("gives each passing path's opening steps, their manifest steps and frames", () => {
    const dir = mkdtempSync(join(tmpdir(), "aida-clip-src-"));
    dirs.push(dir);
    const wt = loadWalkthroughText(
      `walkthrough: w\ntitle: W\nstart: { page: /a }\nsteps:\n  - id: one\n    do: click "A" button\n  - id: two\n    do: click "B" button\npaths:\n  - id: other\n    title: Other\n    when: Use this from C.\n    start: { page: /c }\n    steps:\n      - id: open-c\n        do: click "C" button\n    joins: two\n`,
    );
    const pathDir = join(dir, "paths", "other");
    mkdirSync(pathDir, { recursive: true });
    const ev = (image: string) => ({ id: image, camera: "full", cameraBox: null, events: [{ type: "frame", image, transition: "cut" }], doc: { image, highlights: [] }, impact: { urls: [], requests: [] }, checks: [] });
    writeFileSync(join(pathDir, "manifest.json"), JSON.stringify({ workflow: "w", baseUrl: "", viewport: { width: 1, height: 1 }, deviceScaleFactor: 1, steps: [ev("0001.png"), ev("0002.png")] }));
    writeFileSync(join(pathDir, "validation.json"), JSON.stringify({ ok: true, steps: [] }));
    const [clip] = pathClipSources(wt, dir);
    expect(clip).toMatchObject({ pathId: "other", captureDir: pathDir, frames: ["0001.png"] });
    expect(clip.walkthrough.steps.map((s) => s.id)).toEqual(["open-c"]);
    expect(clip.walkthrough.start?.page).toBe("/c");
  });
});

let server: FixtureServer;
const writes: string[] = [];
const bodies: string[] = [];
const events: string[] = [];
const dirs: string[] = [];

beforeEach(async () => {
  writes.length = 0;
  bodies.length = 0;
  events.length = 0;
  server = await startFixtureServer((req, res) => {
    if (!req.url?.startsWith("/api/")) return false;
    writes.push(`${req.method} ${req.url}`);
    events.push(`${req.method} ${req.url}`);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      bodies.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    return true;
  });
  (globalThis as Record<string, unknown>).__dbResetCount = 0;
  (globalThis as Record<string, unknown>).__events = events;
});

afterEach(async () => {
  await server.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function project(paths: string, opts: { database?: boolean; amount?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-capture-paths-"));
  dirs.push(dir);
  const database = opts.database ?? true;
  writeFileSync(
    join(dir, "aida.config.mjs"),
    `export default { app: { baseUrl: ${JSON.stringify(server.url)} }, walkthroughsDir: "./walkthroughs", buildDir: "./.build", ${database ? `database: "./database.mjs",` : ""} };`,
  );
  writeFileSync(
    join(dir, "database.mjs"),
    `export default { url() { return "http://127.0.0.1:1"; }, async reset() { globalThis.__dbResetCount++; globalThis.__events?.push("reset"); }, async query() { return [{ n: 1 }]; }, async close() {} };`,
  );
  mkdirSync(join(dir, "walkthroughs"));
  writeFileSync(
    join(dir, "walkthroughs", "record-payment.yaml"),
    `walkthrough: record-payment
title: Record a payment
start: { page: /paths-booking.html }
steps:
  - id: open
    title: Open the payment form
    do: click "Record payment" link
    actions: []
  - id: amount
    title: Enter the amount
    do: fill "Amount" with "${opts.amount ?? "50"}"
  - id: save
    title: Save the payment
    do: click "Save" button
    check: text "Payment saved" is visible
${paths}`.replace("    actions: []\n", ""),
  );
  return dir;
}

const attendee = `paths:
  - id: from-attendee
    title: From the attendee's page
    when: Use this when the attendee pays for several bookings at once.
    start: { page: /paths-attendee.html }
    steps:
      - id: open-attendee
        title: Open the payment form
        do: click "Pay for attendee" link
    joins: amount
`;

async function capture(dir: string): Promise<{ code: number; out: Record<string, unknown> }> {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (s: string) => logs.push(s);
  try {
    const code = await runCaptureCommand({ configPath: join(dir, "aida.config.mjs"), walkthroughIds: [], json: true });
    return { code, out: JSON.parse(logs.at(-1)!) };
  } finally {
    console.log = orig;
  }
}

describe("aida capture: paths", () => {
  it("captures each path after its own reset, then the main path last, and flags a path that saves differently", async () => {
    const dir = project(attendee);
    const { code, out } = await capture(dir);
    expect(code).toBe(0); // a difference never fails the capture
    const summary = (out.walkthroughs as Record<string, unknown>[])[0];
    expect(summary).toMatchObject({ ok: true, paths: [{ path: "from-attendee", ok: true, steps: { total: 3, passed: 3 } }] });
    expect((summary.pathDiffs as { message: string }[])[0].message).toBe(
      "path from-attendee saves differently: POST /api/payments/allocate vs POST /api/bookings/:id/payments",
    );

    const captureDir = join(dir, ".build", "record-payment", "capture");
    const validation = JSON.parse(readFileSync(join(captureDir, "validation.json"), "utf8"));
    expect(validation.pathDiffs).toHaveLength(1);
    const pathDir = join(captureDir, "paths", "from-attendee");
    const manifest = JSON.parse(readFileSync(join(pathDir, "manifest.json"), "utf8"));
    expect(manifest.steps.map((s: { id: string }) => s.id)).toEqual(["open-attendee", "amount", "save"]);
    expect(JSON.parse(readFileSync(join(pathDir, "validation.json"), "utf8")).ok).toBe(true);
    expect(existsSync(join(pathDir, "frames"))).toBe(true);
    // reset → path → reset → main: every run starts from the same data, and the main run's save
    // is the last thing that happens, so walkthroughs that depend on it see its data.
    expect(events).toEqual(["reset", "POST /api/payments/allocate", "reset", "POST /api/bookings/12/payments"]);
  }, 90_000);

  it("gives each path its own {{run.id}}", async () => {
    const dir = project(attendee, { amount: "{{run.id}}" });
    const { code } = await capture(dir);
    expect(code).toBe(0);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatch(/^[a-z0-9]{6}$/);
    expect(bodies[0]).not.toBe(bodies[1]);
  }, 90_000);

  it("doesn't run paths when no reset is allowed: each is marked not captured with the reason", async () => {
    for (const [label, dir, noReset] of [
      ["no adapter", project(attendee, { database: false }), false],
      ["--no-reset", project(attendee), true],
    ] as const) {
      writes.length = 0;
      const logs: string[] = [];
      const orig = console.log;
      console.log = (s: string) => logs.push(s);
      let code: number;
      try {
        code = await runCaptureCommand({ configPath: join(dir, "aida.config.mjs"), walkthroughIds: [], json: true, noReset });
      } finally {
        console.log = orig;
      }
      const summary = JSON.parse(logs.at(-1)!).walkthroughs[0];
      expect(code, label).toBe(0);
      expect(summary.ok, label).toBe(true);
      expect(summary.paths[0].skipped, label).toMatch(noReset ? /--no-reset/ : /database adapter with reset\(\)/);
      // Only the main run saved: no path ran on the main run's leftovers.
      expect(writes, label).toEqual(["POST /api/bookings/12/payments"]);
      const pathValidation = JSON.parse(readFileSync(join(dir, ".build", "record-payment", "capture", "paths", "from-attendee", "validation.json"), "utf8"));
      expect(pathValidation.ok, label).toBe(false);
      expect(pathValidation.notCaptured, label).toMatch(/reset/);
    }
  }, 120_000);

  it("fails the capture when a path fails, and drops dirs of paths that were removed", async () => {
    // A cross-origin goto is refused at once (the origin guard applies to path runs too).
    const dir = project(attendee.replace('do: click "Pay for attendee" link', "do: go to https://example.com/elsewhere"));
    const stale = join(dir, ".build", "record-payment", "capture", "paths", "gone");
    mkdirSync(stale, { recursive: true });
    const { code, out } = await capture(dir);
    expect(code).toBe(1);
    const summary = (out.walkthroughs as Record<string, unknown>[])[0];
    expect(summary.ok).toBe(false);
    const path = (summary.paths as { ok: boolean; failure?: { error: string } }[])[0];
    expect(path.ok).toBe(false);
    expect(path.failure?.error).toMatch(/refusing cross-origin goto/);
    expect(existsSync(stale)).toBe(false);
  }, 90_000);
});
