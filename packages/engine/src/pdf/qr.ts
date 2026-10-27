// QR code linking a printed guide to its page (and video) on the published help site (decision
// 36). Drawn as one vector SVG path so it prints crisp at any size; no image file involved.
import qrcode from "qrcode-generator";

/** `siteUrl` + the guide's site path, or undefined unless `siteUrl` is an absolute http(s) URL. */
export function guideUrl(siteUrl: string | undefined, sitePath: string | undefined): string | undefined {
  if (!siteUrl?.trim() || !sitePath) return undefined;
  try {
    const base = new URL(siteUrl.trim());
    if (base.protocol !== "https:" && base.protocol !== "http:") return undefined;
    // Keep any sub-path the site is served under (`https://example.com/help/`).
    const root = base.href.endsWith("/") ? base.href : `${base.href}/`;
    return new URL(sitePath.replace(/^\/+/, ""), root).href;
  } catch {
    return undefined;
  }
}

/** An inline `<svg>` QR code for `text`: dark modules as one path, a 2-module quiet zone. */
export function qrSvg(text: string, opts: { color?: string; label?: string } = {}): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 2;
  let d = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  const size = n + quiet * 2;
  const label = opts.label ? `<title>${opts.label.replace(/[<>&"]/g, "")}</title>` : "";
  return `<svg class="qr" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img">${label}<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="${opts.color ?? "#0f172a"}"/></svg>`;
}
