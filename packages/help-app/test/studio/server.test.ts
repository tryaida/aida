import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  captureStatus,
  listWalkthroughs,
  pageAssetFile,
  siteUrlFor,
  videoFileFor,
} from "../../app/studio/_lib/server";

// A throwaway help app laid out the way `aida init` + `aida build` leave one (outDir ".",
// buildDir ".build") — the Studio's helpers resolve everything from the process cwd.
let root: string;
let prevCwd: string;

const WALKTHROUGH = `walkthrough: record-a-payment
version: 1
title: Record a payment
summary: Record an entry fee.
for: office staff
start:
  signed_in_as: office_staff
  page: /payments
steps:
  - id: open
    title: Open Payments
    page_text: Click **Payments**.
    actions: []
`;

beforeAll(() => {
  prevCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), "aida-studio-"));
  mkdirSync(join(root, "walkthroughs"));
  writeFileSync(join(root, "walkthroughs", "record-a-payment.yaml"), WALKTHROUGH);
  writeFileSync(join(root, "walkthroughs", "other.yaml"), WALKTHROUGH.replace("record-a-payment", "other").replace("Record a payment", "Other"));
  mkdirSync(join(root, "pages", "record-a-payment", "screenshots"), { recursive: true });
  writeFileSync(join(root, "pages", "record-a-payment", "screenshots", "step-01.png"), "png");
  writeFileSync(join(root, "pages", "record-a-payment", "index.mdx"), "secret page");
  mkdirSync(join(root, ".build", "record-a-payment", "capture"), { recursive: true });
  writeFileSync(join(root, ".build", "record-a-payment", "capture", "validation.json"), JSON.stringify({ ok: false, ranAt: "2026-10-20T00:00:00Z" }));
  writeFileSync(join(root, ".build", "record-a-payment", "capture", "run.json"), JSON.stringify({ ranAt: "2026-10-21T00:00:00Z" }));
  mkdirSync(join(root, "videos", "record-a-payment"), { recursive: true });
  writeFileSync(join(root, "videos", "record-a-payment", "record-a-payment.mp4"), "mp4");
  mkdirSync(join(root, "public"));
  writeFileSync(join(root, "public", "procedures.json"), JSON.stringify([{ id: "record-a-payment", url: "/how-do-i/payments/record-a-payment" }]));
  writeFileSync(join(root, "public", "search-index.json"), JSON.stringify([{ url: "/other" }, { url: "//evil.example/record-a-payment" }]));
  process.chdir(root);
});

afterAll(() => {
  process.chdir(prevCwd);
  rmSync(root, { recursive: true, force: true });
});

describe("Studio server helpers", () => {
  it("lists walkthroughs with capture status and last checked", () => {
    const list = listWalkthroughs();
    const rap = list.find((w) => w.id === "record-a-payment");
    expect(rap).toMatchObject({ title: "Record a payment", stepCount: 1, status: "failed", lastChecked: "2026-10-21T00:00:00Z", summary: "Record an entry fee." });
    expect(list.find((w) => w.id === "other")?.status).toBe("not-captured");
    expect(captureStatus("other")).toEqual({ status: "not-captured" });
  });

  it("finds the site URL from procedures.json, then search-index.json, never off-site", () => {
    expect(siteUrlFor("record-a-payment")).toBe("/how-do-i/payments/record-a-payment");
    expect(siteUrlFor("other")).toBe("/other");
    writeFileSync(join(root, "public", "procedures.json"), "[]");
    expect(siteUrlFor("record-a-payment")).toBeUndefined();
    expect(() => siteUrlFor("../x")).toThrow();
  });

  it("serves page images only from pages/<id>/screenshots, by bare file name", () => {
    expect(pageAssetFile("record-a-payment", "step-01.png")?.contentType).toBe("image/png");
    expect(pageAssetFile("record-a-payment", "../index.mdx")).toBeUndefined();
    expect(pageAssetFile("record-a-payment", "..%2Findex.mdx")).toBeUndefined();
    expect(pageAssetFile("record-a-payment", "index.mdx")).toBeUndefined();
    expect(pageAssetFile("record-a-payment", "missing.png")).toBeUndefined();
    expect(() => pageAssetFile("../pages", "step-01.png")).toThrow();
  });

  it("finds the rendered video by id only", () => {
    expect(videoFileFor("record-a-payment", "mp4")).toBe(join(root, "videos", "record-a-payment", "record-a-payment.mp4"));
    expect(videoFileFor("record-a-payment", "vtt")).toBeUndefined();
    expect(() => videoFileFor("..", "mp4")).toThrow();
  });
});

describe("Studio API routes", () => {
  // Every handler under app/studio/api/** must start with the dev-only guard and the
  // Host/Origin/token check (security.ts) before touching anything else.
  const apiDir = join(__dirname, "../../app/studio/api");
  for (const name of readdirSync(apiDir)) {
    it(`${name}: every exported handler is dev-only and token-guarded`, () => {
      const src = readFileSync(join(apiDir, name, "route.ts"), "utf8");
      const handlers = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\(request: Request\) \{\n([\s\S]*?)\n\}/g)];
      expect(handlers.length).toBeGreaterThan(0);
      for (const [, , body] of handlers) {
        const lines = body.split("\n").map((l) => l.trim());
        expect(lines.slice(0, 4)).toEqual([
          "const guard = devOnlyGuard();",
          "if (guard) return guard;",
          "const security = assertStudioRequest(request);",
          "if (security) return security;",
        ]);
      }
    });
  }
});
