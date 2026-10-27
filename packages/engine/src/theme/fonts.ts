// Google Fonts helpers shared by brand detection (src/init/brand.ts) and the theme writer:
// recognise a family name as a Google font and build a css2 stylesheet URL for it.

/** Popular Google Fonts families (all ship weights 400-700), used to build a stylesheet URL
 * when only a family name is known. Lower-cased for lookup. */
const GOOGLE_FONTS = new Set(
  [
    "Inter", "Inter Tight", "Roboto", "Roboto Flex", "Open Sans", "Lato", "Montserrat", "Poppins", "Nunito",
    "Nunito Sans", "Raleway", "Source Sans 3", "Source Sans Pro", "Work Sans", "DM Sans", "Manrope",
    "Plus Jakarta Sans", "Outfit", "Figtree", "Geist", "IBM Plex Sans", "Noto Sans", "Rubik", "Karla", "Mulish",
    "Barlow", "Lexend", "Space Grotesk", "Sora", "Urbanist", "Public Sans", "Oswald", "Merriweather",
    "Playfair Display", "Lora", "PT Sans", "Ubuntu", "Fira Sans", "Hind", "Quicksand", "Josefin Sans", "Archivo",
    "Red Hat Display", "Red Hat Text", "Onest", "Instrument Sans", "Albert Sans", "Be Vietnam Pro",
    "Libre Franklin", "Cabin", "Heebo", "Assistant", "Titillium Web", "Exo 2", "Kanit", "Bricolage Grotesque",
    "Schibsted Grotesk", "Hanken Grotesk", "Atkinson Hyperlegible", "Overpass", "Asap", "Catamaran", "Prompt",
    "Noto Serif", "Roboto Slab", "Roboto Condensed", "Source Serif 4", "EB Garamond", "Crimson Pro", "Bitter",
    "Arimo", "Mukta", "Jost", "Epilogue", "Golos Text", "Commissioner", "Readex Pro", "Encode Sans", "Saira",
    "Chivo", "Spline Sans", "Lexend Deca", "M PLUS 1p", "Noto Sans JP", "Sarabun", "Cairo", "Tajawal",
  ].map((f) => f.toLowerCase()),
);

/** True when `family` is a well-known Google Fonts family. */
export function isGoogleFont(family: string): boolean {
  return GOOGLE_FONTS.has(family.trim().toLowerCase());
}

/**
 * `https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap` for one
 * or more families (duplicates dropped, order kept). Known families get weights 400-700;
 * others are requested without an axis (Google serves the default weight).
 */
export function googleFontsUrl(families: string[]): string {
  const seen = new Set<string>();
  const params: string[] = [];
  for (const raw of families) {
    const family = raw.trim();
    if (!family || seen.has(family.toLowerCase())) continue;
    seen.add(family.toLowerCase());
    const name = family.replace(/\s+/g, "+");
    params.push(isGoogleFont(family) ? `family=${name}:wght@400;500;600;700` : `family=${name}`);
  }
  return `https://fonts.googleapis.com/css2?${params.join("&")}&display=swap`;
}

/** Family names requested by a Google Fonts stylesheet URL (css2 `family=` params or css v1 `family=A|B`). */
export function familiesFromGoogleFontsUrl(url: string): string[] {
  const query = url.split("?")[1] ?? "";
  const out: string[] = [];
  for (const part of query.split("&")) {
    const [key, value] = part.split("=");
    if (key !== "family" || !value) continue;
    let decoded = value;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      // keep raw
    }
    for (const fam of decoded.split("|")) {
      const name = fam.split(":")[0].replace(/\+/g, " ").trim();
      if (name) out.push(name);
    }
  }
  return out;
}

/** Generic CSS families / keywords that aren't a real font choice. */
export const GENERIC_FAMILIES = new Set([
  "sans-serif", "serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif",
  "ui-monospace", "ui-rounded", "-apple-system", "blinkmacsystemfont", "segoe ui", "apple color emoji",
  "segoe ui emoji", "segoe ui symbol", "noto color emoji", "inherit", "initial", "unset", "math", "emoji",
]);

/**
 * The chosen family in a CSS `font-family` value: `'Inter', sans-serif` -> "Inter". Skips
 * `var()`/`theme()` references; a value that starts with a generic/system family (a plain
 * system stack) has no chosen family and returns undefined.
 */
export function firstFamily(fontFamily: string): string | undefined {
  for (const raw of fontFamily.split(",")) {
    const t = raw.trim();
    if (!t || /\(/.test(t)) continue;
    const name = t.replace(/^['"]|['"]$/g, "").trim();
    if (!name || GENERIC_FAMILIES.has(name.toLowerCase())) return undefined;
    return name;
  }
  return undefined;
}
