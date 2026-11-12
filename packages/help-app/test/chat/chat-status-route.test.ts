// `GET /api/chat`: the in-app widget (public/widget.js) reads it before it offers a chat tab.
// `available` must be false without the owner's key, never cached, and only readable from an
// origin chat itself would answer (the same allow-list as POST).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The route reads the brand through the app's `@/` alias, which the repo's test runner doesn't
// map; only `brand.name` matters to it.
vi.mock("@/lib/brand", () => ({ brand: { name: "Help" } }));

const ALLOWED = "https://app.example.com";
let dir = "";
let GET: (request: Request) => Promise<Response>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "aida-chat-status-"));
  mkdirSync(join(dir, "public"), { recursive: true });
  writeFileSync(join(dir, "public", "chat-config.json"), JSON.stringify({ model: "claude-haiku-4-5", allowedOrigins: [ALLOWED] }));
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  ({ GET } = await import("../../app/api/chat/route"));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function request(origin?: string): Request {
  return new Request("https://help.example.com/api/chat", { method: "GET", headers: origin ? { Origin: origin } : {} });
}

describe("GET /api/chat", () => {
  it("says chat isn't available without the owner's key, and isn't cached", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const res = await GET(request(ALLOWED));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("says it is available with the key, to an allowed origin", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test-not-a-real-key");
    const res = await GET(request(ALLOWED));
    expect(await res.json()).toEqual({ available: true });
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    expect(res.headers.get("vary")).toBe("Origin");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("gives an origin chat wouldn't answer nothing the browser lets it read", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test-not-a-real-key");
    for (const origin of ["https://evil.example.com", "null", undefined]) {
      const res = await GET(request(origin));
      expect(res.headers.get("access-control-allow-origin"), String(origin)).toBeNull();
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });
});
