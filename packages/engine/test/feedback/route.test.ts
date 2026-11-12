import { describe, expect, it } from "vitest";
import type { FeedbackEntry } from "../../src/feedback/entry.js";
import {
  FeedbackRateLimiter,
  clientIdFromHeaders,
  handleFeedbackOptions,
  handleFeedbackPost,
  type FeedbackRouteOptions,
} from "../../src/feedback/route.js";
import type { FeedbackStore } from "../../src/feedback/store.js";

class MemoryStore implements FeedbackStore {
  entries: FeedbackEntry[] = [];
  record(entry: FeedbackEntry): void {
    this.entries.push(entry);
  }
}

const APP_ORIGIN = "https://app.example.com";

function options(over: Partial<FeedbackRouteOptions> = {}): FeedbackRouteOptions & { store: MemoryStore } {
  return {
    enabled: true,
    allowedOrigins: [APP_ORIGIN],
    limiter: new FeedbackRateLimiter(20, 300),
    // No hosting platform detected unless a test says so.
    env: {},
    now: () => new Date("2026-11-11T09:30:00Z"),
    ...over,
    store: (over.store as MemoryStore | undefined) ?? new MemoryStore(),
  };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://help.example.com/api/feedback", {
    method: "POST",
    headers: { host: "help.example.com", "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("handleFeedbackPost", () => {
  it("stores a valid same-origin vote and answers 204 with no body", async () => {
    const opts = options();
    const res = await handleFeedbackPost(post({ kind: "helpful", page: "/billing" }, { origin: "https://help.example.com" }), opts);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(opts.store.entries).toEqual([{ kind: "helpful", page: "/billing", at: "2026-11-11" }]);
  });

  it("stores nothing identifying: no IP, cookie, user agent or user id reaches the store", async () => {
    const opts = options();
    await handleFeedbackPost(
      post(
        { kind: "no-results", query: "refund for sam@acme-mail.net", currentPath: "/users/4242/orders" },
        {
          "x-forwarded-for": "198.51.100.7",
          "x-real-ip": "198.51.100.7",
          cookie: "session=s3cr3t-session-value",
          "user-agent": "Mozilla/5.0 (Acme)",
          authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
          origin: APP_ORIGIN,
        },
      ),
      opts,
    );
    expect(opts.store.entries).toHaveLength(1);
    const stored = JSON.stringify(opts.store.entries);
    expect(stored).not.toMatch(/198\.51\.100\.7|s3cr3t|Mozilla|Bearer|sam@acme-mail|4242/);
    expect(Object.keys(opts.store.entries[0]).sort()).toEqual(["at", "currentPath", "kind", "query"]);
  });

  it("allows an allowlisted app origin and sends CORS headers for it", async () => {
    const res = await handleFeedbackPost(post({ kind: "no-results", query: "x" }, { origin: APP_ORIGIN }), options());
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
  });

  it("refuses any other origin without storing anything", async () => {
    const opts = options();
    const res = await handleFeedbackPost(post({ kind: "helpful", page: "/a" }, { origin: "https://evil.example.net" }), opts);
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(opts.store.entries).toEqual([]);
  });

  it("refuses a malformed origin", async () => {
    expect((await handleFeedbackPost(post({ kind: "helpful", page: "/a" }, { origin: "null" }), options())).status).toBe(403);
  });

  describe("behind a proxy that rewrites Host", () => {
    // nginx's default: the app sees its upstream address as Host, not the public name.
    const proxied = (headers: Record<string, string>) =>
      new Request("http://127.0.0.1:3000/api/feedback", {
        method: "POST",
        headers: { host: "127.0.0.1:3000", "content-type": "application/json", origin: "https://help.example.com", ...headers },
        body: JSON.stringify({ kind: "helpful", page: "/a" }),
      });

    it("takes the help site's own posts by the browser's Sec-Fetch-Site", async () => {
      expect((await handleFeedbackPost(proxied({ "sec-fetch-site": "same-origin" }), options())).status).toBe(204);
    });

    it("takes them by the configured site origin when the browser sends no Sec-Fetch-Site", async () => {
      expect((await handleFeedbackPost(proxied({}), options({ siteOrigin: "https://help.example.com" }))).status).toBe(204);
      expect((await handleFeedbackPost(proxied({}), options())).status).toBe(403);
    });

    it("never trusts X-Forwarded-Host, which any client can send", async () => {
      const spoof = new Request("http://127.0.0.1:3000/api/feedback", {
        method: "POST",
        headers: { host: "127.0.0.1:3000", "content-type": "application/json", origin: "https://evil.example.net", "x-forwarded-host": "evil.example.net" },
        body: JSON.stringify({ kind: "helpful", page: "/a" }),
      });
      expect((await handleFeedbackPost(spoof, options())).status).toBe(403);
      expect((await handleFeedbackPost(proxied({ "x-forwarded-host": "help.example.com" }), options())).status).toBe(403);
    });

    it("refuses a cross-site browser post even when the site origin is configured", async () => {
      const res = await handleFeedbackPost(
        post({ kind: "helpful", page: "/a" }, { origin: "https://evil.example.net", "sec-fetch-site": "cross-site" }),
        options({ siteOrigin: "https://help.example.com" }),
      );
      expect(res.status).toBe(403);
    });
  });

  it("answers 404 and stores nothing when the owner turned feedback off", async () => {
    const opts = options({ enabled: false });
    const res = await handleFeedbackPost(post({ kind: "helpful", page: "/a" }), opts);
    expect(res.status).toBe(404);
    expect(opts.store.entries).toEqual([]);
    expect(handleFeedbackOptions(new Request("https://help.example.com/api/feedback", { method: "OPTIONS" }), { enabled: false, allowedOrigins: [] }).status).toBe(404);
  });

  it("ignores client-set address headers when no platform is detected: rotating X-Real-IP buys nothing", async () => {
    const opts = options({ limiter: new FeedbackRateLimiter(2, 5) });
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await handleFeedbackPost(
        post({ kind: "helpful", page: "/a" }, { "x-real-ip": `198.51.100.${i}`, "x-vercel-forwarded-for": `203.0.113.${i}`, "x-forwarded-for": `192.0.2.${i}` }),
        opts,
      );
      statuses.push(res.status);
    }
    // Unidentified clients share the overall budget; ten fresh "addresses" don't get ten buckets.
    expect(statuses.filter((s) => s === 204)).toHaveLength(5);
    expect(opts.store.entries).toHaveLength(5);
  });

  it("limits each client by the detected platform's own header, whatever else the client sends", async () => {
    const opts = options({ limiter: new FeedbackRateLimiter(2, 300), env: { NETLIFY: "true" } });
    const send = (real: string, spoof: string) =>
      handleFeedbackPost(post({ kind: "helpful", page: "/a" }, { "x-nf-client-connection-ip": real, "x-real-ip": spoof }), opts);
    expect((await send("198.51.100.7", "1.1.1.1")).status).toBe(204);
    expect((await send("198.51.100.7", "1.1.1.2")).status).toBe(204);
    expect((await send("198.51.100.7", "1.1.1.3")).status).toBe(429);
    expect((await send("198.51.100.8", "1.1.1.4")).status).toBe(204);
    expect(opts.store.entries).toHaveLength(3);
  });

  it("uses its own budgets, lower than the chat's, when none are passed", async () => {
    const opts = options({ limiter: undefined, env: { VERCEL: "1" } });
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      statuses.push((await handleFeedbackPost(post({ kind: "helpful", page: "/a" }, { "x-vercel-forwarded-for": "203.0.113.250" }), opts)).status);
    }
    expect(statuses.filter((s) => s === 204)).toHaveLength(10);
  });

  it("accepts JSON only", async () => {
    const res = await handleFeedbackPost(post(JSON.stringify({ kind: "helpful", page: "/a" }), { "content-type": "text/plain" }), options());
    expect(res.status).toBe(415);
  });

  it("refuses a body whose declared length is over the cap without reading it", async () => {
    const opts = options();
    const res = await handleFeedbackPost(post({ kind: "helpful", page: "/a" }, { "content-length": "5000" }), opts);
    expect(res.status).toBe(413);
    expect(opts.store.entries).toEqual([]);
  });

  it("stops reading a chunked body with no Content-Length as soon as it passes the cap", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 80) controller.close(); // 5 MB in all
        else controller.enqueue(chunk);
      },
    });
    const request = new Request("https://help.example.com/api/feedback", {
      method: "POST",
      headers: { host: "help.example.com", "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(request.headers.get("content-length")).toBeNull();
    const opts = options();
    const res = await handleFeedbackPost(request, opts);
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(3);
    expect(opts.store.entries).toEqual([]);
  });

  it("takes a chunked body under the cap", async () => {
    const text = JSON.stringify({ kind: "no-results", query: "export invoices" });
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 10));
        controller.enqueue(bytes.slice(10));
        controller.close();
      },
    });
    const opts = options();
    const res = await handleFeedbackPost(
      new Request("https://help.example.com/api/feedback", { method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half" } as RequestInit),
      opts,
    );
    expect(res.status).toBe(204);
    expect(opts.store.entries).toHaveLength(1);
  });

  it("answers 400 for bad JSON and invalid entries without echoing them", async () => {
    const bad = await handleFeedbackPost(post("{nope sam@acme-mail.net"), options());
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain("sam@acme-mail.net");
    const invalid = await handleFeedbackPost(post({ kind: "helpful", page: "/a", note: "sam@acme-mail.net" }), options());
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain("sam@acme-mail.net");
  });

  it("answers 500 when the store fails, without the error text", async () => {
    const store = { record: () => Promise.reject(new Error("EROFS: /var/task/.aida sam@acme-mail.net")) } as unknown as MemoryStore;
    const res = await handleFeedbackPost(post({ kind: "helpful", page: "/a" }), options({ store }));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toMatch(/EROFS|sam@acme/);
  });
});

describe("handleFeedbackOptions", () => {
  it("answers a preflight from an allowlisted origin with CORS headers, others without", () => {
    const pre = (origin: string) =>
      handleFeedbackOptions(new Request("https://help.example.com/api/feedback", { method: "OPTIONS", headers: { origin } }), {
        enabled: true,
        allowedOrigins: [APP_ORIGIN],
      });
    expect(pre(APP_ORIGIN).headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(pre("https://evil.example.net").headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("clientIdFromHeaders", () => {
  it("trusts the owner's configured header first (the last X-Forwarded-For hop, the one their proxy added)", () => {
    expect(clientIdFromHeaders(new Headers({ "x-client": "203.0.113.1, 10.0.0.1" }), "x-client", {})).toBe("203.0.113.1");
    expect(clientIdFromHeaders(new Headers({ "x-forwarded-for": "1.1.1.1, 203.0.113.3" }), "x-forwarded-for", {})).toBe("203.0.113.3");
  });

  it("reads a platform's header only on that platform", () => {
    const headers = new Headers({ "x-vercel-forwarded-for": "203.0.113.4", "x-real-ip": "203.0.113.5", "x-nf-client-connection-ip": "203.0.113.6", "cf-connecting-ip": "203.0.113.7" });
    expect(clientIdFromHeaders(headers, undefined, { VERCEL: "1" })).toBe("203.0.113.4");
    expect(clientIdFromHeaders(headers, undefined, { NETLIFY: "true" })).toBe("203.0.113.6");
    expect(clientIdFromHeaders(headers, undefined, { CF_PAGES: "1" })).toBe("203.0.113.7");
    expect(clientIdFromHeaders(headers, undefined, {})).toBeUndefined();
  });

  it("never takes a bare X-Forwarded-For or X-Real-IP as identity", () => {
    expect(clientIdFromHeaders(new Headers({ "x-real-ip": "203.0.113.2", "x-forwarded-for": "1.1.1.1, 203.0.113.3" }), undefined, {})).toBeUndefined();
  });
});
