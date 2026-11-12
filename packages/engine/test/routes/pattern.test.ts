import { describe, expect, it } from "vitest";
import { looksLikeId, matchRoutePattern, normalizePathname, routePatternFor, routeToPattern } from "../../src/routes/pattern.js";

describe("normalizePathname", () => {
  it("drops origin, query, hash and trailing slash", () => {
    expect(normalizePathname("http://localhost:3000/polls/abc/?tab=1#top")).toBe("/polls/abc");
    expect(normalizePathname("https://example.com")).toBe("/");
    expect(normalizePathname("settings/")).toBe("/settings");
    expect(normalizePathname("/")).toBe("/");
  });
});

describe("routeToPattern", () => {
  it("turns framework routes into screen patterns", () => {
    expect(routeToPattern("/polls/[id]/edit")).toBe("/polls/*/edit");
    expect(routeToPattern("/docs/[...slug]")).toBe("/docs/**");
    expect(routeToPattern("/docs/[[...slug]]")).toBe("/docs/**");
    expect(routeToPattern("/users/:id")).toBe("/users/*");
    expect(routeToPattern("/(app)/settings/@modal/team")).toBe("/settings/team");
    expect(routeToPattern("/polls/*/edit")).toBe("/polls/*/edit");
  });
});

describe("looksLikeId", () => {
  it("spots numbers, UUIDs, hashes and generated ids", () => {
    for (const id of ["42", "3f2b8c1e-9a4d-4e21-b7c6-0d5e8f1a2b3c", "9f86d081884c7d65", "clx9f2k3a0001qwer", "V1StGXR8_Z5jdHi6B-myT"]) {
      expect(looksLikeId(id), id).toBe(true);
    }
  });

  it("leaves screen names alone", () => {
    for (const name of ["settings", "new", "step-2", "q3-report", "2024-plan", "billing-history", "oauth2"]) {
      expect(looksLikeId(name), name).toBe(false);
    }
  });
});

describe("routePatternFor", () => {
  it("prefers the most specific known route", () => {
    const routes = ["/polls/[id]", "/polls/new", "/polls/[id]/edit", "/[...rest]"];
    expect(routePatternFor("/polls/new", routes)).toBe("/polls/new");
    expect(routePatternFor("/polls/abc", routes)).toBe("/polls/*");
    expect(routePatternFor("/polls/abc/edit?x=1", routes)).toBe("/polls/*/edit");
    expect(routePatternFor("/somewhere/else", routes)).toBe("/**");
  });

  it("falls back to id-looking segments when no route is known", () => {
    expect(routePatternFor("/invoices/1042/lines")).toBe("/invoices/*/lines");
    expect(routePatternFor("/settings/team")).toBe("/settings/team");
    expect(routePatternFor("http://localhost:3000/")).toBe("/");
  });
});

describe("matchRoutePattern", () => {
  it("matches one segment per star and the rest per double star", () => {
    expect(matchRoutePattern("/polls/*/edit", "/polls/xyz/edit/")).toBe(true);
    expect(matchRoutePattern("/polls/*/edit", "/polls/xyz")).toBe(false);
    expect(matchRoutePattern("/polls/*", "/polls/xyz/edit")).toBe(false);
    expect(matchRoutePattern("/docs/**", "/docs")).toBe(true);
    expect(matchRoutePattern("/docs/**", "/docs/a/b")).toBe(true);
    expect(matchRoutePattern("/", "/")).toBe(true);
    expect(matchRoutePattern("/", "/polls")).toBe(false);
    expect(matchRoutePattern("/settings", "/settings?tab=team#x")).toBe(true);
  });
});
