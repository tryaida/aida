// The in-app widget (help app public/widget.js) carries its own copy of `matchRoutePattern`, since
// it has no build step. Both copies get the same cases here so they can't drift apart.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { matchRoutePattern, normalizePathname } from "../../src/routes/pattern.js";

const WIDGET = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "help-app", "public", "widget.js");

type Match = (pattern: string, pathname: string) => boolean;
type Normalize = (input: string) => string;

function widgetCopy(): { matchRoutePattern: Match; normalizePathname: Normalize } {
  const src = readFileSync(WIDGET, "utf8");
  const found = /\/\/ <match-route-pattern>[^\n]*\n([\s\S]*?)\/\/ <\/match-route-pattern>/.exec(src);
  if (!found) throw new Error("widget.js lost its <match-route-pattern> markers");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- test-only: runs the widget's own copy
  return new Function(`${found[1]}\nreturn { matchRoutePattern, normalizePathname };`)() as { matchRoutePattern: Match; normalizePathname: Normalize };
}

const CASES: [string, string][] = [
  ["/", "/"],
  ["/", "/polls"],
  ["/polls", "/polls"],
  ["/polls", "/polls/"],
  ["/polls", "/polls?tab=open#top"],
  ["/polls", "/Polls"],
  ["/polls/*", "/polls/42"],
  ["/polls/*", "/polls"],
  ["/polls/*", "/polls/42/edit"],
  ["/polls/*/edit", "/polls/42/edit"],
  ["/polls/*/edit", "/polls/42/results"],
  ["/docs/**", "/docs"],
  ["/docs/**", "/docs/a/b/c"],
  ["/docs/**", "/doc"],
  ["/**", "/anything/at/all"],
  ["/settings/", "/settings"],
  ["settings", "/settings"],
  ["/a/*/c/**", "/a/b/c"],
  ["/a/*/c/**", "/a/b/d/e"],
  ["/teams/acme", "https://app.example.com/teams/acme?x=1"],
  ["/a//b", "/a/b"],
];

describe("widget.js matchRoutePattern", () => {
  const widget = widgetCopy();
  it.each(CASES)("%s against %s matches the engine", (pattern, path) => {
    expect(widget.matchRoutePattern(pattern, path)).toBe(matchRoutePattern(pattern, path));
  });

  it("normalizes paths the same way", () => {
    for (const input of ["http://localhost:3000/polls/abc/?tab=1#top", "https://example.com", "settings/", "/", "", "/a///"]) {
      expect(widget.normalizePathname(input), input).toBe(normalizePathname(input));
    }
  });
});
