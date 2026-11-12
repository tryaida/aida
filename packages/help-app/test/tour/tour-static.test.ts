import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// public/tour.js (M46) promises never to read what a reader types, never to act for them, and
// never to get in the app's way. These checks hold the code to that; the engine's
// test/tours/tour-browser.test.ts drives it in a real browser.
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../public/tour.js"), "utf8");
// Comments say what the file never does; only the code counts here.
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("public/tour.js", () => {
  it("has no way to read a typed value", () => {
    expect(code).not.toMatch(/\.value\b/);
    expect(code).not.toMatch(/selectionStart|selectedIndex|selectedOptions|FormData|innerText/);
    // The one `value` it reads is an input button's label attribute.
    expect(code.match(/getAttribute\("value"\)/g)).toHaveLength(1);
  });

  it("never acts for the reader or blocks the app", () => {
    expect(code).not.toMatch(/\.click\(\)|dispatchEvent\((?!new CustomEvent\("aida-tour")|\.submit\(\)|\.requestSubmit\(/);
    expect(code).not.toMatch(/preventDefault|stopPropagation|stopImmediatePropagation/);
    expect(code).not.toMatch(/history\.(pushState|replaceState)\s*=/);
    expect(code).not.toMatch(/\.prototype\.\w+\s*=/);
    // Every listener on window is passive.
    for (const m of code.matchAll(/window\.addEventListener\(([^)]*)\)/g)) expect(m[1]).toMatch(/LISTEN|passive/);
  });

  it("puts text in through textContent only, builds no code and escapes selectors", () => {
    expect(code).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(code).not.toMatch(/\beval\(|new Function|setTimeout\(\s*["'`]/);
    expect(code).toMatch(/CSS\.escape/);
    expect(code).not.toMatch(/querySelector(All)?\([^)]*\+/); // selectors are built in one escaped place
  });

  it("sends nothing: the only requests are GETs of the tour file and the brand theme, without a referrer", () => {
    const fetches = [...code.matchAll(/fetch\(([^,]+),\s*\{([^}]*)\}/g)];
    expect(fetches.map((m) => m[1]!.trim())).toEqual(['helpUrl + "/brand/theme.json"', 'base + "/tours/" + id + ".json"']);
    expect(code.match(/\bfetch\(/g)).toHaveLength(2);
    for (const m of fetches) {
      expect(m[2]).not.toMatch(/method|body/);
      // The app's address (and any token in its query) never reaches the help site's logs.
      expect(m[2]).toMatch(/referrerPolicy: "no-referrer"/);
    }
    expect(code).not.toMatch(/sendBeacon|XMLHttpRequest|WebSocket|navigator\.sendBeacon/);
  });

  it("takes the help site and base path only from its script tag or a start() call, never from saved state", () => {
    expect(code).toMatch(/currentScript\.getAttribute\("data-help-url"\)/);
    expect(code).toMatch(/currentScript\.getAttribute\("data-base-path"\)/);
    expect(code).not.toMatch(/params\.get\("(help|base)/);
    // The only `.helpUrl`/`.basePath` read is the start() caller's.
    for (const m of code.matchAll(/(\w+)\.(helpUrl|basePath)\b/g)) expect(m[1]).toBe("opts");
    // What it saves in the tab holds neither.
    const saved = [...code.matchAll(/sessionStorage\.setItem\([^,]+,\s*JSON\.stringify\(\{([^}]*)\}/g)];
    expect(saved.length).toBeGreaterThan(0);
    for (const m of saved) expect(m[1]).not.toMatch(/helpUrl|basePath/);
  });
});
