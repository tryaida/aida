// Small, dependency-free colour helpers for the help-app theme (Contract 1/2 in the brand
// brief): normalise config colours into CSS values, and derive the values a brand block leaves
// out (readable text on a colour, a lighter primary for dark mode). Everything here is pure and
// deterministic — same input, same output string — so generated theme files stay byte-stable.

/** sRGB colour, channels 0..1 (gamma-encoded), alpha 0..1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** HSL, h in degrees 0..360, s/l in percent 0..100. */
export interface Hsl {
  h: number;
  s: number;
  l: number;
}

const NUM = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?`;
const BARE_HSL = new RegExp(String.raw`^(${NUM})(?:deg)?\s*,?\s+(${NUM})%\s*,?\s+(${NUM})%(?:\s*\/\s*(${NUM}%?))?$`, "i");

/**
 * A config colour as a CSS colour value: a bare HSL triplet (`235 55% 42%`, optionally with
 * `/ 0.5` alpha — the shadcn convention) becomes `hsl(235 55% 42%)`; anything else (hex, rgb(),
 * hsl(), oklch(), named, var()) passes through trimmed.
 */
export function toCssColor(value: string): string {
  const v = value.trim().replace(/\s+/g, " ");
  if (BARE_HSL.test(v)) return `hsl(${v})`;
  return v;
}

/** True for a bare `H S% L%` triplet (no `hsl()` wrapper). */
export function isBareHslTriplet(value: string): boolean {
  return BARE_HSL.test(value.trim().replace(/\s+/g, " "));
}

const NAMED: Record<string, Rgba> = {
  white: { r: 1, g: 1, b: 1, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  transparent: { r: 0, g: 0, b: 0, a: 0 },
};

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function parseAlpha(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const t = raw.trim();
  return clamp01(t.endsWith("%") ? parseFloat(t) / 100 : parseFloat(t));
}

function parseHue(raw: string): number {
  const t = raw.trim().toLowerCase();
  let h = parseFloat(t);
  if (t.endsWith("turn")) h *= 360;
  else if (t.endsWith("grad")) h *= 0.9;
  else if (t.endsWith("rad")) h = (h * 180) / Math.PI;
  return ((h % 360) + 360) % 360;
}

/** Splits a functional colour's arguments: `a b c / d` or `a, b, c, d` -> [a, b, c, d?]. */
function splitArgs(inner: string): string[] | undefined {
  let alpha: string | undefined;
  let main = inner.trim();
  const slash = main.indexOf("/");
  if (slash >= 0) {
    alpha = main.slice(slash + 1).trim();
    main = main.slice(0, slash).trim();
  }
  const parts = main.includes(",") ? main.split(",").map((p) => p.trim()) : main.split(/\s+/);
  if (parts.length === 4 && alpha === undefined) {
    alpha = parts.pop();
  }
  if (parts.length !== 3 || parts.some((p) => p === "" || p === "none")) return undefined;
  return alpha === undefined ? parts : [...parts, alpha];
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const sat = clamp01(s / 100);
  const light = clamp01(l / 100);
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = light - c / 2;
  return { r: clamp01(r + m), g: clamp01(g + m), b: clamp01(b + m) };
}

function gammaEncode(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function linearize(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function oklabToRgb(L: number, A: number, B: number): { r: number; g: number; b: number } {
  const l_ = L + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = L - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = L - 0.0894841775 * A - 1.291485548 * B;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return {
    r: clamp01(gammaEncode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    g: clamp01(gammaEncode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    b: clamp01(gammaEncode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
  };
}

function pct(raw: string, scale: number): number {
  const t = raw.trim();
  return t.endsWith("%") ? (parseFloat(t) / 100) * scale : parseFloat(t);
}

/**
 * Parses hex, `rgb()`/`rgba()`, `hsl()`/`hsla()`, `oklch()`, `oklab()`, a bare HSL triplet,
 * and white/black/transparent. Returns undefined for anything else (var(), color-mix(), most
 * named colours) — callers fall back to CSS-side derivations then.
 */
export function parseColor(value: string | undefined): Rgba | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (NAMED[v]) return { ...NAMED[v] };

  const hex = v.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return undefined;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
  }

  const bare = v.match(BARE_HSL);
  if (bare) {
    return { ...hslToRgb(parseHue(bare[1]), parseFloat(bare[2]), parseFloat(bare[3])), a: parseAlpha(bare[4]) };
  }

  const fn = v.match(/^(rgba?|hsla?|oklch|oklab)\((.*)\)$/);
  if (!fn) return undefined;
  const args = splitArgs(fn[2]);
  if (!args) return undefined;
  if (args.slice(0, 3).some((a) => !new RegExp(`^${NUM}(%|deg|turn|rad|grad)?$`, "i").test(a))) return undefined;
  const a = parseAlpha(args[3]);
  switch (fn[1]) {
    case "rgb":
    case "rgba": {
      const ch = (raw: string) => clamp01(raw.endsWith("%") ? parseFloat(raw) / 100 : parseFloat(raw) / 255);
      return { r: ch(args[0]), g: ch(args[1]), b: ch(args[2]), a };
    }
    case "hsl":
    case "hsla":
      return { ...hslToRgb(parseHue(args[0]), parseFloat(args[1]), parseFloat(args[2])), a };
    case "oklch": {
      const L = pct(args[0], 1);
      const C = pct(args[1], 0.4);
      const H = (parseHue(args[2]) * Math.PI) / 180;
      return { ...oklabToRgb(L, C * Math.cos(H), C * Math.sin(H)), a };
    }
    case "oklab":
      return { ...oklabToRgb(pct(args[0], 1), pct(args[1], 0.4), pct(args[2], 0.4)), a };
  }
  return undefined;
}

/** WCAG relative luminance (0 = black, 1 = white). */
export function relativeLuminance(c: Rgba): number {
  return 0.2126 * linearize(c.r) + 0.7152 * linearize(c.g) + 0.0722 * linearize(c.b);
}

/** WCAG contrast ratio between two colours (1..21); undefined when either can't be parsed. */
export function contrastRatio(a: string | Rgba, b: string | Rgba): number | undefined {
  const ca = typeof a === "string" ? parseColor(a) : a;
  const cb = typeof b === "string" ? parseColor(b) : b;
  if (!ca || !cb) return undefined;
  const la = relativeLuminance(ca);
  const lb = relativeLuminance(cb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function rgbToHsl(c: Rgba): Hsl {
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l: l * 100 };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === c.r) h = ((c.g - c.b) / d) % 6;
  else if (max === c.g) h = (c.b - c.r) / d + 2;
  else h = (c.r - c.g) / d + 4;
  h = (h * 60 + 360) % 360;
  return { h, s: Math.min(100, s * 100), l: l * 100 };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** `hsl(235 55% 42%)`, rounded so output is stable. */
export function formatHsl(c: Hsl): string {
  return `hsl(${Math.round(c.h) % 360} ${round1(c.s)}% ${round1(c.l)}%)`;
}

/** Light enough to be a tint/fill rather than a brand colour (e.g. shadcn's `--accent`). */
export function isPale(value: string): boolean {
  const c = parseColor(value);
  if (!c) return false;
  return relativeLuminance(c) > 0.6 || rgbToHsl(c).l >= 85;
}

/** Near-grey (no real hue) — not useful as a brand accent. */
export function isGrayish(value: string): boolean {
  const c = parseColor(value);
  if (!c) return false;
  return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) < 0.08;
}

/** Same colour (within rounding) — or the same normalised string when either can't be parsed. */
export function sameColor(a: string, b: string): boolean {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (ca && cb) {
    return Math.abs(ca.r - cb.r) < 0.02 && Math.abs(ca.g - cb.g) < 0.02 && Math.abs(ca.b - cb.b) < 0.02 && Math.abs(ca.a - cb.a) < 0.02;
  }
  return toCssColor(a).toLowerCase() === toCssColor(b).toLowerCase();
}

export const LIGHT_TEXT = "hsl(0 0% 100%)";

/**
 * Readable text colour on `background`: white, or a near-black ink tinted with the
 * background's hue — whichever contrasts better (white wins ties at >= 4.5:1, the usual
 * brand-button look). Unparseable colours (var(), color-mix()) get white.
 */
export function readableForeground(background: string): string {
  const bg = parseColor(background);
  if (!bg) return LIGHT_TEXT;
  const hsl = rgbToHsl(bg);
  const ink = formatHsl({ h: hsl.h, s: Math.min(hsl.s, 50), l: 11 });
  const white = contrastRatio(bg, { r: 1, g: 1, b: 1, a: 1 })!;
  const dark = contrastRatio(bg, parseColor(ink)!)!;
  if (white >= 4.5 || white >= dark) return LIGHT_TEXT;
  return ink;
}

/** True when `fg` on `bg` meets `min` contrast (default 4.5:1); unknown counts as readable. */
export function isReadable(fg: string, bg: string, min = 4.5): boolean {
  const ratio = contrastRatio(fg, bg);
  return ratio === undefined || ratio >= min;
}

/**
 * A version of a brand colour that carries on a dark background: raises HSL lightness (and a
 * little saturation) until it has >= ~5:1 contrast against near-black, keeping the hue. Colours
 * that already carry are returned as-is (normalised). Unparseable colours get a CSS
 * `color-mix(in oklab, <c> 70%, white)` so the browser does the lightening.
 */
export function deriveDarkColor(value: string): string {
  const css = toCssColor(value);
  const c = parseColor(css);
  if (!c) return `color-mix(in oklab, ${css} 70%, white)`;
  const target = 0.25;
  if (relativeLuminance(c) >= target) return css;
  const hsl = rgbToHsl(c);
  const s = hsl.s < 10 ? hsl.s : Math.min(90, hsl.s + 12);
  let l = hsl.l;
  while (l < 90) {
    l += 1;
    const rgb = hslToRgb(hsl.h, s, l);
    if (relativeLuminance({ ...rgb, a: 1 }) >= target) break;
  }
  return formatHsl({ h: hsl.h, s, l });
}

/** A dark canvas tinted with a brand colour's hue (for dark mode when the app has none). */
export function tintedDark(value: string, lightness: number, maxSat = 30): string {
  const c = parseColor(value);
  if (!c) return `color-mix(in oklab, ${toCssColor(value)} 8%, hsl(0 0% ${lightness}%))`;
  const hsl = rgbToHsl(c);
  return formatHsl({ h: hsl.h, s: Math.min(hsl.s, maxSat), l: lightness });
}
