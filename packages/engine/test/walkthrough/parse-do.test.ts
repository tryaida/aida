import { describe, expect, it } from "vitest";
import { parseDoString } from "../../src/walkthrough/index.js";

describe("parseDoString", () => {
  it("parses click", () => {
    expect(parseDoString('click "Add competitor" button')).toEqual([
      { do: "click", target: { role: "button", name: "Add competitor" } },
    ]);
  });

  it("parses fill", () => {
    expect(parseDoString('fill "First name" with "Jordan"')).toEqual([
      { do: "type", target: { label: "First name" }, text: "Jordan" },
    ]);
  });

  it("parses select into a single select action", () => {
    expect(parseDoString('select "Class" option "Open"')).toEqual([
      { do: "select", target: { label: "Class" }, option: "Open" },
    ]);
  });

  it("parses expect text", () => {
    expect(parseDoString('expect text "Competitor added"')).toEqual([
      { do: "expect", target: { text: "Competitor added" } },
    ]);
  });

  it("parses go to", () => {
    expect(parseDoString("go to /competitors")).toEqual([
      { do: "goto", path: "/competitors" },
    ]);
  });

  it("parses wait for url with a glob, anchored on the path", () => {
    expect(parseDoString("wait for url /competitors/*")).toEqual([
      { do: "waitForUrl", pattern: "^[^?#]*://[^/]+/competitors/[^?#]*(?:[?#].*)?$" },
    ]);
  });

  it("throws a short error for unrecognised text", () => {
    expect(() => parseDoString("do something weird")).toThrow(/unrecognised/);
  });
});

describe("waitForUrl pattern vs page.waitForURL", () => {
  // page.waitForURL tests the RegExp against the FULL url (scheme + host + path),
  // never just the path — the pattern must match a complete URL, not only `/x/*`.
  it("matches a full URL for the generated glob pattern", () => {
    const [{ pattern }] = parseDoString("wait for url /competitors/*") as [{ pattern: string }];
    const re = new RegExp(pattern);
    expect(re.test("https://app.example.com/competitors/123")).toBe(true);
    expect(re.test("https://app.example.com/competitors/123?tab=entries")).toBe(true);
    expect(re.test("https://app.example.com/other")).toBe(false);
  });

  it("matches an exact (non-glob) path, with or without a trailing query", () => {
    const [{ pattern }] = parseDoString("wait for url /competitors") as [{ pattern: string }];
    const re = new RegExp(pattern);
    expect(re.test("https://app.example.com/competitors")).toBe(true);
    expect(re.test("https://app.example.com/competitors?page=2")).toBe(true);
    expect(re.test("https://app.example.com/competitors/123")).toBe(false);
  });
});
