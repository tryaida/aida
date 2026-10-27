// M36 (decision 37): path comparison looks at what was saved. Reads are told apart from saves (a
// server action that revalidated nothing, a GraphQL query), counts are order-insensitive, and the
// walkthrough's end checks run after every path, so a path that leaves different data is flagged;
// a path may run to its own end with no `joins`. Real browser against the fixture server.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCaptureCommand } from "../../src/commands/capture.js";
import { comparePathWrites, endChecks, graphqlOperation, isGraphqlRequest, serverActionSaved, writeKey } from "../../src/capture/index.js";
import { startFixtureServer, type FixtureServer } from "./fixture-server.js";

describe("reads vs saves", () => {
  it("reads a server action's revalidation header the way Next 14-16 write it", () => {
    // Next 16: absent or 0 = nothing revalidated; 1 / 2 = revalidated.
    expect(serverActionSaved({})).toBe(false);
    expect(serverActionSaved({ "x-action-revalidated": "0" })).toBe(false);
    expect(serverActionSaved({ "x-action-revalidated": "1" })).toBe(true);
    expect(serverActionSaved({ "x-action-revalidated": "2" })).toBe(true);
    // Next 14/15: [paths, tag revalidated, cookie revalidated].
    expect(serverActionSaved({ "x-action-revalidated": "[[],0,0]" })).toBe(false);
    expect(serverActionSaved({ "x-action-revalidated": "[[],1,0]" })).toBe(true);
    expect(serverActionSaved({ "x-action-revalidated": "[[],0,1]" })).toBe(true);
    expect(serverActionSaved({ "x-action-revalidated": '[["/payments"],0,0]' })).toBe(true);
    // A redirect is a change; an unreadable header is never taken for a read.
    expect(serverActionSaved({ "X-Action-Redirect": "/payments;push" })).toBe(true);
    // A session cookie refreshed by auth middleware on every response is not a save (M36 pilot).
    expect(serverActionSaved({ "set-cookie": "authjs.session-token=abc; Path=/; HttpOnly" })).toBe(false);
    expect(serverActionSaved({ "x-action-revalidated": "weird" })).toBe(true);
  });

  it("tells GraphQL queries from mutations", () => {
    expect(graphqlOperation(JSON.stringify({ query: "query Bookings { bookings { id } }" }))).toEqual({ kind: "query", name: "Bookings" });
    expect(graphqlOperation(JSON.stringify({ query: "{ bookings { id } }" }))).toEqual({ kind: "query", name: "bookings", anonymous: true });
    expect(graphqlOperation(JSON.stringify({ query: "# a comment with mutation in it\nmutation Pay($a: Int) { pay(a: $a) { id } }" }))).toEqual({ kind: "mutation", name: "Pay" });
    expect(graphqlOperation(JSON.stringify([{ query: "query A { a }" }, { query: "mutation B { b }" }]))?.kind).toBe("mutation");
    expect(graphqlOperation(JSON.stringify({ operationName: "Pay", extensions: { persistedQuery: {} } }))).toBeUndefined();
    expect(graphqlOperation("amount=5")).toBeUndefined();
    expect(writeKey({ method: "POST", path: "/graphql", read: true })).toBeUndefined();
    expect(writeKey({ method: "POST", path: "/graphql", operation: "mutation Pay" })).toBe("POST /graphql mutation Pay");
    expect(writeKey({ method: "POST", path: "/payments", action: "a1", read: true })).toBeUndefined();
    expect(writeKey({ method: "POST", path: "/payments", action: "a1" })).toBe("POST action a1");
  });

  it("flags a path whose end checks fail where the main path's pass, and says which", () => {
    const pass = { ok: true, failed: [] };
    const fail = { ok: false, failed: ["booking-paid"] };
    expect(comparePathWrites("same", ["POST /a"], ["POST /a"], { main: pass, path: pass })).toBeUndefined();
    const diff = comparePathWrites("from-list", ["POST /a"], ["POST /a"], { main: pass, path: fail });
    expect(diff).toMatchObject({ reasons: ["data"], endChecks: { main: pass, path: fail } });
    expect(diff?.message).toBe("path from-list leaves different data: end checks fail where the main path's pass (booking-paid)");
    expect(comparePathWrites("odd", ["POST /a"], ["POST /a"], { main: fail, path: pass })?.message).toMatch(/end checks pass where the main path's fail \(booking-paid\)/);
    expect(endChecks({ steps: [{ id: "save", ok: true, checks: [{ ok: true }], ms: 1 }] as never, dbChecks: [{ name: "booking-paid", ok: false }] })).toEqual(fail);
  });

  it("flags a server action only one run called, even one that looked like a read (it may save without revalidating)", () => {
    const same = comparePathWrites("p", ["POST action s1"], ["POST action s1"], undefined, { main: ["r1", "s1"], path: ["r1", "s1"] });
    expect(same).toBeUndefined();
    const diff = comparePathWrites("p", ["POST action s1"], ["POST action s1"], undefined, { main: ["r1", "s1"], path: ["s1", "w9"] });
    expect(diff).toMatchObject({ reasons: ["actions"], actionsOnlyInPath: ["w9"], actionsOnlyInMain: ["r1"] });
    expect(diff?.message).toBe(
      "path p calls server action w9, which the main path doesn't; the main path calls server action r1, which path p doesn't (it revalidated nothing, so it looked like a read, but it may still save)",
    );
    // A save already told apart isn't repeated as an action difference.
    const saves = comparePathWrites("p", ["POST action s1"], ["POST action s2"], undefined, { main: ["s1"], path: ["s2"] });
    expect(saves?.reasons).toEqual(["saves"]);
  });

  it("reads GraphQL only at a GraphQL endpoint, and keys an anonymous mutation by its first root field", () => {
    expect(isGraphqlRequest("/api/graphql", "application/json")).toBe(true);
    expect(isGraphqlRequest("/graphql/", undefined)).toBe(true);
    expect(isGraphqlRequest("/api/search", "application/graphql")).toBe(true);
    // A plain API route whose body happens to carry a `query` field is a save like any other POST.
    expect(isGraphqlRequest("/api/orders", "application/json")).toBe(false);
    expect(graphqlOperation(JSON.stringify({ query: "query cheap pizza" }))).toBeUndefined();
    expect(graphqlOperation(JSON.stringify({ query: "mutation { createPayment(amount: 5) { id } }" }))).toEqual({ kind: "mutation", name: "createPayment", anonymous: true });
    expect(graphqlOperation(JSON.stringify({ query: "mutation ($a: Int) { paid: markPaid(a: $a) { id } }" }))).toEqual({ kind: "mutation", name: "markPaid", anonymous: true });
    expect(graphqlOperation("mutation { refund { id } }")).toEqual({ kind: "mutation", name: "refund", anonymous: true });
    expect(graphqlOperation(JSON.stringify({ query: 'fragment F on P { id }\nquery Q { p { ...F } }' }))).toEqual({ kind: "query", name: "Q" });
  });
});

let server: FixtureServer;
const events: string[] = [];
const dirs: string[] = [];
const g = globalThis as Record<string, unknown>;

beforeEach(async () => {
  events.length = 0;
  g.__acmePaid = false;
  g.__events = events;
  server = await startFixtureServer((req, res) => {
    const action = req.headers["next-action"];
    if (req.method === "POST" && typeof action === "string") {
      req.resume();
      req.on("end", () => {
        // Like Auth.js middleware: every response refreshes the session cookie, reads included.
        const headers: Record<string, string> = { "content-type": "text/x-component", "set-cookie": "acme.session=fresh; Path=/; HttpOnly" };
        if (action === "save-booking") {
          events.push(action);
          g.__acmePaid = true;
          headers["x-action-revalidated"] = "1"; // Next 16
        } else if (action === "save-allocate") {
          events.push(action);
          headers["x-action-revalidated"] = "[[],1,0]"; // Next 14/15
        } else if (action === "read-people") {
          headers["x-action-revalidated"] = "[[],0,0]"; // Next 14/15: nothing revalidated
        } // read-options: no header at all (Next 16)
        res.writeHead(200, headers);
        res.end("0:{}");
      });
      return true;
    }
    if (req.url === "/api/graphql") {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
      return true;
    }
    return false;
  });
});

afterEach(async () => {
  await server.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function project(paths: string): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-path-compare-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "aida.config.mjs"),
    `export default { app: { baseUrl: ${JSON.stringify(server.url)} }, walkthroughsDir: "./walkthroughs", buildDir: "./.build", database: "./database.mjs" };`,
  );
  writeFileSync(
    join(dir, "database.mjs"),
    `export default { url() { return "http://127.0.0.1:1"; }, async reset() { globalThis.__acmePaid = false; globalThis.__events?.push("reset"); }, async query() { return [{ paid: globalThis.__acmePaid === true }]; }, async close() {} };`,
  );
  mkdirSync(join(dir, "walkthroughs"));
  writeFileSync(
    join(dir, "walkthroughs", "record-payment.yaml"),
    `walkthrough: record-payment
title: Record a payment
start: { page: /acme-pay-booking.html }
steps:
  - id: open
    title: Open the payment form
    do: click "Record payment" link
  - id: amount
    title: Enter the amount
    do: fill "Amount" with "50"
  - id: save
    title: Save the payment
    do: click "Save" button
    check: text "Payment saved" is visible
validate:
  database:
    - name: booking-paid
      sql: select paid from bookings where id = 12
      expect: { paid: true }
${paths}`,
  );
  return dir;
}

const fromAttendee = `  - id: from-attendee
    title: From the attendee's page
    when: Use this when you're on the attendee's page.
    start: { page: /acme-pay-attendee.html }
    steps:
      - id: open-attendee
        title: Open the payment form
        do: click "Pay for attendee" link
    joins: amount
`;

const fromList = `  - id: from-list
    title: From the Entries list
    when: Use this when you're already on Entries.
    start: { page: /acme-pay-list.html }
    steps:
      - id: list-amount
        title: Enter the amount
        do: fill "Amount" with "50"
      - id: list-record
        title: Record it
        do: click "Record" button
        check: text "Payment recorded" is visible
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

describe("aida capture: comparing what paths saved (decision 37)", () => {
  it("ignores server-action and GraphQL reads, runs a path without joins to its own end, and flags one that leaves different data", async () => {
    const dir = project(`paths:\n${fromAttendee}${fromList}`);
    const { code, out } = await capture(dir);
    expect(code).toBe(0); // neither a difference nor a path's failing end check fails the capture
    const summary = (out.walkthroughs as Record<string, unknown>[])[0];
    expect(summary).toMatchObject({
      ok: true,
      paths: [
        { path: "from-attendee", ok: true, steps: { total: 3, passed: 3 } },
        { path: "from-list", ok: true, steps: { total: 2, passed: 2 } },
      ],
    });
    // reset → each path → reset → main, every save its own.
    expect(events).toEqual(["reset", "save-booking", "reset", "save-allocate", "reset", "save-booking"]);

    const captureDir = join(dir, ".build", "record-payment", "capture");
    const validation = JSON.parse(readFileSync(join(captureDir, "validation.json"), "utf8"));
    // from-attendee calls the same reads more often, in another order, and saves the same: not flagged.
    const diffs = validation.pathDiffs as { path: string; reasons: string[]; message: string }[];
    expect(diffs.map((d) => d.path)).toEqual(["from-list"]);
    // The list page calls none of the form's reads: flagged too, since a read may still save.
    expect(diffs[0].reasons).toEqual(["saves", "actions", "data"]);
    expect(diffs[0].message).toBe(
      "path from-list saves POST action save-allocate once; main path saves POST action save-booking once. " +
        "the main path calls server action read-options, server action read-people, which path from-list doesn't (it revalidated nothing, so it looked like a read, but it may still save). " +
        "path from-list leaves different data: end checks fail where the main path's pass (booking-paid)",
    );
    expect(validation.pathChecks).toEqual([
      { path: "from-attendee", ok: true, failed: [], captured: true },
      { path: "from-list", ok: false, failed: ["booking-paid"], captured: true },
    ]);

    // The standalone path ran its own steps only, and its capture still counts as passed.
    const listDir = join(captureDir, "paths", "from-list");
    const manifest = JSON.parse(readFileSync(join(listDir, "manifest.json"), "utf8"));
    expect(manifest.steps.map((s: { id: string }) => s.id)).toEqual(["list-amount", "list-record"]);
    const listValidation = JSON.parse(readFileSync(join(listDir, "validation.json"), "utf8"));
    expect(listValidation).toMatchObject({ ok: true, endChecks: { ok: false, failed: ["booking-paid"] } });
    // The reads were recorded, marked as reads.
    const attendee = JSON.parse(readFileSync(join(captureDir, "paths", "from-attendee", "manifest.json"), "utf8"));
    const requests = attendee.steps.flatMap((s: { impact: { requests: unknown[] } }) => s.impact.requests) as { action?: string; read?: boolean; path: string }[];
    expect(requests.filter((r) => r.action?.startsWith("read-")).every((r) => r.read === true)).toBe(true);
    expect(requests.find((r) => r.path === "/api/graphql")?.read).toBe(true);
    expect(requests.find((r) => r.action === "save-booking")?.read).toBeUndefined();
  }, 120_000);

  it("fails a path whose own final check fails, and still records its end checks", async () => {
    const broken = fromList.replace('check: text "Payment recorded" is visible', 'check: text "Receipt printed" is visible');
    const dir = project(`paths:\n${broken}`);
    const { code, out } = await capture(dir);
    expect(code).toBe(1);
    const summary = (out.walkthroughs as Record<string, unknown>[])[0];
    expect(summary).toMatchObject({ ok: false, paths: [{ path: "from-list", ok: false }] });
    const validation = JSON.parse(readFileSync(join(dir, ".build", "record-payment", "capture", "validation.json"), "utf8"));
    expect(validation.pathChecks).toEqual([{ path: "from-list", ok: false, failed: ["final step list-record", "booking-paid"], captured: false }]);
    // Never compared: a failed path isn't flagged as a difference, it's a failure.
    expect(validation.pathDiffs).toBeUndefined();
  }, 120_000);
});
