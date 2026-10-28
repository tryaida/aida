// `aida theme --from-app` (M34): reads the brand off fixture pages of a fictional app ("Acme
// Events") served locally — computed colours of the nav and the main button, radius, shadows,
// density, the app's name, the logo rendered to a transparent PNG, the linked icon — read-only.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { brandFromRunningApp } from "../../src/commands/init.js";
import { publicBaseUrl, runThemeCommand } from "../../src/commands/theme.js";
import { readAppBrand } from "../../src/theme/app-brand.js";
import { sameColor } from "../../src/theme/color.js";
import {
  appPageUrl,
  brandFromSamples,
  isPng,
  normalizeFamily,
  pickFont,
  readBrandFromApp,
  shadowKind,
  type AppStyleSample,
} from "../../src/theme/from-app.js";

const page = (title: string, main: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title} · Acme Events</title>
<link rel="apple-touch-icon" sizes="180x180" href="/icon.png">
<style>
  body { margin: 0; font-family: "Acme Sans", system-ui, sans-serif; background: #f8fafc; color: #0f172a; display: flex; }
  aside { width: 240px; min-height: 100vh; background: #1e1b4b; color: #e0e7ff; padding: 16px; box-sizing: border-box; }
  aside a.home { display: flex; align-items: center; gap: 10px; color: #fff; text-decoration: none; font-weight: 800; font-size: 18px; }
  aside nav a { display: block; color: #c7d2fe; padding: 8px 10px; border-radius: 8px; text-decoration: none; margin-top: 4px; }
  aside nav a[aria-current="page"] { background: #0d9488; color: #fff; }
  main { flex: 1; padding: 32px; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08); padding: 20px; margin-bottom: 16px; min-height: 120px; }
  .btn { display: inline-block; height: 38px; line-height: 38px; padding: 0 16px; border-radius: 8px; border: 0; background: #4f46e5; color: #fff; font: 600 14px "Acme Sans", system-ui; }
  .btn.ghost { background: transparent; color: #334155; }
  input { height: 38px; border: 1px solid #cbd5e1; border-radius: 8px; padding: 0 10px; }
</style></head><body>
<aside><a class="home" href="/"><svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true"><rect width="28" height="28" rx="7" fill="#818cf8"/><path d="M8 19l6-11 6 11z" fill="#fff"/></svg><span>Acme Events</span></a>
<nav><a href="/" ${title === "Dashboard" ? 'aria-current="page"' : ""}>Dashboard</a><a href="/orders" ${title === "Orders" ? 'aria-current="page"' : ""}>Orders</a></nav></aside>
<main><h1>${title}</h1>${main}</main>
<script>fetch("/api/track", { method: "POST", body: "{}" }).catch(() => {});</script>
</body></html>`;

const DASHBOARD = page("Dashboard", `<div class="card"><button class="btn">New event</button> <button class="btn ghost">Cancel</button></div><div class="card"><input placeholder="Search"></div>`);
const ORDERS = page("Orders", `<div class="card"><button class="btn">Add order</button><button class="btn">Export</button></div><div class="card"><input placeholder="Customer"></div>`);

function iconPng(): Buffer {
  const png = new PNG({ width: 180, height: 180 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 79;
    png.data[i + 1] = 70;
    png.data[i + 2] = 229;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

let server: Server;
let baseUrl: string;
const writes: string[] = [];

beforeAll(async () => {
  const icon = iconPng();
  server = createServer((req, res) => {
    if (req.method !== "GET") {
      writes.push(`${req.method} ${req.url}`);
      res.end("{}");
      return;
    }
    if (req.url === "/away") {
      res.statusCode = 302;
      res.setHeader("location", baseUrl.replace("127.0.0.1", "localhost") + "/");
      res.end();
      return;
    }
    if (req.url === "/mark.svg") {
      res.setHeader("content-type", "image/svg+xml");
      res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><circle cx="5" cy="5" r="5" fill="#4f46e5"/></svg>');
      return;
    }
    if (req.url === "/plain") {
      res.setHeader("content-type", "text/html");
      res.end('<!doctype html><html><head><title>Plain · Acme Events</title><link rel="icon" href="/mark.svg"></head><body><main><button style="background:#4f46e5;color:#fff;height:36px">Go</button></main></body></html>');
      return;
    }
    if (req.url === "/wrapped") {
      // shadcn's layout: a full-page "sidebar-wrapper" around the sidebar and the page.
      res.setHeader("content-type", "text/html");
      res.end('<!doctype html><html><head><title>Acme Events</title></head><body style="margin:0"><div class="group/sidebar-wrapper" style="display:flex;min-height:100vh"><aside style="width:220px">Menu</aside><main><button style="background:#0d9488;color:#fff;height:36px;padding:0 16px">New order</button></main></div></body></html>');
      return;
    }
    if (req.url === "/menu-only" || req.url === "/covered") {
      // No logo: only a menu item that links home with an icon. "/covered" also has the real
      // logo, but under a dialog's overlay.
      res.setHeader("content-type", "text/html");
      const logo = req.url === "/covered" ? '<a href="/" class="brand-logo"><svg width="40" height="24" aria-label="Acme logo"><rect width="40" height="24" fill="#4f46e5"/></svg></a>' : "";
      const overlay = req.url === "/covered" ? '<div style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10"></div>' : "";
      res.end(`<!doctype html><html><head><title>Acme Events</title></head><body style="margin:0"><aside style="width:220px">${logo}<nav><ul><li><a href="/"><svg width="18" height="18"><circle cx="9" cy="9" r="8" fill="#999"/></svg><span>Home</span></a></li></ul></nav></aside><main><button style="background:#4f46e5;color:#fff;height:36px">Go</button></main>${overlay}</body></html>`);
      return;
    }
    if (req.url === "/login") {
      res.setHeader("content-type", "text/html");
      res.end("<!doctype html><title>Sign in</title><form><input name=email><button>Sign in</button></form>");
      return;
    }
    if (req.url === "/icon.png") {
      res.setHeader("content-type", "image/png");
      res.end(icon);
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(req.url === "/orders" ? ORDERS : DASHBOARD);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("reading the brand off the running app", () => {
  it("reads colours, shape, density, name, logo and icon from two pages, and writes nothing to the app", async () => {
    const assetsDir = mkdtempSync(join(tmpdir(), "aida-from-app-"));
    const blocked: string[] = [];
    const r = await readBrandFromApp({ baseUrl, pages: ["/", "/orders"], assetsDir, onBlocked: (m, u) => blocked.push(`${m} ${u}`) });

    expect(sameColor(r.brand.primaryColor!, "#4f46e5")).toBe(true);
    expect(sameColor(r.brand.colors!.primaryForeground!, "#ffffff")).toBe(true);
    // The active nav item is the app's second colour; the dark sidebar itself isn't "brandish".
    expect(sameColor(r.brand.accentColor!, "#0d9488")).toBe(true);
    expect(sameColor(r.brand.colors!.background!, "#f8fafc")).toBe(true);
    expect(r.brand.radius).toBe("12px");
    expect(r.brand.shadow).toBe("soft");
    expect(r.brand.density).toBe("regular");
    expect(r.brand.name).toBe("Acme Events");

    // Logo drawn on the dark sidebar: the dark-background logo, transparent around the artwork.
    expect(r.assets.logoDark).toBeDefined();
    const logo = PNG.sync.read(readFileSync(r.assets.logoDark!));
    let transparent = 0;
    for (let i = 3; i < logo.data.length; i += 4) if (logo.data[i] === 0) transparent++;
    expect(transparent).toBeGreaterThan(0);
    expect(logo.width).toBeGreaterThan(100); // device scale 2
    // The linked 180px icon beats a screenshot of the mark.
    expect(r.assets.icon).toMatch(/from-app-icon\.png$/);
    expect(PNG.sync.read(readFileSync(r.assets.icon!)).width).toBe(180);

    // Read-only: the page's own POST never reached the app.
    expect(writes).toEqual([]);
    expect(blocked.some((b) => b.startsWith("POST"))).toBe(true);
  }, 60_000);

  it("theme --from-app saves brand/from-app.json and the theme files take it, under explicit config values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aida-from-app-cmd-"));
    mkdirSync(join(dir, "walkthroughs"));
    writeFileSync(
      join(dir, "aida.config.mjs"),
      `export default { app: { baseUrl: ${JSON.stringify(baseUrl)} }, walkthroughsDir: "./walkthroughs", buildDir: "./.build", brand: { name: "Acme", accentColor: "#f59e0b" } };\n`,
    );
    const out = await runThemeCommand({ config: join(dir, "aida.config.mjs"), fromApp: true, pages: ["/"] });
    expect(out.mode).toBe("from-app");
    if (out.mode !== "from-app") return;
    expect(existsSync(join(dir, "brand", "from-app.json"))).toBe(true);
    expect(out.fromApp).toContain("primary");
    expect(out.fromApp).not.toContain("accent"); // the config's own accent wins
    expect(out.fromApp).not.toContain("name");
    expect(out.style.style).toBe("friendly");
    const css = readFileSync(join(dir, "app", "brand.css"), "utf8");
    expect(css).toMatch(/--brand-primary/);
    const brandJson = JSON.parse(readFileSync(join(dir, "lib", "brand.json"), "utf8"));
    expect(brandJson.name).toBe("Acme");
    expect(brandJson.logoDark).toMatch(/^\/brand\/logo-dark\.png$/);
  }, 60_000);
});

describe("from-app safety (M34 review)", () => {
  it("rasterises an app's SVG icon to a PNG and never keeps the SVG", async () => {
    const assetsDir = mkdtempSync(join(tmpdir(), "aida-from-app-svg-"));
    const r = await readBrandFromApp({ baseUrl, pages: ["/plain"], assetsDir });
    expect(r.assets.icon).toMatch(/from-app-icon\.png$/);
    expect(isPng(readFileSync(r.assets.icon!))).toBe(true);
    expect(existsSync(join(assetsDir, "from-app-icon.svg"))).toBe(false);
  }, 60_000);

  it("only opens pages on the app, never follows a redirect off it, never reads the sign-in page", async () => {
    expect(() => appPageUrl(baseUrl, "//evil.example.com/x")).toThrow(/isn't on the app/);
    expect(() => appPageUrl(baseUrl, "https://evil.example.com/")).toThrow(/isn't on the app/);
    expect(appPageUrl(baseUrl + "/", "/orders")).toBe(`${baseUrl}/orders`);
    await expect(readBrandFromApp({ baseUrl, pages: ["/away"] })).rejects.toThrow();
    await expect(readBrandFromApp({ baseUrl, pages: ["/login"], isSignInPath: (u) => /\/login/.test(u) })).rejects.toThrow(/sign-in page/);
  }, 60_000);

  it("masks before rendering the logo (capture's mask.selectors)", async () => {
    const plain = await readBrandFromApp({ baseUrl, pages: ["/"], assetsDir: mkdtempSync(join(tmpdir(), "aida-mask-a-")) });
    const masked = await readBrandFromApp({ baseUrl, pages: ["/"], assetsDir: mkdtempSync(join(tmpdir(), "aida-mask-b-")), mask: { selectors: [".home span"] } });
    expect(readFileSync(masked.assets.logoDark!).equals(readFileSync(plain.assets.logoDark!))).toBe(false);
  }, 60_000);

  it("stores the base URL without credentials, query or fragment", () => {
    expect(publicBaseUrl("http://user:secret@localhost:3000/app/?token=x#y")).toBe("http://localhost:3000/app");
  });

  it("init probes the URL its config uses, then reads the brand from it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aida-init-probe-"));
    mkdirSync(join(dir, "walkthroughs"));
    const file = join(dir, "aida.config.mjs");
    writeFileSync(file, `export default { app: { baseUrl: ${JSON.stringify(`${baseUrl.replace("127.0.0.1", "user:pw@127.0.0.1")}`)} }, walkthroughsDir: "./walkthroughs", buildDir: "./.build" };\n`);
    const out = await brandFromRunningApp({ config: { file, written: true } } as never, { appUrl: "http://127.0.0.1:9" });
    expect(out?.saved).toBe(join(dir, "brand", "from-app.json"));
    expect(readAppBrand(dir)?.source.baseUrl).toBe(baseUrl);
  }, 60_000);
});

describe("logo pick", () => {
  it("never takes a menu item that links home as the logo", async () => {
    const r = await readBrandFromApp({ baseUrl, pages: ["/menu-only"], assetsDir: mkdtempSync(join(tmpdir(), "aida-menu-")) });
    expect(r.assets.logo).toBeUndefined();
  }, 60_000);

  it("skips a logo covered by an overlay", async () => {
    const r = await readBrandFromApp({ baseUrl, pages: ["/covered"], assetsDir: mkdtempSync(join(tmpdir(), "aida-covered-")) });
    expect(r.assets.logo).toBeUndefined();
  }, 60_000);
});

describe("layout wrappers", () => {
  it("doesn't take a page-sized sidebar wrapper for the nav, so its buttons still count", async () => {
    const r = await readBrandFromApp({ baseUrl, pages: ["/wrapped"], assetsDir: mkdtempSync(join(tmpdir(), "aida-wrapped-")) });
    expect(r.brand.primaryColor).toBeDefined();
  }, 60_000);
});

describe("titleName", () => {
  it("takes the part every page shares", async () => {
    const { titleName } = await import("../../src/theme/from-app.js");
    expect(titleName([{ title: "Acme | Orders" }, { title: "Acme | Customers" }])).toBe("Acme");
  });

  it("takes the part that isn't the page's heading", async () => {
    const { titleName } = await import("../../src/theme/from-app.js");
    expect(titleName([{ title: "Polls - Acme", heading: "Polls" }])).toBe("Acme");
    expect(titleName([{ title: "Acme - Polls", heading: "Polls" }])).toBe("Acme");
  });

  it("falls back to the last part, or the whole title", async () => {
    const { titleName } = await import("../../src/theme/from-app.js");
    expect(titleName([{ title: "Orders · Acme" }])).toBe("Acme");
    expect(titleName([{ title: "Acme" }])).toBe("Acme");
    expect(titleName([])).toBeUndefined();
  });
});

describe("pure readings", () => {
  it("normalises next/font family names and skips its fallbacks", () => {
    expect(normalizeFamily("__Inter_d65c78")).toBe("Inter");
    expect(normalizeFamily("__Plus_Jakarta_Sans_3a9f2e")).toBe("Plus Jakarta Sans");
    expect(normalizeFamily("__Inter_Fallback_d65c78")).toBeUndefined();
    expect(normalizeFamily('"Geist"')).toBe("Geist");
  });

  it("picks the font the page actually loaded, never a system one", () => {
    expect(pickFont('"Acme Sans", "Inter", system-ui', ["Inter"])).toBe("Inter");
    expect(pickFont("__Inter_d65c78, __Inter_Fallback_d65c78, sans-serif", ["__Inter_d65c78"])).toBe("Inter");
    expect(pickFont('-apple-system, "Segoe UI", Roboto, sans-serif', [])).toBeUndefined();
  });

  it("classifies shadows", () => {
    expect(shadowKind(["none", "none", "rgba(0, 0, 0, 0.1) 0px 1px 3px 0px"])).toBe("none");
    expect(shadowKind(["rgba(0, 0, 0, 0.1) 0px 1px 3px 0px", "rgba(0, 0, 0, 0.05) 0px 1px 2px 0px"])).toBe("soft");
    expect(shadowKind(["rgba(0, 0, 0, 0.25) 0px 20px 25px -5px"])).toBe("strong");
    expect(shadowKind(["rgb(226, 232, 240) 0px 0px 0px 1px"])).toBe("none");
  });

  it("takes a near-black button as primary in a neutral app", () => {
    const sample: AppStyleSample = {
      url: "http://x/",
      title: "Acme",
      body: { bg: "#ffffff", color: "#09090b", fontFamily: "system-ui" },
      loadedFamilies: [],
      buttons: [
        { bg: "#18181b", color: "#fafafa", radius: 6, shadow: "none", height: 36, area: 4000, fontFamily: "system-ui" },
        { bg: "#f4f4f5", color: "#18181b", radius: 6, shadow: "none", height: 36, area: 4000, fontFamily: "system-ui" },
      ],
      cards: [],
      inputs: [],
      icons: [],
    };
    const { brand } = brandFromSamples([sample]);
    expect(sameColor(brand.primaryColor!, "#18181b")).toBe(true);
    expect(brand.accentColor).toBeUndefined();
    expect(brand.radius).toBe("6px");
    expect(brand.name).toBe("Acme");
  });
});
