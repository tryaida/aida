import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildDigest, formatDigest } from "../../src/digest/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureRepo = path.join(__dirname, "fixture");

describe("buildDigest", () => {
  it("detects the App Router framework and routes, including dynamic segments and route groups", () => {
    const result = buildDigest(fixtureRepo);
    expect(result.framework).toBe("nextjs-app");

    const paths = result.routes.map((r) => r.path).sort();
    expect(paths).toEqual(["/dashboard", "/dashboard/competitors/[id]", "/login"]);

    const dashboard = result.routes.find((r) => r.path === "/dashboard");
    expect(dashboard?.dynamic).toBe(false);
    expect(dashboard?.file).toBe(path.join("app", "dashboard", "page.tsx"));

    const competitor = result.routes.find((r) => r.path === "/dashboard/competitors/[id]");
    expect(competitor?.dynamic).toBe(true);

    const login = result.routes.find((r) => r.path === "/login");
    expect(login?.group).toBe("(site)");
  });

  it("detects roles from auth-ish files", () => {
    const result = buildDigest(fixtureRepo);
    expect(result.roles).toEqual(["admin", "judge", "office_staff"]);
  });

  it("detects the sign-in method from package.json dependencies", () => {
    const result = buildDigest(fixtureRepo);
    expect(result.signInMethod).toBe("Auth.js");
  });

  it("extracts on-screen labels for a route from its page file and one-level co-located imports", () => {
    const result = buildDigest(fixtureRepo);
    const dashboardLabels = result.labelsByRoute["/dashboard"];
    expect(dashboardLabels).toEqual(expect.arrayContaining(["Refresh", "Add"]));

    const competitorLabels = result.labelsByRoute["/dashboard/competitors/[id]"];
    expect(competitorLabels).toEqual(expect.arrayContaining(["Delete", "Save changes"]));
  });

  it("caps labels per route via maxLabelsPerRoute", () => {
    const result = buildDigest(fixtureRepo, { maxLabelsPerRoute: 1 });
    for (const labels of Object.values(result.labelsByRoute)) {
      expect(labels.length).toBeLessThanOrEqual(1);
    }
  });

  it("scopes routes to an area prefix filter", () => {
    const result = buildDigest(fixtureRepo, { area: "/dashboard" });
    const paths = result.routes.map((r) => r.path).sort();
    expect(paths).toEqual(["/dashboard", "/dashboard/competitors/[id]"]);
    expect(paths).not.toContain("/login");
  });

  it("reports unknown framework for a non-Next.js repo", () => {
    const result = buildDigest(path.join(__dirname, "fixture", "lib"));
    expect(result.framework).toBe("unknown");
    expect(result.routes).toEqual([]);
  });
});

describe("formatDigest", () => {
  it("includes framework, sign-in, roles and routes in the text output", () => {
    const result = buildDigest(fixtureRepo);
    const text = formatDigest(result);
    expect(text).toContain("framework: nextjs-app");
    expect(text).toContain("sign-in: Auth.js");
    expect(text).toContain("admin");
    expect(text).toContain("/dashboard/competitors/[id]");
  });

  it("respects a small line cap by falling back to a per-route-group summary pointing at --area", () => {
    const result = buildDigest(fixtureRepo);
    const text = formatDigest(result, { maxLines: 8 });
    const lines = text.split("\n");
    expect(lines.length).toBeLessThanOrEqual(8);
    expect(result.truncated).toBe(true);
    expect(text).toMatch(/too many to list in full/);
    expect(text).toMatch(/--area/);
    expect(text).toMatch(/route\(s\)/);
  });

  it("does not mark truncated when everything fits", () => {
    const result = buildDigest(fixtureRepo);
    formatDigest(result, { maxLines: 200 });
    expect(result.truncated).toBe(false);
  });
});
