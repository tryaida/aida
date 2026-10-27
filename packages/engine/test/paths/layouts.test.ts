// M35: `aida paths` finds save buttons rendered from layouts, templates, parallel and intercepting
// routes, and shared components reached through barrels and tsconfig aliases. Fixture: a fictional
// Acme Events app under test/fixtures/paths-app.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CaptureManifest } from "../../src/capture/index.js";
import type { Walkthrough } from "../../src/walkthrough/index.js";
import { appRouteOf, discoverPaths, formatDiscoverPaths, loadAliases, parseModule, resolveAlias, SourceGraph } from "../../src/paths/index.js";
import { isInsideRoot } from "../../src/paths/source-graph.js";

const APP = join(__dirname, "..", "fixtures", "paths-app");
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function write(root: string, file: string, text: string): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}

const walkthrough: Walkthrough = {
  walkthrough: "record-payment",
  title: "Record a payment",
  start: { page: "/bookings/12" },
  steps: [{ id: "save", actions: [] }],
};

function capture(): string {
  const dir = tmp("aida-paths-layout-capture-");
  const manifest: CaptureManifest = {
    workflow: "record-payment",
    baseUrl: "http://127.0.0.1:3000",
    viewport: { width: 1440, height: 810 },
    deviceScaleFactor: 1,
    steps: [
      {
        id: "save",
        camera: "full",
        cameraBox: null,
        events: [],
        doc: { image: null, highlights: [] },
        impact: { urls: ["/bookings/12"], requests: [{ method: "POST", path: "/api/payments" }] },
        checks: [],
      },
    ],
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  return dir;
}

describe("aida paths: layouts and shared components", () => {
  const result = () => discoverPaths({ walkthrough, captureDir: capture(), appRepo: APP });

  it("finds the save on every screen that renders it, and nowhere else", () => {
    const r = result();
    expect(r.covered).toEqual([{ route: "/bookings/[id]", by: "main" }]);
    expect(r.candidates.map((c) => c.route).sort()).toEqual(["/attendees", "/attendees/[id]", "/dashboard", "/feed", "/invoices/[id]", "/reports"]);
    // The (dash) layout imports only Button from the same barrel: /bookings and /receipts/[id] don't render the save.
    expect(r.candidates.map((c) => c.route)).not.toContain("/bookings");
    expect(r.candidates.map((c) => c.route)).not.toContain("/receipts/[id]");
    // Route groups are not URL segments.
    expect(r.candidates.some((c) => c.route.includes("(dash)"))).toBe(false);
  });

  it("a nested layout puts the save on every page under it, named in via", () => {
    const byRoute = new Map(result().candidates.map((c) => [c.route, c]));
    expect(byRoute.get("/attendees")).toEqual({
      route: "/attendees",
      file: "src/app/(dash)/attendees/page.tsx",
      write: "POST /api/payments",
      via: "src/components/payments/record-payment-button.tsx:4 (layout src/app/(dash)/attendees/layout.tsx)",
      layout: "src/app/(dash)/attendees/layout.tsx",
    });
    expect(byRoute.get("/attendees/[id]")?.layout).toBe("src/app/(dash)/attendees/layout.tsx");
  });

  it("a template, imported with a .js specifier, counts like a layout", () => {
    const c = result().candidates.find((x) => x.route === "/invoices/[id]");
    expect(c?.via).toBe("src/components/payments/record-payment-button.tsx:4 (template src/app/(dash)/invoices/[id]/template.tsx)");
  });

  it("a parallel route's slot page shows on its parent route", () => {
    const c = result().candidates.find((x) => x.route === "/dashboard");
    expect(c).toMatchObject({ file: "src/app/(dash)/dashboard/@quickpay/page.tsx", slot: "quickpay" });
  });

  it("an intercepting route shows over the page the reader came from", () => {
    const c = result().candidates.find((x) => x.route === "/feed");
    expect(c).toMatchObject({ file: "src/app/(dash)/feed/@modal/(..)receipts/[id]/page.tsx", slot: "modal", intercepts: "/receipts/[id]" });
    expect(c?.via).toMatch(/\(opens as \/receipts\/\[id\]\)$/);
  });

  it("follows a default export re-exported through two barrels", () => {
    const c = result().candidates.find((x) => x.route === "/reports");
    expect(c).toMatchObject({ file: "src/app/(dash)/reports/page.tsx", via: "src/components/payments/record-payment-button.tsx:4" });
    expect(c?.layout).toBeUndefined();
  });

  it("prints the layout in the text form", () => {
    expect(formatDiscoverPaths(result())).toContain(
      "  /attendees  src/app/(dash)/attendees/page.tsx  via src/components/payments/record-payment-button.tsx:4 (layout src/app/(dash)/attendees/layout.tsx)",
    );
  });

  it("notes a layout that puts the save on many pages", () => {
    const root = tmp("aida-paths-many-");
    write(root, "package.json", JSON.stringify({ name: "acme", dependencies: { next: "15.0.0" } }));
    write(root, "app/layout.tsx", 'import { Pay } from "./pay";\nexport default function L({ children }) { return <>{children}<Pay /></>; }\n');
    write(root, "app/pay.tsx", 'export function Pay() { fetch("/api/payments", { method: "POST" }); return null; }\n');
    for (const p of ["a", "b", "c", "d"]) write(root, `app/${p}/page.tsx`, "export default function P() { return null; }\n");
    write(root, "app/api/payments/route.ts", "export async function POST() {}\n");
    const r = discoverPaths({ walkthrough, captureDir: capture(), appRepo: root });
    expect(r.candidates.map((c) => c.route)).toEqual(["/a", "/b", "/c", "/d"]);
    expect(r.notes.join("\n")).toMatch(/app\/pay\.tsx:1 is rendered by layout app\/layout\.tsx, on all 4 pages under it/);
  });
});

describe("intercepting routes: their own screen, covered by the URL they open as (M35 review)", () => {
  function app(): string {
    const root = tmp("aida-paths-intercept-");
    write(root, "package.json", JSON.stringify({ name: "acme", dependencies: { next: "15.0.0" } }));
    write(root, "app/pay.tsx", 'export function Pay() { fetch("/api/payments", { method: "POST" }); return null; }\n');
    write(root, "app/feed/page.tsx", 'import { Pay } from "../pay";\nexport default function P() { return <Pay />; }\n');
    write(root, "app/feed/@modal/(..)receipts/[id]/page.tsx", 'import { Pay } from "../../../../pay";\nexport default function M() { return <Pay />; }\n');
    write(root, "app/receipts/[id]/page.tsx", "export default function R() { return null; }\n");
    write(root, "app/api/payments/route.ts", "export async function POST() {}\n");
    return root;
  }
  function captureAt(url: string): string {
    const dir = capture();
    const file = join(dir, "manifest.json");
    const m = JSON.parse(readFileSync(file, "utf8")) as CaptureManifest;
    m.steps[0].impact!.urls = [url];
    writeFileSync(file, JSON.stringify(m));
    return dir;
  }

  it("lists the page and the modal over it separately", () => {
    const r = discoverPaths({ walkthrough, captureDir: captureAt("/bookings/12"), appRepo: app() });
    const feed = r.candidates.filter((c) => c.route === "/feed");
    expect(feed.map((c) => c.intercepts ?? null).sort()).toEqual(["/receipts/[id]", null]);
  });

  it("a capture on the page under the modal doesn't cover the modal; one on the URL it opens as does", () => {
    const onFeed = discoverPaths({ walkthrough, captureDir: captureAt("/feed"), appRepo: app() });
    expect(onFeed.covered).toEqual([{ route: "/feed", by: "main" }]);
    expect(onFeed.candidates).toEqual([expect.objectContaining({ route: "/feed", intercepts: "/receipts/[id]" })]);
    const onReceipt = discoverPaths({ walkthrough, captureDir: captureAt("/receipts/7"), appRepo: app() });
    expect(onReceipt.candidates).toEqual([expect.objectContaining({ route: "/feed" })]);
    expect(onReceipt.candidates[0].intercepts).toBeUndefined();
    expect(onReceipt.covered).toEqual([{ route: "/feed", by: "main" }]);
  });
});

describe("routes, aliases and barrels", () => {
  it("maps App Router folders to the route a page shows on", () => {
    expect(appRouteOf(["(dash)", "attendees", "[id]"])).toEqual({ route: "/attendees/[id]" });
    expect(appRouteOf(["dashboard", "@stats", "revenue"])).toEqual({ route: "/dashboard/revenue", slot: "stats" });
    expect(appRouteOf(["feed", "@modal", "(..)photo", "[id]"])).toEqual({ route: "/feed", slot: "modal", intercepts: "/photo/[id]" });
    expect(appRouteOf(["feed", "(.)photo", "[id]"])).toEqual({ route: "/feed", intercepts: "/feed/photo/[id]" });
    expect(appRouteOf(["a", "b", "(..)(..)x"])).toEqual({ route: "/a/b", intercepts: "/x" });
    expect(appRouteOf(["shop", "cart", "(...)sign-in"])).toEqual({ route: "/shop/cart", intercepts: "/sign-in" });
    expect(appRouteOf([])).toEqual({ route: "/" });
  });

  it("reads aliases from JSONC tsconfig with extends, and from jsconfig", () => {
    const aliases = loadAliases(APP);
    expect(Object.keys(aliases.paths).sort()).toEqual(["@/*", "@ui", "~/*"]);
    expect(resolveAlias("@ui", aliases)).toBe(join(APP, "src/components/ui/index.ts"));
    expect(resolveAlias("~/components/payments", aliases)).toBe(join(APP, "src/components/payments/index.ts"));
    expect(resolveAlias("react", aliases)).toBeUndefined();

    const js = tmp("aida-paths-jsconfig-");
    write(js, "jsconfig.json", '{ "compilerOptions": { "paths": { "#lib/*": ["./lib/*"] } } }');
    write(js, "lib/pay.js", "export const pay = 1;\n");
    expect(resolveAlias("#lib/pay", loadAliases(js))).toBe(join(js, "lib/pay.js"));
  });

  it("parses imports, re-exports and own exports", () => {
    const m = parseModule(
      'import React, { useState as s } from "react";\nimport * as UI from "@ui";\nimport type { T } from "./t";\nimport "./side";\nexport { A, B as C } from "./ab";\nexport { default as D } from "./d";\nexport * from "./all";\nexport * as ns from "./ns";\nexport function Own() {}\nconst x = 1;\nexport { x as y };\n',
    );
    expect(m.imports.map((i) => [i.spec, i.names === "*" ? "*" : [...i.names].sort()])).toEqual([
      ["react", ["default", "useState"]],
      ["@ui", "*"],
      ["./side", "*"],
    ]);
    expect(m.reexports.map((r) => [r.spec, r.map === "*" ? "*" : [...r.map]])).toEqual([
      ["./ab", [["A", "A"], ["C", "B"]]],
      ["./d", [["D", "default"]]],
      ["./all", "*"],
      ["./ns", [["ns", "*"]]],
    ]);
    expect([...m.own].sort()).toEqual(["Own", "y"]);
    expect(m.barrel).toBe(false);
    expect(parseModule('// shared\nexport * from "./a";\nexport { B } from "./b";\n').barrel).toBe(true);
  });

  it("follows a barrel only to the names a page takes", () => {
    const g = new SourceGraph(APP);
    const bookings = g.closure(join(APP, "src/app/(dash)/layout.tsx"));
    expect(bookings.has(join(APP, "src/components/ui/button.tsx"))).toBe(true);
    expect(bookings.has(join(APP, "src/components/payments/record-payment-button.tsx"))).toBe(false);
    // A namespace import takes everything.
    const root = tmp("aida-paths-ns-");
    write(root, "page.tsx", 'import * as All from "./lib";\n');
    write(root, "lib/index.ts", 'export { A } from "./a";\nexport { B } from "./b";\n');
    write(root, "lib/a.ts", "export const A = 1;\n");
    write(root, "lib/b.ts", "export const B = 2;\n");
    const all = new SourceGraph(root).closure(join(root, "page.tsx"));
    expect(all.has(join(root, "lib/a.ts")) && all.has(join(root, "lib/b.ts"))).toBe(true);
  });
});

describe("never reads outside the app root (M35 review)", () => {
  it("ignores imports, aliases and layouts that resolve outside the app, through ../ or a symlink", () => {
    const base = tmp("aida-paths-escape-");
    const root = join(base, "app-repo");
    const outside = join(base, "outside");
    write(outside, "secret.ts", 'export const S = 1;\n');
    write(outside, "layout.tsx", 'import { S } from "./secret";\nexport default function L() { return null; }\n');
    write(root, "tsconfig.json", '{ "compilerOptions": { "baseUrl": ".", "paths": { "@out/*": ["../outside/*"] } } }');
    write(root, "page.tsx", 'import "../outside/secret";\nimport { S } from "@out/secret";\nimport { L } from "./linked";\n');
    symlinkSync(join(outside, "secret.ts"), join(root, "linked.ts"));
    const g = new SourceGraph(root);
    const reached = g.closure(join(root, "page.tsx"));
    expect([...reached]).toEqual([join(root, "page.tsx")]);
    // A symlinked entry (a layout linked in from elsewhere) is never read either.
    symlinkSync(join(outside, "layout.tsx"), join(root, "layout.tsx"));
    expect(g.closure(join(root, "layout.tsx")).size).toBe(0);
    expect(isInsideRoot(root, join(root, "page.tsx"))).toBe(true);
    expect(isInsideRoot(root, join(root, "linked.ts"))).toBe(false);
  });

  it("follows only relative tsconfig extends inside the app: never absolute or outside", () => {
    const base = tmp("aida-paths-extends-");
    const root = join(base, "app-repo");
    write(base, "shared.json", '{ "compilerOptions": { "paths": { "@evil/*": ["./x/*"] } } }');
    write(root, "tsconfig.json", JSON.stringify({ extends: ["../shared.json", join(base, "shared.json")], compilerOptions: { paths: { "@/*": ["./src/*"] } } }));
    expect(Object.keys(loadAliases(root).paths)).toEqual(["@/*"]);
    write(root, "tsconfig.json", JSON.stringify({ extends: join(base, "shared.json") }));
    expect(loadAliases(root).paths).toEqual({});
  });
});
