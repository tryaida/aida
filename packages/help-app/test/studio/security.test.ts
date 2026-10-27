import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  ACCESS_PAGE_SCRIPT,
  allowHostLine,
  assertStudioRequest,
  blockedStudioHost,
  getStudioToken,
  isLoopbackRequest,
  sameSecret,
  STUDIO_ACCESS_COOKIE,
  STUDIO_TOKEN_HEADER,
  studioAccess,
  studioAccessPage,
  unlockStudio,
} from "../../app/studio/_lib/security";

const KEY = "k".repeat(20) + "Abc123-_xyz0987654321QwErTy";
const SECRET_HOSTS = "secret-tunnel.example.com,dev.example.com";

/** POST /studio/access as the access page's script sends it. */
function unlock(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return unlockStudio(
    new Request("http://dev.example.com/studio/access", {
      method: "POST",
      headers: {
        host: "dev.example.com",
        origin: "https://dev.example.com",
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
        "x-forwarded-proto": "https",
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

/** The access cookie, as POST /studio/access with KEY sets it (name=value only). */
async function accessCookie(): Promise<string> {
  const res = await unlock({ key: KEY });
  return res.headers.get("set-cookie")!.split(";")[0];
}

function req(host: string, origin?: string, cookie?: string): Request {
  const headers: Record<string, string> = { host, [STUDIO_TOKEN_HEADER]: getStudioToken() };
  if (origin) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
  return new Request(`http://${host}/studio/api/walkthroughs`, { headers });
}

function cleanEnv() {
  delete process.env.AIDA_STUDIO_ALLOWED_HOSTS;
  delete process.env.AIDA_STUDIO_KEY;
}

describe("assertStudioRequest host allowlist", () => {
  afterEach(cleanEnv);

  it("accepts localhost", () => {
    expect(assertStudioRequest(req("localhost:3001", "http://localhost:3001"))).toBeNull();
  });

  it("refuses another host by default", () => {
    expect(assertStudioRequest(req("dev.example.com", "https://dev.example.com"))?.status).toBe(403);
  });

  it("accepts a host listed in AIDA_STUDIO_ALLOWED_HOSTS, case-insensitively (with the access cookie)", async () => {
    process.env.AIDA_STUDIO_ALLOWED_HOSTS = "Dev.Example.com, other.example.com";
    process.env.AIDA_STUDIO_KEY = KEY;
    expect(assertStudioRequest(req("dev.example.com", "https://dev.example.com", (await accessCookie())))).toBeNull();
  });

  it("still refuses an unlisted origin when the host is allowed", () => {
    process.env.AIDA_STUDIO_ALLOWED_HOSTS = "dev.example.com";
    expect(assertStudioRequest(req("dev.example.com", "https://evil.example.net"))?.status).toBe(403);
  });

  it("still requires the Studio token on an allowed host", () => {
    process.env.AIDA_STUDIO_ALLOWED_HOSTS = "dev.example.com";
    const r = new Request("http://dev.example.com/studio/api/walkthroughs", {
      headers: { host: "dev.example.com", origin: "https://dev.example.com", [STUDIO_TOKEN_HEADER]: "wrong" },
    });
    expect(assertStudioRequest(r)?.status).toBe(403);
  });
});

describe("blockedStudioHost (the /studio page)", () => {
  afterEach(cleanEnv);

  it("allows localhost", () => {
    expect(blockedStudioHost(new Headers({ host: "localhost:3000" }))).toBeUndefined();
    expect(blockedStudioHost(new Headers({ host: "[::1]:3000" }))).toBeUndefined();
  });

  it("names a foreign Host, without its port", () => {
    expect(blockedStudioHost(new Headers({ host: "abc.trycloudflare.com:443" }))).toBe("abc.trycloudflare.com");
  });

  it("checks X-Forwarded-Host too, when a tunnel rewrites Host to localhost", () => {
    expect(blockedStudioHost(new Headers({ host: "localhost:3000", "x-forwarded-host": "abc.ngrok.app" }))).toBe("abc.ngrok.app");
    process.env.AIDA_STUDIO_ALLOWED_HOSTS = "abc.ngrok.app";
    expect(blockedStudioHost(new Headers({ host: "localhost:3000", "x-forwarded-host": "abc.ngrok.app" }))).toBeUndefined();
  });

  it("agrees with the API check on the same allowlist", async () => {
    process.env.AIDA_STUDIO_ALLOWED_HOSTS = "dev.example.com";
    process.env.AIDA_STUDIO_KEY = KEY;
    const cookie = await accessCookie();
    expect(blockedStudioHost(new Headers({ host: "dev.example.com" }))).toBeUndefined();
    expect(assertStudioRequest(req("dev.example.com", "https://dev.example.com", cookie))).toBeNull();
    expect(blockedStudioHost(new Headers({ host: "other.example.com" }))).toBe("other.example.com");
    expect(assertStudioRequest(req("other.example.com", "https://other.example.com", cookie))?.status).toBe(403);
  });

  it("suggests a line naming only the requesting host, never the hosts already allowed", () => {
    process.env.AIDA_STUDIO_ALLOWED_HOSTS = "secret-a.example.com,secret-b.example.com";
    expect(allowHostLine("b.example.com")).toBe("AIDA_STUDIO_ALLOWED_HOSTS=b.example.com");
  });
});

describe("the /studio page", () => {
  it("never renders the allowed-hosts list", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("../../app/studio/page.tsx", import.meta.url)), "utf8");
    expect(source).not.toMatch(/process\.env\.AIDA_STUDIO_ALLOWED_HOSTS/);
  });
});

describe("Studio access key", () => {
  afterEach(cleanEnv);

  function tunnelHeaders(extra: Record<string, string> = {}): Headers {
    return new Headers({ host: "dev.example.com", "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.7", ...extra });
  }
  function accessPage(extra: Record<string, string> = {}, host = "dev.example.com"): Response {
    return studioAccessPage(new Request(`http://${host}/studio/access`, { headers: { ...Object.fromEntries(tunnelHeaders()), host, ...extra } }));
  }
  async function expectPlain403(res: Response) {
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
    const body = await res.text();
    expect(body).not.toContain(getStudioToken());
    for (const leak of ["secret-tunnel", "dev.example.com", "walkthrough", ".env.local", KEY]) expect(body).not.toContain(leak);
    return body;
  }

  it("loopback without a key is unchanged", () => {
    expect(studioAccess(new Headers({ host: "localhost:3000", "x-forwarded-for": "::1" })).ok).toBe(true);
    expect(studioAccess(new Headers({ host: "127.0.0.1:3000", "x-forwarded-for": "::ffff:127.0.0.1" })).ok).toBe(true);
    expect(assertStudioRequest(req("localhost:3000", "http://localhost:3000"))).toBeNull();
    const local = studioAccessPage(new Request("http://localhost:3000/studio/access", { headers: { host: "localhost:3000" } }));
    expect(local.status).toBe(200);
    expect(local.headers.get("set-cookie")).toBeNull();
  });

  it("treats any forwarded sign of another machine as remote", () => {
    expect(isLoopbackRequest(new Headers({ host: "localhost:3000", "x-forwarded-for": "203.0.113.7" }))).toBe(false);
    expect(isLoopbackRequest(new Headers({ host: "localhost:3000", "x-forwarded-for": "127.0.0.1, 203.0.113.7" }))).toBe(false);
    expect(isLoopbackRequest(new Headers({ host: "localhost:3000", "x-real-ip": "192.168.1.20" }))).toBe(false);
    expect(isLoopbackRequest(new Headers({ host: "localhost:3000", "cf-connecting-ip": "203.0.113.7" }))).toBe(false);
    expect(isLoopbackRequest(new Headers({ host: "localhost:3000", "x-forwarded-host": "abc.trycloudflare.com" }))).toBe(false);
    expect(isLoopbackRequest(new Headers({ host: "localhost:3000", forwarded: "for=203.0.113.7;proto=https" }))).toBe(false);
    expect(isLoopbackRequest(new Headers({ host: "localhost:3000", origin: "https://abc.trycloudflare.com" }))).toBe(false);
    expect(isLoopbackRequest(new Headers({ host: "192.168.1.5:3000", "x-forwarded-for": "127.0.0.1" }))).toBe(false);
  });

  it("with a key set, a spoofed X-Forwarded-For: 127.0.0.1 and Host localhost get nothing without the cookie", async () => {
    process.env.AIDA_STUDIO_KEY = KEY;
    const spoofed = { host: "localhost:3000", "x-forwarded-for": "127.0.0.1" };
    expect(studioAccess(new Headers(spoofed))).toEqual({ ok: false, reason: "locked" });
    // The edit API, which writes files the dev server compiles.
    const edit = new Request("http://localhost:3000/studio/api/edit", {
      method: "POST",
      headers: { ...spoofed, "content-type": "application/json", [STUDIO_TOKEN_HEADER]: getStudioToken() },
      body: "{}",
    });
    expect(assertStudioRequest(edit)?.status).toBe(403);
    // A raw TCP tunnel: no forwarded headers at all, indistinguishable from loopback.
    expect(assertStudioRequest(req("localhost:3000", "http://localhost:3000"))?.status).toBe(403);
    expect(assertStudioRequest(req("127.0.0.1:3000"))?.status).toBe(403);
    const page = studioAccessPage(new Request("http://localhost:3000/studio/access", { headers: spoofed }));
    expect(page.status).toBe(403);
    expect(page.headers.get("set-cookie")).toBeNull();
    // The local user opens the private link once, like the tunnel user.
    const res = await unlock({ key: KEY }, { host: "localhost:3000", origin: "http://localhost:3000", "x-forwarded-proto": "http", "x-forwarded-for": "127.0.0.1" });
    expect(res.status).toBe(204);
    const cookie = res.headers.get("set-cookie")!.split(";")[0];
    expect(assertStudioRequest(req("localhost:3000", "http://localhost:3000", cookie))).toBeNull();
  });

  it("with no key set, a spoofed X-Forwarded-For doesn't make a non-loopback Host local", () => {
    process.env.AIDA_STUDIO_ALLOWED_HOSTS = "dev.example.com";
    const spoofed = new Headers({ host: "dev.example.com", "x-forwarded-for": "127.0.0.1" });
    expect(studioAccess(spoofed)).toEqual({ ok: false, reason: "no-key" });
    const r = new Request("http://dev.example.com/studio/api/walkthroughs", {
      headers: { host: "dev.example.com", "x-forwarded-for": "127.0.0.1", [STUDIO_TOKEN_HEADER]: getStudioToken() },
    });
    expect(assertStudioRequest(r)?.status).toBe(403);
    expect(studioAccess(new Headers({ host: "192.168.1.5:3000", "x-forwarded-for": "::1" }))).toEqual({ ok: false, reason: "no-key" });
  });

  it("the access page refuses a tunnel host without the cookie, even when it's allowed, and says nothing about the app", async () => {
    process.env.AIDA_STUDIO_ALLOWED_HOSTS = SECRET_HOSTS;
    process.env.AIDA_STUDIO_KEY = KEY;
    expect(studioAccess(tunnelHeaders())).toEqual({ ok: false, reason: "locked" });
    const body = await expectPlain403(accessPage());
    expect(body).not.toContain("AIDA_STUDIO_KEY");
  });

  it("GET never takes a key from the query string", async () => {
    process.env.AIDA_STUDIO_KEY = KEY;
    const res = studioAccessPage(
      new Request(`http://dev.example.com/studio/access?key=${encodeURIComponent(KEY)}`, { headers: tunnelHeaders() }),
    );
    await expectPlain403(res);
    const page = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../app/studio/page.tsx", import.meta.url), "utf8"),
    );
    expect(page).not.toMatch(/searchParams|\?key=/);
  });

  it("the access page reads the key from the URL fragment and POSTs it, with a CSP that allows only that script", async () => {
    process.env.AIDA_STUDIO_KEY = KEY;
    const res = accessPage();
    const body = await res.text();
    expect(body).toContain(`<script>${ACCESS_PAGE_SCRIPT}</script>`);
    expect(ACCESS_PAGE_SCRIPT).toContain("location.hash");
    expect(ACCESS_PAGE_SCRIPT).toContain('history.replaceState(null,"",location.pathname)');
    expect(ACCESS_PAGE_SCRIPT).toContain('method:"POST"');
    expect(ACCESS_PAGE_SCRIPT).toContain('"content-type":"application/json"');
    expect(ACCESS_PAGE_SCRIPT).toContain('location.replace("/studio")');
    const csp = res.headers.get("content-security-policy")!;
    const hash = createHash("sha256").update(ACCESS_PAGE_SCRIPT).digest("base64");
    expect(csp).toContain(`script-src 'sha256-${hash}'`);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("default-src 'none'");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses a wrong key", async () => {
    process.env.AIDA_STUDIO_ALLOWED_HOSTS = SECRET_HOSTS;
    process.env.AIDA_STUDIO_KEY = KEY;
    for (const res of [await unlock({ key: "wrong" }), await unlock({ key: KEY.slice(0, -1) }), await unlock({}), await unlock("not json")]) {
      expect(res.status).toBe(403);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  it("only takes the key as a same-origin JSON POST", async () => {
    process.env.AIDA_STUDIO_KEY = KEY;
    const refused = [
      await unlock({ key: KEY }, { origin: "https://evil.example.net" }),
      await unlock({ key: KEY }, { "sec-fetch-site": "cross-site" }),
      await unlock({ key: KEY }, { "content-type": "text/plain" }),
      await unlockStudio(
        new Request("http://dev.example.com/studio/access", {
          method: "POST",
          headers: { host: "dev.example.com", "content-type": "application/json" },
          body: JSON.stringify({ key: KEY }),
        }),
      ),
    ];
    for (const res of refused) {
      expect(res.status).toBe(403);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    // A tunnel that rewrites Host to localhost: Origin matches X-Forwarded-Host.
    const viaTunnel = await unlock({ key: KEY }, { host: "localhost:3000", "x-forwarded-host": "abc.trycloudflare.com", origin: "https://abc.trycloudflare.com" });
    expect(viaTunnel.status).toBe(204);
  });

  it("the right key sets an httpOnly, SameSite=Strict, Secure cookie with a Max-Age", async () => {
    process.env.AIDA_STUDIO_KEY = KEY;
    const res = await unlock({ key: KEY });
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(new RegExp(`^${STUDIO_ACCESS_COOKIE}=[A-Za-z0-9_-]+; `));
    expect(cookie).not.toContain(KEY);
    expect(cookie).toContain("Path=/studio");
    expect(cookie).toContain("Max-Age=43200");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");
    // The cookie now opens the page check and the access page moves on to /studio.
    const opened = tunnelHeaders({ cookie: cookie.split(";")[0] });
    expect(studioAccess(opened).ok).toBe(true);
    const page = studioAccessPage(new Request("http://dev.example.com/studio/access", { headers: opened }));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<meta http-equiv="refresh" content="0;url=/studio">');
  });

  it("sets Secure unless the request came over plain-http loopback", async () => {
    process.env.AIDA_STUDIO_KEY = KEY;
    // Plain http on a non-loopback host (a proxy that terminates TLS without saying so): still Secure.
    expect((await unlock({ key: KEY }, { "x-forwarded-proto": "http" })).headers.get("set-cookie")).toContain("Secure");
    // A tunnel that rewrites Host to localhost but forwards from elsewhere: Secure.
    const tunnel = await unlock({ key: KEY }, { host: "localhost:3000", origin: "http://localhost:3000", "x-forwarded-proto": "http", "x-forwarded-for": "203.0.113.7" });
    expect(tunnel.headers.get("set-cookie")).toContain("Secure");
    // https to localhost: Secure.
    const https = await unlock({ key: KEY }, { host: "localhost:3000", origin: "https://localhost:3000", "x-forwarded-proto": "https", "x-forwarded-for": "127.0.0.1" });
    expect(https.headers.get("set-cookie")).toContain("Secure");
    // Plain http on loopback: not Secure (the browser would drop it on some setups).
    const local = await unlock({ key: KEY }, { host: "localhost:3000", origin: "http://localhost:3000", "x-forwarded-proto": "http", "x-forwarded-for": "127.0.0.1" });
    expect(local.headers.get("set-cookie")).not.toContain("Secure");
  });

  it("API calls without the cookie get 403, with it they pass", async () => {
    process.env.AIDA_STUDIO_ALLOWED_HOSTS = SECRET_HOSTS;
    process.env.AIDA_STUDIO_KEY = KEY;
    expect(assertStudioRequest(req("dev.example.com", "https://dev.example.com"))?.status).toBe(403);
    expect(assertStudioRequest(req("dev.example.com", "https://dev.example.com", `${STUDIO_ACCESS_COOKIE}=forged`))?.status).toBe(403);
    expect(assertStudioRequest(req("dev.example.com", "https://dev.example.com", `other=1; ${await accessCookie()}`))).toBeNull();
  });

  it("a cookie stops working when the key changes", async () => {
    process.env.AIDA_STUDIO_ALLOWED_HOSTS = SECRET_HOSTS;
    process.env.AIDA_STUDIO_KEY = KEY;
    const cookie = await accessCookie();
    process.env.AIDA_STUDIO_KEY = KEY + "-rotated";
    expect(assertStudioRequest(req("dev.example.com", "https://dev.example.com", cookie))?.status).toBe(403);
  });

  it("with no AIDA_STUDIO_KEY, refuses every non-loopback host, listed or not", async () => {
    process.env.AIDA_STUDIO_ALLOWED_HOSTS = SECRET_HOSTS;
    expect(studioAccess(tunnelHeaders())).toEqual({ ok: false, reason: "no-key" });
    expect(assertStudioRequest(req("dev.example.com", "https://dev.example.com"))?.status).toBe(403);
    const body = await expectPlain403(accessPage());
    expect(body).toContain("set AIDA_STUDIO_KEY (run aida init --tunnel-host again)");
    expect((await unlock({ key: "anything" })).status).toBe(403);
    // A too-short key counts as unset.
    process.env.AIDA_STUDIO_KEY = "short";
    expect(studioAccess(tunnelHeaders())).toEqual({ ok: false, reason: "no-key" });
  });
});

describe("Studio token comparison", () => {
  afterEach(cleanEnv);

  it("sameSecret compares in constant time, any lengths", () => {
    expect(sameSecret("abc", "abc")).toBe(true);
    expect(sameSecret("abc", "abd")).toBe(false);
    expect(sameSecret("abc", "abcd")).toBe(false);
    expect(sameSecret("", getStudioToken())).toBe(false);
  });

  it("assertStudioRequest checks the token with sameSecret, not !==", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../../app/studio/_lib/security.ts", import.meta.url), "utf8");
    expect(source).toMatch(/sameSecret\(request\.headers\.get\(STUDIO_TOKEN_HEADER\) \?\? "", getStudioToken\(\)\)/);
    expect(source).not.toMatch(/!==\s*getStudioToken\(\)/);
    expect(source).toMatch(/timingSafeEqual/);
  });

  it("refuses a missing or wrong token on localhost", () => {
    const r = (token?: string) =>
      new Request("http://localhost:3000/studio/api/walkthroughs", {
        headers: { host: "localhost:3000", ...(token === undefined ? {} : { [STUDIO_TOKEN_HEADER]: token }) },
      });
    expect(assertStudioRequest(r())?.status).toBe(403);
    expect(assertStudioRequest(r(getStudioToken().slice(0, -1)))?.status).toBe(403);
    expect(assertStudioRequest(r(getStudioToken()))).toBeNull();
  });
});

describe("the /studio page access gate", () => {
  it("checks access before rendering the token or the blocked-host notice", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("../../app/studio/page.tsx", import.meta.url)), "utf8");
    const gate = source.indexOf("if (!studioAccess(requestHeaders).ok) redirect(STUDIO_ACCESS_PATH)");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(source.indexOf("blockedStudioHost(requestHeaders)"));
    expect(gate).toBeLessThan(source.indexOf("getStudioToken()"));
  });
});

describe("the help app's dev script", () => {
  it("binds the dev server to loopback", async () => {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts.dev).toBe("next dev -H 127.0.0.1");
  });
});
