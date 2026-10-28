// Reads the brand from the running app (`aida theme --from-app`, decision 35): opens a couple of
// pages signed in, the way `aida inspect` does (the config's sign-in adapter, the saved session,
// every non-GET request blocked), and reads what the app actually draws — computed colours of the
// nav and primary button, the fonts the page really loaded, corner radius, shadows, density — and
// the logo as drawn (rendered to a transparent PNG) plus an icon. Repo detection (init/brand.ts)
// misses logos drawn as components and colours set at runtime; this sees the result.
//
// The in-page part is a plain script (no DOM types in this package); the rest is pure functions
// over its samples, unit-tested with fixture pages.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import type { BrandConfig } from "../config/types.js";
import { applyMasks, clearMasks } from "../capture/mask.js";
import { NAME_SHIM_SCRIPT } from "../capture/init-scripts.js";
import { gotoReady } from "../capture/page-ready.js";
import { formatHsl, parseColor, rgbToHsl } from "./color.js";

/** One page's raw readings (all colours already `#rrggbb` or `#rrggbbaa`). */
export interface AppStyleSample {
  url: string;
  title: string;
  siteName?: string;
  body: { bg: string; color: string; fontFamily: string };
  headingFontFamily?: string;
  /** The page's first visible h1/h2 text, to tell the page's own name from the app's in the title. */
  heading?: string;
  /** Families `document.fonts` reports as loaded. */
  loadedFamilies: string[];
  nav?: { bg: string; color: string; activeBg?: string };
  buttons: { bg: string; color: string; radius: number; shadow: string; height: number; area: number; fontFamily: string }[];
  cards: { radius: number; shadow: string; borderColor?: string; bg: string }[];
  inputs: { height: number; borderColor: string; radius: number }[];
  logo?: { text: string; alt: string; onDark: boolean; hasMark: boolean; w: number; h: number };
  icons: { href: string; rel: string; sizes: string }[];
}

/**
 * Runs in the page. Marks the logo with `data-aida-logo` (and its graphic with `data-aida-mark`)
 * so the caller can screenshot them; touches nothing else.
 */
export const APP_STYLE_SCRIPT = String.raw`(() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const hex = (c) => {
    if (!c || c === 'transparent') return '#00000000';
    cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    const h = (n) => n.toString(16).padStart(2, '0');
    return '#' + h(d[0]) + h(d[1]) + h(d[2]) + (d[3] < 255 ? h(d[3]) : '');
  };
  const alpha = (c) => { const s = hex(c); return s.length === 9 ? parseInt(s.slice(7), 16) / 255 : 1; };
  const visible = (el) => {
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.1 &&
      r.bottom > 0 && r.right > 0 && r.top < innerHeight * 2 && r.left < innerWidth;
  };
  const effBg = (el) => {
    for (let e = el; e; e = e.parentElement) { const b = getComputedStyle(e).backgroundColor; if (alpha(b) > 0.5) return hex(b); }
    return hex(getComputedStyle(document.body).backgroundColor) === '#00000000' ? '#ffffff' : hex(getComputedStyle(document.body).backgroundColor);
  };
  const lum = (h) => { const n = parseInt(h.slice(1, 7), 16); const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255; return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const body = getComputedStyle(document.body);
  const out = {
    url: location.href, title: document.title,
    siteName: document.querySelector('meta[property="og:site_name"]')?.getAttribute('content') || undefined,
    body: { bg: effBg(document.body), color: hex(body.color), fontFamily: body.fontFamily },
    loadedFamilies: [], buttons: [], cards: [], inputs: [], icons: [],
  };
  try { document.fonts.forEach((f) => { if (f.status === 'loaded') out.loadedFamilies.push(f.family.replace(/^["']|["']$/g, '')); }); } catch {}
  const h = [...document.querySelectorAll('h1, h2')].find(visible);
  if (h) {
    out.headingFontFamily = getComputedStyle(h).fontFamily;
    out.heading = (h.innerText || h.textContent || '').trim().slice(0, 80);
  }

  // Nav / sidebar: the biggest visible landmark hugging the left or top edge.
  const navs = [...document.querySelectorAll('nav, aside, header, [role=navigation], [data-sidebar], [class*="sidebar" i]')]
    .filter(visible).map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.left < 40 || r.top < 40).sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
  if (navs[0]) {
    const el = navs[0].el;
    const active = el.querySelector('[aria-current="page"], [aria-current="true"], [data-active="true"], [data-state="active"], .active');
    out.nav = { bg: effBg(el), color: hex(getComputedStyle(el).color) };
    if (active && visible(active)) {
      const ab = getComputedStyle(active).backgroundColor;
      if (alpha(ab) > 0.5) out.nav.activeBg = hex(ab);
    }
  }

  for (const el of document.querySelectorAll('button, a, [role=button], input[type=submit], input[type=button]')) {
    if (!visible(el)) continue;
    const s = getComputedStyle(el); const r = el.getBoundingClientRect();
    if (r.height < 20 || r.height > 72 || r.width > 480) continue;
    if (alpha(s.backgroundColor) < 0.6) continue;
    if (navs[0] && navs[0].el.contains(el)) continue;
    out.buttons.push({ bg: hex(s.backgroundColor), color: hex(s.color), radius: parseFloat(s.borderTopLeftRadius) || 0, shadow: s.boxShadow,
      height: Math.round(r.height), area: Math.round(r.width * r.height), fontFamily: s.fontFamily });
    if (out.buttons.length > 80) break;
  }
  for (const el of document.querySelectorAll('div, section, article, main > *, form, table')) {
    if (out.cards.length > 40) break;
    const r = el.getBoundingClientRect();
    if (r.width < 200 || r.height < 90 || r.width > innerWidth * 0.98) continue;
    const s = getComputedStyle(el);
    const bordered = parseFloat(s.borderTopWidth) > 0 && alpha(s.borderTopColor) > 0.05;
    const shadowed = s.boxShadow && s.boxShadow !== 'none';
    if (!bordered && !shadowed) continue;
    if (!visible(el)) continue;
    out.cards.push({ radius: parseFloat(s.borderTopLeftRadius) || 0, shadow: s.boxShadow, borderColor: bordered ? hex(s.borderTopColor) : undefined, bg: effBg(el) });
  }
  for (const el of document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=hidden]), select, textarea, [role=combobox]')) {
    if (!visible(el)) continue;
    const s = getComputedStyle(el);
    out.inputs.push({ height: Math.round(el.getBoundingClientRect().height), borderColor: hex(s.borderTopColor), radius: parseFloat(s.borderTopLeftRadius) || 0 });
    if (out.inputs.length > 30) break;
  }

  // Logo: a graphic (img/svg) near the top-left, preferring one inside a link home that also
  // carries the app's name — then the whole link is the wordmark.
  // Covered by a dialog's overlay or a banner, a graphic would be drawn dimmed or not at all.
  const uncovered = (el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.min(innerWidth - 1, r.left + r.width / 2), Math.min(innerHeight - 1, r.top + r.height / 2));
    return Boolean(hit && (el.contains(hit) || hit.contains(el) || (el.closest('a') && el.closest('a').contains(hit))));
  };
  const graphics = [...document.querySelectorAll('img, svg')].filter(visible).map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.left < 420 && r.top < 170 && r.width >= 14 && r.height >= 12 && r.width <= 420 && r.height <= 140)
    .filter(({ el }) => uncovered(el));
  // Menu items link home too ("Home", "Dashboard"): an icon beside one of these words is a menu
  // item, not the logo.
  const NAV_WORDS = /^(home|dashboard|overview|start|back|menu|polls?|events?|inbox|today)$/i;
  const score = ({ el }) => {
    const a = el.closest('a');
    const href = a ? a.getAttribute('href') || '' : '';
    const hint = ((el.getAttribute('alt') || '') + ' ' + (el.getAttribute('src') || '') + ' ' + (el.getAttribute('class') || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
    let s = 0;
    if (/logo|brand|wordmark/.test(hint)) s += 4;
    if (a && (href === '/' || href === location.origin + '/' || /^\/(dashboard|home)?$/.test(href))) s += 3;
    if (el.closest('header, nav, aside, [data-sidebar], [class*="sidebar" i]')) s += 1;
    if (el.closest('button')) s -= 4;
    const label = a ? (a.innerText || a.textContent || '').trim() : '';
    if (!/logo|brand|wordmark/.test(hint) && NAV_WORDS.test(label)) s -= 4;
    return s;
  };
  const best = graphics.map((g) => ({ ...g, s: score(g) })).filter((g) => g.s >= 2).sort((a, b) => b.s - a.s || a.r.top - b.r.top || a.r.left - b.r.left)[0];
  if (best) {
    let logoEl = best.el;
    const link = best.el.closest('a');
    const text = (el) => (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
    // The link (or the graphic's own row) when it also holds a short name: the wordmark.
    const holder = link && link.getBoundingClientRect().width < 460 ? link : best.el.parentElement;
    if (holder && text(holder).length > 0 && text(holder).length <= 40 && holder.getBoundingClientRect().height <= 140) logoEl = holder;
    logoEl.setAttribute('data-aida-logo', '1');
    best.el.setAttribute('data-aida-mark', '1');
    const r = logoEl.getBoundingClientRect();
    out.logo = { text: text(logoEl).slice(0, 60), alt: best.el.getAttribute('alt') || best.el.getAttribute('aria-label') || '',
      onDark: lum(effBg(logoEl)) < 0.45, hasMark: logoEl !== best.el, w: Math.round(r.width), h: Math.round(r.height) };
  }
  for (const l of document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]')) {
    out.icons.push({ href: l.href, rel: l.getAttribute('rel') || '', sizes: l.getAttribute('sizes') || '' });
  }
  return out;
})()`;

// ------------------------------------------------------------------ pure: samples -> brand

const GENERIC_FAMILIES = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace",
  "ui-rounded", "-apple-system", "blinkmacsystemfont", "segoe ui", "roboto", "helvetica", "helvetica neue", "arial",
  "noto sans", "apple color emoji", "segoe ui emoji", "segoe ui symbol", "noto color emoji", "emoji", "math", "fangsong",
]);

/** A CSS family name as people write it: quotes off; next/font's `__Inter_d65c78` -> `Inter`;
 * its `__Inter_Fallback_d65c78` (a metric-adjusted local font) -> undefined. */
export function normalizeFamily(raw: string): string | undefined {
  let f = raw.trim().replace(/^["']|["']$/g, "").trim();
  if (!f) return undefined;
  const next = /^__(.+?)(_Fallback)?_[0-9a-f]{5,}$/i.exec(f);
  if (next) {
    if (next[2]) return undefined;
    f = next[1].replace(/_/g, " ");
  }
  if (/fallback/i.test(f)) return undefined;
  return f;
}

/** The first family in a `font-family` stack the page really loaded (`document.fonts`), else the
 * first non-generic, non-system one. Undefined for a system stack. */
export function pickFont(stack: string | undefined, loaded: string[]): string | undefined {
  if (!stack) return undefined;
  const families = stack.split(",").map(normalizeFamily).filter((f): f is string => Boolean(f));
  const loadedSet = new Set(loaded.map(normalizeFamily).filter(Boolean).map((f) => f!.toLowerCase()));
  const named = families.filter((f) => !GENERIC_FAMILIES.has(f.toLowerCase()));
  return named.find((f) => loadedSet.has(f.toLowerCase())) ?? named[0];
}

interface Hsl01 {
  s: number;
  l: number;
}

function hsl(hex: string): Hsl01 | undefined {
  const c = parseColor(hex);
  if (!c) return undefined;
  const h = rgbToHsl(c);
  return { s: h.s / 100, l: h.l / 100 };
}

const opaque = (hex: string): string => (hex.length === 9 ? hex.slice(0, 7) : hex);
const isOpaque = (hex: string): boolean => hex.length === 7 || /ff$/i.test(hex);

/** A saturated, mid-lightness colour: a brand colour rather than a surface or text grey. */
export function isBrandish(hex: string): boolean {
  const c = hsl(hex);
  return Boolean(c && c.s >= 0.28 && c.l >= 0.18 && c.l <= 0.78);
}

function mode<T>(items: T[], key: (t: T) => string, weight: (t: T) => number = () => 1): T | undefined {
  const tally = new Map<string, { item: T; w: number }>();
  for (const it of items) {
    const k = key(it);
    const cur = tally.get(k);
    tally.set(k, { item: cur?.item ?? it, w: (cur?.w ?? 0) + weight(it) });
  }
  return [...tally.values()].sort((a, b) => b.w - a.w)[0]?.item;
}

function median(ns: number[]): number | undefined {
  if (ns.length === 0) return undefined;
  const s = [...ns].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** `none` / `soft` / `strong` from computed `box-shadow` values (the most common answer). */
export function shadowKind(shadows: string[]): "none" | "soft" | "strong" | undefined {
  if (shadows.length === 0) return undefined;
  const kind = (s: string): "none" | "soft" | "strong" => {
    if (!s || s === "none") return "none";
    let strong = false;
    let any = false;
    // Each layer: colour then offsets/blur/spread, e.g. "rgba(0, 0, 0, 0.1) 0px 4px 6px -1px".
    for (const layer of s.split(/,(?![^(]*\))/)) {
      const nums = [...layer.replace(/rgba?\([^)]*\)|#[0-9a-f]+|oklch\([^)]*\)/gi, "").matchAll(/(-?\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
      const a = /rgba?\([^)]*?[,/]\s*([\d.]+)\s*\)/.exec(layer);
      const alphaV = a ? Number(a[1]) : 1;
      const [, y = 0, blur = 0] = nums;
      if (alphaV < 0.02 || (blur === 0 && y === 0 && (nums[3] ?? 0) <= 1)) continue; // a 1px ring is a border, not a lift
      any = true;
      if (blur >= 15 || (alphaV >= 0.22 && blur >= 6) || Math.abs(y) >= 8) strong = true;
    }
    return !any ? "none" : strong ? "strong" : "soft";
  };
  return mode(shadows.map(kind), (k) => k);
}

export interface AppBrandReading {
  brand: BrandConfig;
  /** What each value was read from, for the summary. */
  notes: string[];
}

/** Turns one or more page samples into brand values (colours as `hsl(...)`, radius in px). */
export function brandFromSamples(samples: AppStyleSample[]): AppBrandReading {
  const brand: BrandConfig = {};
  const notes: string[] = [];
  const colors: NonNullable<BrandConfig["colors"]> = {};
  const fmt = (hex: string) => {
    const c = parseColor(opaque(hex));
    return c ? formatHsl(rgbToHsl(c)) : hex;
  };

  const buttons = samples.flatMap((s) => s.buttons).filter((b) => isOpaque(b.bg));
  const brandButtons = buttons.filter((b) => isBrandish(b.bg));
  // Neutral apps (shadcn's default) draw primary buttons near-black: take those when nothing is coloured.
  const darkButtons = buttons.filter((b) => (hsl(b.bg)?.l ?? 1) < 0.22);
  const primary = mode(brandButtons.length ? brandButtons : darkButtons, (b) => opaque(b.bg).toLowerCase(), (b) => b.area);
  if (primary) {
    brand.primaryColor = fmt(primary.bg);
    colors.primaryForeground = fmt(primary.color);
    notes.push(`primary from the main button (${opaque(primary.bg)})`);
  }

  const navs = samples.map((s) => s.nav).filter((n): n is NonNullable<AppStyleSample["nav"]> => Boolean(n));
  const accentCandidates = [
    ...navs.map((n) => n.activeBg).filter((c): c is string => Boolean(c)),
    ...navs.map((n) => n.bg),
  ].filter((c) => isOpaque(c) && isBrandish(c) && (!primary || opaque(c).toLowerCase() !== opaque(primary.bg).toLowerCase()));
  if (accentCandidates[0]) {
    brand.accentColor = fmt(accentCandidates[0]);
    notes.push(`accent from the navigation (${opaque(accentCandidates[0])})`);
  }

  const first = samples[0];
  if (first) {
    colors.background = fmt(first.body.bg);
    colors.foreground = fmt(first.body.color);
  }
  const borders = samples.flatMap((s) => s.inputs.map((i) => i.borderColor)).filter((c) => isOpaque(c) && !isBrandish(c));
  const border = mode(borders, (c) => c.toLowerCase());
  if (border) colors.border = fmt(border);
  const cardBgs = samples.flatMap((s) => s.cards.map((c) => c.bg)).filter(isOpaque);
  const card = mode(cardBgs, (c) => c.toLowerCase());
  if (card) colors.card = fmt(card);
  if (Object.keys(colors).length) brand.colors = colors;

  const loaded = samples.flatMap((s) => s.loadedFamilies);
  const font = pickFont(primary?.fontFamily ?? first?.body.fontFamily, loaded) ?? pickFont(first?.body.fontFamily, loaded);
  if (font) {
    brand.font = font;
    notes.push(`font ${font}${loaded.some((f) => normalizeFamily(f)?.toLowerCase() === font.toLowerCase()) ? " (loaded by the page)" : ""}`);
  }
  const heading = pickFont(samples.find((s) => s.headingFontFamily)?.headingFontFamily, loaded);
  if (heading && heading !== font) brand.headingFont = heading;

  const cardRadii = samples.flatMap((s) => s.cards.map((c) => c.radius)).filter((r) => r > 0 && r < 40);
  const buttonRadii = buttons.map((b) => b.radius).filter((r) => r < 40);
  const radius = median(cardRadii.length >= 2 ? cardRadii : buttonRadii);
  if (radius !== undefined) brand.radius = `${Math.round(radius)}px`;

  const shadow = shadowKind([...samples.flatMap((s) => s.cards.map((c) => c.shadow)), ...(primary ? [primary.shadow] : [])]);
  if (shadow) brand.shadow = shadow;

  const heights = [...buttons.map((b) => b.height), ...samples.flatMap((s) => s.inputs.map((i) => i.height))];
  const h = median(heights);
  if (h !== undefined) brand.density = h < 34 ? "compact" : h > 42 ? "comfortable" : "regular";

  const name = appName(samples);
  if (name) brand.name = name;
  return { brand, notes };
}

/** The app's name: og:site_name, the logo's alt/text, else from the page titles (see titleName). */
export function appName(samples: AppStyleSample[]): string | undefined {
  for (const s of samples) {
    const v = s.siteName?.trim();
    if (v) return v;
  }
  for (const s of samples) {
    const alt = s.logo?.alt.replace(/\s*logo\s*$/i, "").trim();
    if (alt && alt.length <= 40) return alt;
    const text = s.logo?.text.split(/\s{2,}|\n/)[0].trim();
    if (text && text.length <= 30) return text;
  }
  return titleName(samples);
}

/** The app's name from page titles like "Orders · Acme" or "Acme | Orders": the part every
 * sampled page shares, else the part that isn't the page's own heading, else the last part (the
 * usual "Page - App" order). A title with no separator is taken whole. */
export function titleName(samples: Pick<AppStyleSample, "title" | "heading">[]): string | undefined {
  const split = (t: string) => t.split(/\s+[-|–—:·•]\s+/).map((p) => p.trim()).filter(Boolean);
  const titled = samples.filter((s) => s.title?.trim());
  if (titled.length === 0) return undefined;
  const parts = split(titled[0].title);
  const fits = (p: string | undefined) => (p && p.length <= 40 ? p : undefined);
  if (parts.length <= 1) return fits(parts[0]);
  if (titled.length > 1) {
    const shared = parts.filter((p) => titled.every((s) => split(s.title).includes(p)));
    if (shared.length === 1) return fits(shared[0]);
  }
  const heading = titled[0].heading?.trim().toLowerCase();
  const notHeading = heading ? parts.filter((p) => p.toLowerCase() !== heading) : [];
  if (notHeading.length === 1) return fits(notHeading[0]);
  return fits(parts[parts.length - 1]);
}

// ------------------------------------------------------------------ browser session

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** `p` as a URL on the app's own origin; throws for anything that would leave it. */
export function appPageUrl(base: string, p: string): string {
  const origin = new URL(base).origin;
  const u = new URL(p, `${base.replace(/\/+$/, "")}/`);
  if (u.origin !== origin) throw new Error(`page ${JSON.stringify(p)} isn't on the app (${origin})`);
  return u.toString();
}

/** Blocks every non-GET request and WebSocket send unless `passThrough` (only while signing in)
 * — the same block `aida inspect` installs, before any page exists. */
async function installReadOnlyGate(context: BrowserContext, gate: { passThrough: boolean }, origin: string): Promise<void> {
  await context.route("**/*", (route) => {
    const req = route.request();
    if (gate.passThrough) return route.continue();
    if (req.method() !== "GET") return route.abort();
    // Only the app itself is browsed: a redirect or link off to another site isn't followed
    // (assets from CDNs still load). Sign-in may go wherever its provider lives.
    if (req.isNavigationRequest() && sameOrigin(req.url(), origin) === false) return route.abort();
    return route.continue();
  });
  await context.routeWebSocket(/.*/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      if (gate.passThrough) server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });
}

export interface ReadFromAppOptions {
  baseUrl: string;
  /** Paths to open (first one is where the logo is read). Default `["/"]`. */
  pages?: string[];
  /** The config's sign-in adapter (capture's own), run with writes allowed, nothing else is. */
  signIn?: (args: { page: Page; context: BrowserContext; baseUrl: string; persona: unknown; env: NodeJS.ProcessEnv }) => Promise<void>;
  persona?: unknown;
  /** Saved session (`<buildDir>/.aida-session/...`), shared with capture and inspect. */
  storageStatePath?: string;
  /** Tells a sign-in page apart from the app (capture's `isSignInPath`). */
  isSignInPath?: (url: string) => boolean;
  /** Where to write the logo/icon PNGs (`<configDir>/brand`). Nothing written when unset. */
  assetsDir?: string;
  viewport?: { width: number; height: number };
  /** The config's `mask` (capture's page masking): personal data and `selectors` are blurred
   * before the logo is rendered, as before every capture screenshot. */
  mask?: { personalData?: boolean; selectors?: string[] };
  /** Test hook: requests the gate blocked. */
  onBlocked?: (method: string, url: string) => void;
}

export interface ReadFromAppResult {
  brand: BrandConfig;
  notes: string[];
  samples: AppStyleSample[];
  /** Asset files written (absolute). */
  assets: { logo?: string; logoDark?: string; icon?: string };
  pages: string[];
}

/** Opens the app read-only, samples each page, captures the logo and icon. */
export async function readBrandFromApp(opts: ReadFromAppOptions): Promise<ReadFromAppResult> {
  const { chromium } = await import("playwright");
  const pages = opts.pages && opts.pages.length > 0 ? opts.pages : ["/"];
  const base = opts.baseUrl.replace(/\/+$/, "");
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const reuse = opts.storageStatePath && existsSync(opts.storageStatePath) ? opts.storageStatePath : undefined;
    const context = await browser.newContext({
      viewport: opts.viewport ?? { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: "light",
      reducedMotion: "reduce",
      serviceWorkers: "block",
      ...(reuse ? { storageState: reuse } : {}),
    });
    // Like capture and inspect: callbacks passed to page.evaluate as functions (capture's masks
    // among them) get esbuild's `__name(...)` wrapping under tsx, which the page doesn't have.
    // A plain-string no-op `__name` in every document lets them run (see capture/init-scripts.ts).
    await context.addInitScript(NAME_SHIM_SCRIPT);
    const gate = { passThrough: false };
    const origin = new URL(base).origin;
    await installReadOnlyGate(context, gate, origin);
    if (opts.onBlocked) {
      context.on("requestfailed", (req) => {
        if (req.method() !== "GET") opts.onBlocked!(req.method(), req.url());
      });
    }
    const page = await context.newPage();
    const signIn = async () => {
      if (!opts.signIn) return;
      gate.passThrough = true;
      try {
        await opts.signIn({ page, context, baseUrl: base, persona: opts.persona, env: process.env });
      } finally {
        gate.passThrough = false;
      }
      if (opts.storageStatePath) {
        mkdirSync(path.dirname(opts.storageStatePath), { recursive: true });
        await context.storageState({ path: opts.storageStatePath });
      }
    };
    if (!reuse) await signIn();

    const samples: AppStyleSample[] = [];
    const assets: ReadFromAppResult["assets"] = {};
    for (const [i, p] of pages.entries()) {
      const url = appPageUrl(base, p);
      await gotoReady(page, url, 60_000);
      if (reuse && opts.signIn && opts.isSignInPath?.(page.url())) {
        await signIn();
        await gotoReady(page, url, 60_000);
      }
      // Never read a brand off somewhere else, or off the sign-in screen (often a different look).
      if (!sameOrigin(page.url(), origin)) throw new Error(`${p} ended up off the app (${new URL(page.url()).origin}) — not reading it`);
      if (opts.isSignInPath?.(page.url())) {
        throw new Error(`${p} shows the sign-in page — check the config's signIn (or pass --page with a page that needs no sign-in)`);
      }
      await page.evaluate("document.fonts.ready").catch(() => {});
      const sample = (await page.evaluate(APP_STYLE_SCRIPT)) as AppStyleSample;
      samples.push(sample);
      if (i === 0 && opts.assetsDir) Object.assign(assets, await captureLogo(page, sample, base, opts.assetsDir, opts.mask));
    }
    const { brand, notes } = brandFromSamples(samples);
    return { brand, notes, samples, assets, pages };
  } finally {
    await browser?.close().catch(() => {});
  }
}

/** Renders the marked logo (and its graphic, as the icon when the page links none big enough)
 * to transparent PNGs. The logo's own and its ancestors' backgrounds are cleared for the shot,
 * then put back. A logo drawn on a dark surface is saved as the dark-background logo. */
async function captureLogo(
  page: Page,
  sample: AppStyleSample,
  base: string,
  assetsDir: string,
  mask: ReadFromAppOptions["mask"],
): Promise<ReadFromAppResult["assets"]> {
  const out: ReadFromAppResult["assets"] = {};
  mkdirSync(assetsDir, { recursive: true });
  // Same page masking as every capture screenshot (personal data, `mask.selectors`).
  await applyMasks(page, undefined, { personalData: mask?.personalData, selectors: mask?.selectors });
  const clear = `(() => { const el = document.querySelector('[data-aida-logo]'); if (!el) return;
    for (let e = el; e; e = e.parentElement) { e.dataset.aidaBg = e.style.background; e.style.setProperty('background', 'transparent', 'important'); } })()`;
  const restore = `(() => { for (const e of document.querySelectorAll('[data-aida-bg]')) { e.style.background = e.dataset.aidaBg; delete e.dataset.aidaBg; } })()`;
  if (sample.logo) {
    try {
      await page.evaluate(clear);
      const logo = await page.locator("[data-aida-logo]").first().screenshot({ omitBackground: true, animations: "disabled" });
      const file = path.join(assetsDir, sample.logo.onDark ? "from-app-logo-dark.png" : "from-app-logo.png");
      writeFileSync(file, logo);
      out[sample.logo.onDark ? "logoDark" : "logo"] = file;
      if (sample.logo.hasMark) {
        const mark = await page.locator("[data-aida-mark]").first().screenshot({ omitBackground: true, animations: "disabled" });
        const markFile = path.join(assetsDir, "from-app-icon.png");
        writeFileSync(markFile, mark);
        out.icon = markFile;
      }
    } catch {
      // A logo that can't be rendered (detached, zero-size) is simply not captured.
    } finally {
      await page.evaluate(restore).catch(() => {});
    }
  }
  await clearMasks(page).catch(() => {});
  // A linked icon of a decent size beats a screenshot of the mark: same origin, GET only.
  const linked = [...sample.icons]
    .filter((i) => {
      try {
        return new URL(i.href).origin === new URL(base).origin && /\.(png|svg)$/i.test(new URL(i.href).pathname);
      } catch {
        return false;
      }
    })
    .sort((a, b) => iconSize(b) - iconSize(a))[0];
  if (linked && (iconSize(linked) >= 96 || !out.icon)) {
    try {
      // GET only, no redirects (a hop could leave the app), PNG bytes only. An SVG is never kept
      // as it came: the help site would serve the app's markup from its own origin, so it's
      // rasterised to a PNG in an isolated page (as an <img>: no scripts run).
      const res = await page.request.get(linked.href, { timeout: 15_000, maxRedirects: 0 });
      const body = await res.body();
      if (res.ok() && body.length > 0 && body.length < 1_000_000) {
        const png = isPng(body) ? body : looksLikeSvg(body) ? await rasterizeSvg(page, body) : undefined;
        if (png) {
          const file = path.join(assetsDir, "from-app-icon.png");
          writeFileSync(file, png);
          out.icon = file;
        }
      }
    } catch {
      // keep the screenshot of the mark, if any
    }
  }
  return out;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isPng(bytes: Buffer): boolean {
  return bytes.length > 8 && bytes.subarray(0, 8).equals(PNG_MAGIC);
}

function looksLikeSvg(bytes: Buffer): boolean {
  return /<svg[\s>]/i.test(bytes.subarray(0, 4096).toString("utf8"));
}

/** An SVG drawn as an `<img>` (scripts never run there) on a blank page, screenshotted to a
 * 256px transparent PNG. */
export async function rasterizeSvg(page: Page, svg: Buffer): Promise<Buffer | undefined> {
  const shot = await page.context().newPage();
  try {
    await shot.setViewportSize({ width: 256, height: 256 });
    const src = `data:image/svg+xml;base64,${svg.toString("base64")}`;
    await shot.setContent(`<html><body style="margin:0;background:transparent"><img id="i" src="${src}" style="width:256px;height:256px;object-fit:contain;display:block"></body></html>`);
    const ok = await shot.evaluate("(async () => { const i = document.getElementById('i'); try { await i.decode(); } catch { return false; } return i.naturalWidth > 0; })()");
    if (!ok) return undefined;
    return await shot.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: 256, height: 256 } });
  } finally {
    await shot.close();
  }
}

function iconSize(i: { sizes: string; rel: string }): number {
  const m = /(\d+)x\d+/.exec(i.sizes);
  if (m) return Number(m[1]);
  return /apple-touch/.test(i.rel) ? 180 : 32;
}
