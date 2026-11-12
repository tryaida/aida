import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildHelpMap } from "../../src/help-map/index.js";
import type { Procedure } from "../../src/procedures/index.js";
import type { Walkthrough } from "../../src/walkthrough/index.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function proc(id: string, title: string, extra: Partial<Procedure> = {}): Procedure {
  return {
    id,
    title,
    url: `/how-do-i/${id}`,
    start: { page: "/" },
    steps: [
      { n: 1, title: "One", instruction: "Do one." },
      { n: 2, title: "Two", instruction: "Do two." },
    ],
    ...extra,
  };
}

describe("buildHelpMap", () => {
  it("names each guide's start screen and the screens it passes through as patterns", () => {
    const map = buildHelpMap({
      procedures: [
        proc("edit-poll", "Edit a poll", {
          start: { page: "/polls/3f2b8c1e-9a4d-4e21-b7c6-0d5e8f1a2b3c" },
          impactRoutes: [
            "/polls/3f2b8c1e-9a4d-4e21-b7c6-0d5e8f1a2b3c",
            "/polls/3f2b8c1e-9a4d-4e21-b7c6-0d5e8f1a2b3c/edit?tab=questions",
            "/polls/42/edit",
            "/api/polls/42",
            "/_next/data/build/polls.json",
            "/exports/polls.csv",
            "/trpc/poll.update",
          ],
          paths: [{ id: "from-list", title: "From the list", when: "When you start on the list.", start: { page: "/polls" }, steps: [] }],
        }),
      ],
    });
    expect(map).toEqual({
      version: 1,
      guides: [
        {
          id: "edit-poll",
          title: "Edit a poll",
          url: "/how-do-i/edit-poll",
          steps: 2,
          starts: "/polls/*",
          screens: ["/polls", "/polls/*/edit"],
        },
      ],
    });
  });

  it("prefers the app's own routes, and reads a start page written in framework form", () => {
    const map = buildHelpMap({
      knownRoutes: ["/teams/[team]/settings", "/teams/[team]/members/[member]", "/[[...slug]]"],
      procedures: [
        proc("rename-team", "Rename a team", {
          start: { page: "/teams/acme/settings" },
          impactRoutes: ["/teams/acme/members/sam", "/about/acme"],
        }),
        proc("open-attendee", "Open an attendee", { start: { page: "/attendees/[id]" } }),
      ],
    });
    const byId = Object.fromEntries(map.guides.map((g) => [g.id, g]));
    expect(byId["rename-team"]!.starts).toBe("/teams/*/settings");
    // The root catch-all would match every screen, so the plain path stands instead.
    expect(byId["rename-team"]!.screens).toEqual(["/about/acme", "/teams/*/members/*"]);
    expect(byId["open-attendee"]!.starts).toBe("/attendees/*");
  });

  it("ignores app routes with no literal segment, so a locale catch-all can't claim every screen", () => {
    const map = buildHelpMap({
      knownRoutes: ["/[locale]/[[...slug]]", "/[locale]/polls/[id]", "/**"],
      procedures: [proc("reports", "Read a report", { start: { page: "/en/reports" }, impactRoutes: ["/en/polls/42", "/en/reports/weekly"] })],
    });
    expect(map.guides[0]).toMatchObject({ starts: "/en/reports", screens: ["/*/polls/*", "/en/reports/weekly"] });
  });

  it("makes every pattern relative to the app's base path, leaving out screens outside it", () => {
    const procedures = [
      proc("edit-poll", "Edit a poll", {
        start: { page: "/polls" },
        impactRoutes: ["/app/polls", "/app/polls/42", "/app/polls/42/edit", "/app", "/elsewhere/polls"],
        paths: [{ id: "from-new", title: "From a new poll", when: "When you start from a new poll.", start: { page: "/polls/new" }, steps: [] }],
      }),
    ];
    const map = buildHelpMap({ basePath: "/app/", knownRoutes: ["/polls/[id]/edit"], procedures });
    expect(map.guides[0]).toMatchObject({ starts: "/polls", screens: ["/", "/polls/*", "/polls/*/edit", "/polls/new"] });
    // No base path (or "/"): recorded pathnames are used as they are.
    for (const basePath of [undefined, "/", ""]) {
      expect(buildHelpMap({ basePath, procedures }).guides[0]!.screens).toEqual(["/app", "/app/polls", "/app/polls/*", "/app/polls/*/edit", "/elsewhere/polls", "/polls/new"]);
    }
  });

  it("turns the walkthrough's own demo values into `*`, but not screen names", () => {
    const wf = {
      walkthrough: "rename-team",
      title: "Rename a team",
      data: { team: { name: "Acme Events", handle: "{{team.short}}-west", short: "globex" }, tab: "settings", section: "reports", lang: "en" },
      steps: [],
    } as unknown as Walkthrough;
    const procedures = [
      proc("rename-team", "Rename a team", {
        start: { page: "/teams/acme-events/settings" },
        impactRoutes: ["/teams/Globex-West/members", "/teams/Acme%20Events", "/reports", "/en/settings", "/acme-events/billing"],
      }),
      proc("other", "Other", { start: { page: "/teams/acme-events/settings" } }),
    ];
    const map = buildHelpMap({ procedures, walkthroughs: [wf] });
    const byId = Object.fromEntries(map.guides.map((g) => [g.id, g]));
    // "settings" is a demo value too, but after a record it names the screen; "reports" alone
    // would be `/*`, every one-segment screen; two-letter values are left alone.
    expect(byId["rename-team"]).toMatchObject({ starts: "/teams/*/settings", screens: ["/*/billing", "/en/settings", "/reports", "/teams/*", "/teams/*/members"] });
    // Only a walkthrough's own data counts.
    expect(byId["other"]!.starts).toBe("/teams/acme-events/settings");
    // The app's own routes still win when one matches.
    expect(buildHelpMap({ procedures, walkthroughs: [wf], knownRoutes: ["/teams/[team]/[tab]"] }).guides.find((g) => g.id === "rename-team")!.starts).toBe("/teams/*/*");
  });

  it("only treats download and asset extensions as files, and never the start page", () => {
    const map = buildHelpMap({
      procedures: [
        proc("site", "Open a site", {
          start: { page: "/sites/example.com" },
          impactRoutes: ["/u/jane.doe", "/releases/v1.2", "/exports/polls.CSV", "/files/logo.png", "/report.pdf"],
        }),
        proc("pdf", "Read the PDF", { start: { page: "/files/handbook.pdf" } }),
      ],
    });
    const byId = Object.fromEntries(map.guides.map((g) => [g.id, g]));
    expect(byId["site"]).toMatchObject({ starts: "/sites/example.com", screens: ["/releases/v1.2", "/u/jane.doe"] });
    expect(byId["pdf"]!.starts).toBe("/files/handbook.pdf");
  });

  it("only lists the procedures it is given, once each, sorted by title", () => {
    const map = buildHelpMap({
      procedures: [proc("b", "Record a payment"), proc("a", "Add a member"), proc("c", "Add a member"), proc("a", "Add a member")],
    });
    expect(map.guides.map((g) => g.id)).toEqual(["a", "c", "b"]);
  });

  it("marks tours, carries audience and a plain summary, and drops guides whose URL would leave the site", () => {
    const wf = {
      walkthrough: "a",
      title: "Add a member",
      summary: "Invite **someone** to {{team.name}}.",
      data: { team: { name: "Acme" } },
      steps: [],
    } as unknown as Walkthrough;
    const map = buildHelpMap({
      procedures: [proc("a", "Add a member", { for: "office staff" }), proc("evil", "Evil", { url: "//evil.example.com/x" }), proc("b", "Other")],
      tourIds: ["a", "not-published"],
      walkthroughs: [wf],
    });
    expect(map.guides.map((g) => g.id)).toEqual(["a", "b"]);
    expect(map.guides[0]).toMatchObject({ tour: true, for: "office staff", summary: "Invite someone to Acme." });
    expect(map.guides[1]!.tour).toBeUndefined();
    expect(map.guides[1]!.summary).toBeUndefined();
  });

  it("leaves `starts` out when the walkthrough names no start page", () => {
    const map = buildHelpMap({ procedures: [proc("a", "A", { start: {}, impactRoutes: ["/members"] })] });
    expect(map.guides[0]!.starts).toBeUndefined();
    expect(map.guides[0]!.screens).toEqual(["/members"]);
  });

  it("writes the same bytes for the same input, with no timestamps", () => {
    const dir = mkdtempSync(join(tmpdir(), "aida-help-map-"));
    tmpDirs.push(dir);
    // Two guides share a title, so the order between them comes from the id tie-break.
    const procedures = [proc("b", "B", { impactRoutes: ["/z", "/a", "/m"] }), proc("y", "A"), proc("a", "A", { lastChecked: "2026-01-01T00:00:00Z" }), proc("x", "A")];
    const first = buildHelpMap({ procedures, publicDir: dir });
    const bytes = readFileSync(join(dir, "help-map.json"), "utf8");
    buildHelpMap({ procedures: [...procedures].reverse(), publicDir: dir });
    expect(readFileSync(join(dir, "help-map.json"), "utf8")).toBe(bytes);
    expect(JSON.parse(bytes)).toEqual(first);
    expect(bytes).not.toMatch(/2026/);
    expect(first.guides.map((g) => g.id)).toEqual(["a", "x", "y", "b"]);
    expect(first.guides[3]!.screens).toEqual(["/a", "/m", "/z"]);
  });
});
