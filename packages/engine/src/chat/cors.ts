// CORS for /api/chat (build-plan.md M15 step 6: "Cross-origin: chat route allows CORS only from
// configured app origins"). The help site's own origin needs no CORS header at all (same-origin
// fetches never send one that matters); this is only for the in-app widget calling from the
// user's own app's origin, which must be explicitly configured.

/** Returns the `Access-Control-Allow-Origin` value to send for a request's `Origin` header, or
 * `undefined` when the origin isn't allowed (the caller should omit CORS headers entirely, so
 * the browser blocks the cross-origin read). Never returns `"*"` — chat is per-site config, not
 * a public API. */
export function resolveCorsOrigin(requestOrigin: string | null, allowedOrigins: string[]): string | undefined {
  if (!requestOrigin) return undefined;
  return allowedOrigins.includes(requestOrigin) ? requestOrigin : undefined;
}

export const CORS_HEADERS_FOR = (origin: string): Record<string, string> => ({
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  Vary: "Origin",
});
