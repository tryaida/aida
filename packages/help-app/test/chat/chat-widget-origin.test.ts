import { describe, expect, it } from "vitest";
import { helpSiteOrigin, withOrigin } from "../../components/chat/ChatWidget";

// review finding ChatWidget.tsx:146,139: citation hrefs and screenshot src came back as
// root-relative paths from the help site's own API (e.g. "/add-competitor",
// "/screenshots/add-competitor/step-01.png"). Rendered on the help site that's fine, but the
// in-app widget (public/widget.js) embeds this component on the host app's own origin, where a
// root-relative href/src resolves against the wrong origin and 404s.

describe("withOrigin", () => {
  it("prefixes a root-relative path with the given origin", () => {
    expect(withOrigin("/add-competitor", "https://help.example.com")).toBe("https://help.example.com/add-competitor");
  });

  it("adds a leading slash when the path is missing one", () => {
    expect(withOrigin("screenshots/step-01.png", "https://help.example.com")).toBe(
      "https://help.example.com/screenshots/step-01.png",
    );
  });

  it("leaves the path unchanged when origin is undefined (e.g. SSR, or same-origin apiBase)", () => {
    expect(withOrigin("/add-competitor", undefined)).toBe("/add-competitor");
  });

  it("leaves an already-absolute URL unchanged, even with an origin given", () => {
    expect(withOrigin("https://cdn.example.com/x.png", "https://help.example.com")).toBe("https://cdn.example.com/x.png");
  });
});

describe("helpSiteOrigin", () => {
  it("returns undefined outside the browser (SSR) — no `window` to resolve against", () => {
    expect(helpSiteOrigin("https://help.example.com/api/chat")).toBeUndefined();
    expect(helpSiteOrigin("/api/chat")).toBeUndefined();
  });
});
