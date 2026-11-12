// The in-app widget (public/widget.js) and tour script (public/tour.js) run on the app's origin and
// read the help site's public files cross-origin; next.config.mjs sends the header for exactly
// those files and nothing else (chat and feedback keep their own allow-lists).
import { describe, expect, it } from "vitest";

describe("next.config.mjs cross-origin files", () => {
  it("lets any origin read the help map, search index, brand theme and tours, and nothing else", async () => {
    const config = (await import("../../next.config.mjs")).default as { headers?: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> };
    const rules = (await config.headers?.()) ?? [];
    expect(rules.map((r) => r.source).sort()).toEqual(["/brand/theme.json", "/help-map.json", "/search-index.json", "/tours/:path*"]);
    for (const rule of rules) expect(rule.headers).toEqual([{ key: "Access-Control-Allow-Origin", value: "*" }]);
  });
});
