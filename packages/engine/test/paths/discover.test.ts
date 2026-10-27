// M33: `aida paths` finds other screens that make the same save as a walkthrough's main path.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Walkthrough } from "../../src/walkthrough/index.js";
import type { CaptureManifest } from "../../src/capture/index.js";
import { bestRouteFor, callSiteMethod, compareRouteSpecificity, discoverPaths, editsExistingRecord, formatDiscoverPaths, literalRouteRegex } from "../../src/paths/index.js";
import { routeToRegex } from "../../src/impact/match.js";
import { runPaths } from "../../src/commands/paths.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function write(root: string, file: string, text: string): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}

/** A small fictional Acme Events app: three screens record a payment, one only lists them. */
function app(): string {
  const root = mkdtempSync(join(tmpdir(), "aida-paths-app-"));
  dirs.push(root);
  write(root, "package.json", JSON.stringify({ name: "acme-events", dependencies: { next: "15.0.0" } }));
  write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./*"] } } }));
  write(root, "app/layout.tsx", "export default function L({ children }) { return children; }\n");
  write(root, "app/bookings/[id]/page.tsx", 'import { PaymentForm } from "../../../components/payment-form";\nexport default function P() { return <PaymentForm />; }\n');
  write(root, "app/payments/page.tsx", 'import { QuickPay } from "@/components/quick-pay";\nexport default function P() { return <QuickPay />; }\n');
  write(root, "app/reports/page.tsx", 'export default async function P() { const r = await fetch("/api/payments"); return null; }\n');
  write(root, "app/refunds/page.tsx", 'import { Refund } from "@/components/refund";\nexport default function P() { return <Refund />; }\n');
  write(root, "app/attendees/[id]/page.tsx", "export default function P() { return null; }\n");
  write(root, "app/api/payments/route.ts", 'export async function POST() { return Response.json({ ok: "/api/payments" }); }\n');
  write(root, "app/api/payments/refund/route.ts", "export async function POST() { return Response.json({}); }\n");
  write(
    root,
    "components/payment-form.tsx",
    'export function PaymentForm() {\n  async function save(amount) {\n    await fetch("/api/payments", {\n      method: "POST",\n      body: JSON.stringify({ amount }),\n    });\n  }\n  return null;\n}\n',
  );
  write(root, "components/quick-pay.tsx", 'import axios from "axios";\nexport function QuickPay() { const pay = (d) => axios.post(`/api/payments`, d); return null; }\n');
  write(root, "components/refund.tsx", 'export function Refund() { fetch("/api/payments/refund", { method: "POST" }); return null; }\n');
  write(root, "components/payment-form.test.tsx", 'fetch("/api/payments", { method: "POST" });\n');
  write(
    root,
    ".next/server/server-reference-manifest.json",
    JSON.stringify({ node: { "7f00aa": { workers: { "app/attendees/[id]/page": { moduleId: 1 } }, layer: {} } }, edge: {} }),
  );
  return root;
}

function walkthrough(paths: Walkthrough["paths"] = undefined): Walkthrough {
  return {
    walkthrough: "record-payment",
    title: "Record a payment",
    start: { page: "/bookings/12" },
    steps: [
      { id: "open", actions: [] },
      { id: "save", actions: [] },
    ],
    ...(paths ? { paths } : {}),
  };
}

function capture(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-paths-capture-"));
  dirs.push(dir);
  const manifest: CaptureManifest = {
    workflow: "record-payment",
    baseUrl: "http://127.0.0.1:3000",
    viewport: { width: 1440, height: 810 },
    deviceScaleFactor: 1,
    steps: [
      { id: "open", camera: "full", cameraBox: null, events: [], doc: { image: null, highlights: [] }, impact: { urls: ["/bookings/12"], requests: [{ method: "GET", path: "/api/payments?booking=12" }] }, checks: [] },
      {
        id: "save",
        camera: "full",
        cameraBox: null,
        events: [],
        doc: { image: null, highlights: [] },
        impact: { urls: [], requests: [{ method: "POST", path: "/api/payments" }, { method: "POST", path: "/bookings/12", action: "7f00aa" }] },
        checks: [],
      },
    ],
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  return dir;
}

describe("aida paths: discovery", () => {
  it("lists pages that make the same save and aren't covered, with the call site", () => {
    const result = discoverPaths({ walkthrough: walkthrough(), captureDir: capture(), appRepo: app() });
    expect(result.writes.map((w) => w.key)).toEqual(["POST /api/payments", "POST action 7f00aa"]);
    const api = result.writes[0];
    expect(api).toMatchObject({ route: "/api/payments", handler: "app/api/payments/route.ts", step: "save" });
    // The GET list call, the refund route and the test file are not call sites of this save.
    expect(api.callSites.map((s) => `${s.file}:${s.line}`)).toEqual(["components/payment-form.tsx:3", "components/quick-pay.tsx:2"]);
    expect(result.candidates).toEqual([
      { route: "/payments", file: "app/payments/page.tsx", write: "POST /api/payments", via: "components/quick-pay.tsx:2" },
      { route: "/attendees/[id]", file: "app/attendees/[id]/page.tsx", write: "POST action 7f00aa", via: "app/attendees/[id]/page.tsx" },
    ]);
    expect(result.covered).toEqual([{ route: "/bookings/[id]", by: "main" }]);
    const text = formatDiscoverPaths(result);
    expect(text).toContain("  /payments  app/payments/page.tsx  via components/quick-pay.tsx:2  (POST /api/payments)");
  });

  it("leaves out pages a path already starts on", () => {
    const paths = [{ id: "from-payments", title: "From Payments", when: "w", start: { page: "/payments" }, steps: [{ actions: [] }], joins: "save" }];
    const result = discoverPaths({ walkthrough: walkthrough(paths), captureDir: capture(), appRepo: app() });
    expect(result.candidates.map((c) => c.route)).toEqual(["/attendees/[id]"]);
    expect(result.covered).toContainEqual({ route: "/payments", by: "path from-payments" });
  });

  it("a visit to a static page never covers the dynamic route beside it (M36)", () => {
    const root = app();
    // `/payments/new` is a page of its own; `/payments/[id]` (a payment's page) also records one.
    write(root, "app/payments/new/page.tsx", 'import { QuickPay } from "@/components/quick-pay";\nexport default function P() { return <QuickPay />; }\n');
    write(root, "app/payments/[id]/page.tsx", 'import { QuickPay } from "@/components/quick-pay";\nexport default function P() { return <QuickPay />; }\n');
    const paths = [{ id: "from-new", title: "New payment", when: "w", start: { page: "/payments/new" }, steps: [{ actions: [] }], joins: "save" }];
    const result = discoverPaths({ walkthrough: walkthrough(paths), captureDir: capture(), appRepo: root });
    expect(result.covered).toContainEqual({ route: "/payments/new", by: "path from-new" });
    expect(result.covered.map((c) => c.route)).not.toContain("/payments/[id]");
    expect(result.candidates.map((c) => c.route)).toContain("/payments/[id]");
  });

  it("lists edit pages last and says they edit an existing record (M36)", () => {
    const root = app();
    write(root, "app/payments/[id]/edit/page.tsx", 'import { QuickPay } from "@/components/quick-pay";\nexport default function P() { return <QuickPay />; }\n');
    write(root, "app/invoices/page.tsx", 'import { EditPaymentForm } from "@/components/edit-payment-form";\nexport default function P() { return <EditPaymentForm />; }\n');
    write(root, "components/edit-payment-form.tsx", 'export function EditPaymentForm() { fetch("/api/payments", { method: "POST" }); return null; }\n');
    const result = discoverPaths({ walkthrough: walkthrough(), captureDir: capture(), appRepo: root });
    const routes = result.candidates.map((c) => c.route);
    expect(routes.slice(-2).sort()).toEqual(["/invoices", "/payments/[id]/edit"]);
    expect(result.candidates.find((c) => c.route === "/payments")?.edits).toBeUndefined();
    expect(result.candidates.find((c) => c.route === "/payments/[id]/edit")?.edits).toBe(true);
    expect(formatDiscoverPaths(result)).toMatch(/\/payments\/\[id\]\/edit .*edits an existing record/);
  });

  it("picks the most specific route for a URL", () => {
    const routes = ["/payments/[id]", "/payments/new", "/payments/[...rest]", "/[[...all]]"].map((pattern) => ({ pattern, regex: routeToRegex(pattern) }));
    expect(bestRouteFor("/payments/new", routes)).toBe("/payments/new");
    expect(bestRouteFor("/payments/7", routes)).toBe("/payments/[id]");
    expect(bestRouteFor("/payments/7/a", routes)).toBe("/payments/[...rest]");
    expect(compareRouteSpecificity("/a/b", "/a/[id]")).toBeGreaterThan(0);
    expect(editsExistingRecord({ route: "/x", file: "app/x/page.tsx" }, "components/UpdateThing.tsx:3")).toBe(true);
    expect(editsExistingRecord({ route: "/x", file: "app/x/page.tsx" }, "components/credit-form.tsx:3")).toBe(false);
  });

  it("never follows symlinks out of the app", () => {
    const root = app();
    const outside = mkdtempSync(join(tmpdir(), "aida-paths-outside-"));
    dirs.push(outside);
    write(outside, "evil.tsx", 'fetch("/api/payments", { method: "POST" });\n');
    symlinkSync(outside, join(root, "components", "linked-dir"));
    symlinkSync(join(outside, "evil.tsx"), join(root, "components", "linked-file.tsx"));
    const result = discoverPaths({ walkthrough: walkthrough(), captureDir: capture(), appRepo: root });
    expect(result.writes[0].callSites.map((s) => s.file).filter((f) => f.includes("linked"))).toEqual([]);
  });

  it("says when a server action can't be mapped without a build", () => {
    const root = app();
    rmSync(join(root, ".next"), { recursive: true });
    const result = discoverPaths({ walkthrough: walkthrough(), captureDir: capture(), appRepo: root });
    expect(result.notes.join("\n")).toMatch(/server action 7f00aa: run `next build`/);
  });

  it("matches route literals and reads the method from the call", () => {
    const re = literalRouteRegex("/api/payments/[id]");
    expect(re.test("fetch(`/api/payments/${id}`, {")).toBe(true);
    expect(re.test('fetch("/api/payments/7")')).toBe(true);
    expect(re.test('fetch("/api/payments/7/refund")')).toBe(false);
    expect(callSiteMethod(['await api.patch("/api/x")'], 0, 16)).toBe("PATCH");
    expect(callSiteMethod(['fetch("/api/x")'], 0, 6)).toBe("GET");
    expect(callSiteMethod(['submit("/api/x")'], 0, 7)).toBeUndefined();
  });

  it("aida paths --json errors clearly without a capture", async () => {
    const root = app();
    write(root, "aida.config.mjs", 'export default { app: { baseUrl: "http://127.0.0.1:3000" }, walkthroughsDir: "./walkthroughs", buildDir: "./.build" };\n');
    write(root, "walkthroughs/record-payment.yaml", 'walkthrough: record-payment\ntitle: Record a payment\nsteps:\n  - id: open\n    do: click "Pay" button\n');
    const logs: string[] = [];
    const orig = console.log;
    console.log = (s: string) => logs.push(s);
    try {
      expect(await runPaths({ configPath: join(root, "aida.config.mjs"), walkthrough: "record-payment", appRepo: root }, true)).toBe(1);
    } finally {
      console.log = orig;
    }
    expect(JSON.parse(logs[0]).error).toMatch(/no capture for "record-payment" yet/);
  });
});
