// `aida inspect --as <role>`: signs in as a walkthrough's persona, or as a role the config names
// before any walkthrough uses it.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configRoles, resolvePersona } from "../../src/commands/inspect.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aida-persona-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function walkthrough(id: string, role: string): void {
  writeFileSync(
    path.join(dir, `${id}.yaml`),
    `walkthrough: ${id}\nversion: 1\ntitle: T\nstart:\n  persona: { role: ${role}, email: ${role}@example.com }\n  page: /\nsteps:\n  - id: s\n    title: S\n    check: text "A" is visible\n`,
  );
}

describe("resolvePersona", () => {
  it("prefers a walkthrough's full persona", () => {
    walkthrough("a", "admin");
    expect(resolvePersona(dir, "admin", ["admin"])).toEqual({ role: "admin", email: "admin@example.com" });
  });

  it("signs in as a role only the config names", () => {
    expect(resolvePersona(dir, "organizer", ["organizer"])).toEqual({ role: "organizer" });
  });

  it("refuses a role nothing names, and says how to add it", () => {
    expect(() => resolvePersona(dir, "organiser", ["organizer"])).toThrow(/add it to `roles`/);
  });
});

describe("configRoles", () => {
  it("lists roles keys and readers", () => {
    expect(configRoles({ roles: { admin: "an admin" }, readers: ["guest"] })).toEqual(["admin", "guest"]);
    expect(configRoles({})).toEqual([]);
  });
});
