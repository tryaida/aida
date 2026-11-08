// The app's brand as the help site sees it. `lib/brand.json` and `app/brand.css` are written by
// the aida engine from aida.config's `brand` (`aida theme`, and every `aida build`), so
// the site, Studio, videos and PDFs all match the app they document. Don't edit them by hand.
import raw from "./brand.json";

export interface Brand {
  /** Product name, e.g. "Acme Events". "Help" when unknown. */
  name: string;
  /** Site URLs under /brand/, or null. */
  logo: string | null;
  logoDark: string | null;
  icon: string | null;
  /** Stylesheet that loads the brand font, or null. */
  fontUrl: string | null;
  /** The logo is a wordmark that already spells the name. */
  logoWide: boolean;
  /** BCP 47 language tag (decision 39, config `lang`) — drives `<html lang>` and the caption
   * track's `srcLang`. Mirrors the engine's `DEFAULT_LANG` (config/types.ts) when unset. */
  lang: string;
}

/** The help's language when `lib/brand.json` sets none — same default as the engine's
 * `DEFAULT_LANG` (packages/engine/src/config/types.ts), duplicated here since the help app
 * doesn't depend on the engine package at runtime. */
export const DEFAULT_LANG = "en";

/** `brand.json`'s `lang` -> the BCP 47 tag the site actually uses: trimmed, and `DEFAULT_LANG`
 * when unset or blank. Pure, so it's tested without going through the JSON import. */
export function resolveLang(raw: string | undefined): string {
  return raw?.trim() || DEFAULT_LANG;
}

const data = raw as Partial<Brand>;

export const brand: Brand = {
  name: data.name?.trim() || "Help",
  logo: data.logo ?? null,
  logoDark: data.logoDark ?? null,
  icon: data.icon ?? null,
  fontUrl: data.fontUrl ?? null,
  logoWide: data.logoWide === true,
  lang: resolveLang(data.lang),
};

/** "Acme Events Help", or just "Help" when the product name is unknown. */
export const siteTitle = brand.name === "Help" ? "Help" : `${brand.name} Help`;
