// One persona everywhere (build-plan.md M26): `start.signed_in_as` and `start.persona.role` are
// merged once at load, a conflict is an error naming both values and the line, and the merge
// stays in memory — an edit never writes the normalised fields back to YAML.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadWalkthroughText, WalkthroughValidationError } from "../../src/walkthrough/index.js";
import { setStepField } from "../../src/edit/index.js";

function yaml(start: string): string {
  return `walkthrough: admin-flow
title: Admin flow
start:
${start}
steps:
  - id: open
    do: click "Settings" button
`;
}

describe("persona normalisation", () => {
  it("turns signed_in_as alone into a persona object", () => {
    const wt = loadWalkthroughText(yaml("  signed_in_as: admin"));
    expect(wt.start?.persona).toEqual({ role: "admin" });
    expect(wt.start?.signed_in_as).toBe("admin");
  });

  it("fills signed_in_as from persona.role, keeping the rest of the persona", () => {
    const wt = loadWalkthroughText(yaml("  persona:\n    role: admin\n    name: Sam Organiser"));
    expect(wt.start?.signed_in_as).toBe("admin");
    expect(wt.start?.persona).toEqual({ role: "admin", name: "Sam Organiser" });
  });

  it("adds signed_in_as as the role of a persona that has none", () => {
    const wt = loadWalkthroughText(yaml("  signed_in_as: admin\n  persona:\n    name: Sam Organiser"));
    expect(wt.start?.persona).toEqual({ name: "Sam Organiser", role: "admin" });
  });

  it("accepts both when they agree", () => {
    const wt = loadWalkthroughText(yaml("  signed_in_as: admin\n  persona:\n    role: admin"));
    expect(wt.start?.persona).toEqual({ role: "admin" });
  });

  it("rejects an empty signed_in_as", () => {
    expect(() => loadWalkthroughText(yaml('  signed_in_as: ""'), "admin-flow.yaml")).toThrow(WalkthroughValidationError);
  });

  it("rejects both naming different roles, with both values and the line", () => {
    const text = yaml("  page: /settings\n  signed_in_as: admin\n  persona:\n    role: staff");
    let error: unknown;
    try {
      loadWalkthroughText(text, "admin-flow.yaml");
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(WalkthroughValidationError);
    const [e] = (error as WalkthroughValidationError).errors;
    expect(e.message).toContain('"admin"');
    expect(e.message).toContain('"staff"');
    expect(e.line).toBe(5);
    expect(e.path).toBe("start.signed_in_as");
    expect((error as Error).message).toContain("admin-flow.yaml:5");
  });

  it("leaves a walkthrough with no sign-in alone", () => {
    const wt = loadWalkthroughText(yaml("  page: /settings"));
    expect(wt.start).toEqual({ page: "/settings" });
  });

  it("never writes the normalised persona back to YAML on an edit", () => {
    const dir = mkdtempSync(join(tmpdir(), "aida-persona-edit-"));
    try {
      writeFileSync(join(dir, "next.config.mjs"), "export default {};\n");
      const file = join(dir, "admin-flow.yaml");
      writeFileSync(file, yaml("  signed_in_as: admin"));
      setStepField(file, "open", "say", "Open the settings.");
      const written = readFileSync(file, "utf8");
      expect(written).toContain("signed_in_as: admin");
      expect(written).not.toContain("persona");
      expect(written).toContain("Open the settings.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
