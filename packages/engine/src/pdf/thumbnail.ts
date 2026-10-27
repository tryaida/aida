// Downscaled card thumbnails (M16 "card thumbnails downscaled"): the quick-reference card used
// to embed each step's full-size capture screenshot (2880x1620 PNG, a few hundred KB) at a 48pt
// display width, which Chromium's page.pdf() rasterizes at the image's full decoded resolution
// regardless of its CSS size — hence the 1.78 MB card (build-plan.md M12/Follow-ups). This module
// pre-shrinks each thumbnail to a small JPEG data: URL (actual pixels reduced, not just CSS-scaled)
// before it's ever embedded, using the same Chromium instance already open for PDF rendering —
// no new dependency, no separate image library.
import type { Browser } from "playwright";

/** Renders `imagePath` onto an offscreen canvas scaled to at most `maxWidthPx` wide, re-encodes
 * it as a JPEG, and returns a `data:image/jpeg;base64,...` URL. Returns `undefined` (never
 * throws) if the image can't be loaded — callers fall back to no thumbnail rather than the
 * full-size original, since silently reintroducing a multi-hundred-KB image would defeat the
 * point of this function. */
export async function makeThumbnailDataUrl(
  browser: Browser,
  imagePath: string,
  maxWidthPx = 160,
  quality = 0.6,
): Promise<string | undefined> {
  const page = await browser.newPage();
  try {
    await page.goto(`file://${imagePath}`, { waitUntil: "load" });
    return await page.evaluate(
      ({ maxWidthPx, quality }) => {
        const img = document.images[0];
        if (!img || !img.naturalWidth) return undefined;
        const scale = Math.min(1, maxWidthPx / img.naturalWidth);
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return undefined;
        ctx.drawImage(img, 0, 0, w, h);
        return canvas.toDataURL("image/jpeg", quality);
      },
      { maxWidthPx, quality },
    );
  } catch {
    return undefined;
  } finally {
    await page.close();
  }
}

/** Builds a `screenshot path -> thumbnail data: URL` map for every distinct screenshot among
 * `screenshots`, deduplicating (several card steps can point at the same file) and skipping
 * entries whose thumbnail generation failed. */
export async function makeThumbnails(
  browser: Browser,
  screenshots: Array<string | undefined>,
  maxWidthPx = 160,
  quality = 0.6,
): Promise<Map<string, string>> {
  const unique = [...new Set(screenshots.filter((s): s is string => Boolean(s)))];
  const map = new Map<string, string>();
  for (const src of unique) {
    const dataUrl = await makeThumbnailDataUrl(browser, src, maxWidthPx, quality);
    if (dataUrl) map.set(src, dataUrl);
  }
  return map;
}
