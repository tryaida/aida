import { describe, expect, it } from "vitest";
import { buildMatchers, findStepHits, routeToRegex } from "../../src/impact/match.js";
import type { CaptureManifest } from "../../src/capture/types.js";

describe("routeToRegex", () => {
  it("matches a dynamic [param] segment against any concrete value", () => {
    const re = routeToRegex("/teams/[id]");
    expect(re.test("/teams/42")).toBe(true);
    expect(re.test("/teams/abc-123")).toBe(true);
    expect(re.test("/teams/42/edit")).toBe(false);
  });

  it("matches a catch-all [...slug] segment against any sub-path", () => {
    const re = routeToRegex("/docs/[...slug]");
    expect(re.test("/docs/a/b/c")).toBe(true);
    expect(re.test("/docs")).toBe(false);
  });

  it("matches a static route exactly", () => {
    const re = routeToRegex("/dashboard");
    expect(re.test("/dashboard")).toBe(true);
    expect(re.test("/dashboard/teams")).toBe(false);
  });
});

function manifest(steps: CaptureManifest["steps"]): CaptureManifest {
  return { workflow: "wf", baseUrl: "http://localhost", viewport: { width: 1, height: 1 }, deviceScaleFactor: 1, steps };
}

describe("findStepHits", () => {
  it("finds a page-route hit by url, ignoring query strings", () => {
    const matchers = buildMatchers([{ path: "/teams/[id]", file: "app/teams/[id]/page.tsx", dynamic: true }], []);
    const m = manifest([
      { id: "s1", camera: "full", cameraBox: null, events: [], doc: { image: null, highlights: [] }, impact: { urls: ["/home"], requests: [] }, checks: [] },
      { id: "s2", camera: "full", cameraBox: null, events: [], doc: { image: null, highlights: [] }, impact: { urls: ["/teams/42?tab=roster"], requests: [] }, checks: [] },
    ]);
    const hits = findStepHits(m, matchers[0]!);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.stepId).toBe("s2");
  });

  it("finds an API-route hit by request path, reporting the method", () => {
    const matchers = buildMatchers([], [{ path: "/api/teams/[id]", file: "app/api/teams/[id]/route.ts", dynamic: true }]);
    const m = manifest([
      {
        id: "s1",
        camera: "full",
        cameraBox: null,
        events: [],
        doc: { image: null, highlights: [] },
        impact: { urls: [], requests: [{ method: "PATCH", path: "/api/teams/42" }] },
        checks: [],
      },
    ]);
    const hits = findStepHits(m, matchers[0]!);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.via).toBe("PATCH /api/teams/[id]");
  });

  it("finds no hits when nothing in the manifest matches", () => {
    const matchers = buildMatchers([{ path: "/teams/[id]", file: "app/teams/[id]/page.tsx", dynamic: true }], []);
    const m = manifest([
      { id: "s1", camera: "full", cameraBox: null, events: [], doc: { image: null, highlights: [] }, impact: { urls: ["/home"], requests: [] }, checks: [] },
    ]);
    expect(findStepHits(m, matchers[0]!)).toHaveLength(0);
  });
});
