// M32 review: the brand font stylesheet and files come off the network and land in the print
// HTML — https only on every hop, size caps enforced, and a cached index re-checked on read.
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheFontFaces, fetchCapped, MAX_STYLESHEET_BYTES } from "../../src/pdf/fonts.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "aida-fonts-"));
  dirs.push(d);
  return d;
}

/** A fetch stand-in answering by URL; records every URL asked for. */
function stubFetch(routes: Record<string, () => Response>): string[] {
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    seen.push(String(url));
    const r = routes[String(url)];
    return r ? r() : new Response("not found", { status: 404 });
  });
  return seen;
}

const CSS = "@font-face { font-family: 'Acme Sans'; font-style: normal; font-weight: 400; src: url(https://fonts.example.com/a.ttf) format('truetype'); }";

describe("fetchCapped", () => {
  it("refuses a plain-http URL without fetching it", async () => {
    const seen = stubFetch({});
    expect(await fetchCapped("http://fonts.example.com/css", 1000)).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it("follows an https redirect but refuses one that drops to http", async () => {
    stubFetch({
      "https://fonts.example.com/css": () => new Response(null, { status: 302, headers: { location: "https://cdn.example.com/css" } }),
      "https://cdn.example.com/css": () => new Response("ok"),
      "https://fonts.example.com/bad": () => new Response(null, { status: 301, headers: { location: "http://cdn.example.com/css" } }),
    });
    expect((await fetchCapped("https://fonts.example.com/css", 1000))?.toString()).toBe("ok");
    expect(await fetchCapped("https://fonts.example.com/bad", 1000)).toBeUndefined();
  });

  it("refuses a declared content-length over the cap, and a body that streams past it", async () => {
    stubFetch({
      "https://fonts.example.com/declared": () => new Response("x".repeat(10), { headers: { "content-length": "999999" } }),
      "https://fonts.example.com/streamed": () => new Response("x".repeat(5000)),
    });
    expect(await fetchCapped("https://fonts.example.com/declared", 1000)).toBeUndefined();
    expect(await fetchCapped("https://fonts.example.com/streamed", 1000)).toBeUndefined();
  });
});

describe("cacheFontFaces", () => {
  it("refuses an http stylesheet URL", async () => {
    const seen = stubFetch({});
    expect(await cacheFontFaces("http://fonts.example.com/css", tmp())).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it("caps the stylesheet size", async () => {
    stubFetch({ "https://fonts.example.com/css": () => new Response(CSS + " ".repeat(MAX_STYLESHEET_BYTES)) });
    expect(await cacheFontFaces("https://fonts.example.com/css", tmp())).toBeUndefined();
  });

  it("downloads and then reuses a valid cache without the network", async () => {
    const dir = tmp();
    stubFetch({
      "https://fonts.example.com/css": () => new Response(CSS),
      "https://fonts.example.com/a.ttf": () => new Response(new Uint8Array([0, 1, 0, 0, 9])),
    });
    const faces = await cacheFontFaces("https://fonts.example.com/css", dir);
    expect(faces?.map((f) => f.family)).toEqual(["Acme Sans"]);
    const seen = stubFetch({});
    expect(await cacheFontFaces("https://fonts.example.com/css", dir)).toEqual(faces);
    expect(seen).toEqual([]);
  });

  it("distrusts a tampered cache index (bad family, file outside the cache) and refetches", async () => {
    const dir = tmp();
    stubFetch({
      "https://fonts.example.com/css": () => new Response(CSS),
      "https://fonts.example.com/a.ttf": () => new Response(new Uint8Array([0, 1, 0, 0, 9])),
    });
    const faces = (await cacheFontFaces("https://fonts.example.com/css", dir))!;
    const index = join(dir, `${(await import("node:crypto")).createHash("sha256").update("https://fonts.example.com/css").digest("hex").slice(0, 24)}.json`);
    for (const bad of [
      [{ ...faces[0], family: "x'; } body { color: red" }],
      [{ ...faces[0], file: "/etc/passwd" }],
    ]) {
      writeFileSync(index, JSON.stringify(bad));
      const seen = stubFetch({});
      expect(await cacheFontFaces("https://fonts.example.com/css", dir)).toBeUndefined();
      expect(seen).toContain("https://fonts.example.com/css");
    }
  });
});
