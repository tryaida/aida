// `aida init` reads where the app runs from its own settings instead of assuming port 3000.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_APP_URL, detectAppUrl, localOrigin, pageLooksLikeApp } from "../../src/init/app-url.js";

let root: string;

function write(rel: string, text: string): void {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "aida-app-url-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("detectAppUrl", () => {
  it("defaults to localhost:3000 with nothing to go on", () => {
    expect(detectAppUrl([root])).toEqual({ url: DEFAULT_APP_URL, source: "default" });
  });

  it("reads a local base URL from the app's env files", () => {
    write(".env.local", 'NEXT_PUBLIC_BASE_URL="http://localhost:3210/app"\n');
    expect(detectAppUrl([root]).url).toBe("http://localhost:3210");
  });

  it("ignores a base URL that isn't this machine", () => {
    write(".env", "NEXT_PUBLIC_APP_URL=https://app.example.com\nPORT=4100\n");
    expect(detectAppUrl([root]).url).toBe("http://localhost:4100");
  });

  it("never reads production env files", () => {
    write(".env.production", "NEXT_PUBLIC_BASE_URL=http://localhost:9999\n");
    expect(detectAppUrl([root]).url).toBe(DEFAULT_APP_URL);
  });

  it("reads a port from the start or dev script", () => {
    write("package.json", JSON.stringify({ scripts: { dev: "next dev -p 4200" } }));
    expect(detectAppUrl([root])).toMatchObject({ url: "http://localhost:4200" });
  });

  it("prefers the app's own folder over the workspace root", () => {
    write("apps/web/.env.local", "PORT=5001\n");
    write(".env", "PORT=5002\n");
    expect(detectAppUrl([path.join(root, "apps/web"), root]).url).toBe("http://localhost:5001");
  });
});

describe("localOrigin", () => {
  it("keeps localhost and loopback addresses only", () => {
    expect(localOrigin("http://127.0.0.1:3000/x")).toBe("http://127.0.0.1:3000");
    expect(localOrigin("https://example.com")).toBeUndefined();
    expect(localOrigin("not a url")).toBeUndefined();
  });
});

describe("pageLooksLikeApp", () => {
  it("matches the brand name in the page head", () => {
    expect(pageLooksLikeApp("<html><head><title>Acme Polls</title></head></html>", "Acme Polls")).toBe(true);
    expect(pageLooksLikeApp("<html><head><title>Other App</title></head></html>", "Acme Polls")).toBe(false);
  });

  it("can't tell without a brand name, so says yes", () => {
    expect(pageLooksLikeApp("<html></html>", undefined)).toBe(true);
  });
});
