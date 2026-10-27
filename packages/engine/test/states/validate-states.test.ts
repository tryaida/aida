import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validatePath } from "../../src/commands/validate.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-validate-states-"));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  for (const [name, extra] of Object.entries(files)) {
    writeFileSync(
      join(dir, `${name}.yaml`),
      `walkthrough: ${name}\ntitle: ${name}\n${/^steps:/m.test(extra) ? "" : "steps:\n  - do: go to /x\n"}${extra}`,
    );
  }
  return dir;
}

const byName = (results: ReturnType<typeof validatePath>, name: string) => results.find((r) => r.walkthrough === name || r.file.endsWith(`/${name}.yaml`))!;

describe("validate: data states across files", () => {
  it("passes a provider and its needer", () => {
    const dir = project({ p: "leaves: [x]\n", c: "needs: [x]\n" });
    const results = validatePath(dir, { states: {} });
    expect(results.every((r) => r.ok && !r.warnings)).toBe(true);
  });

  it("errors on an unknown state, suggesting a near name", () => {
    const dir = project({ p: "leaves: [session-full]\n", c: "needs: [sesion-full]\nclears: [nowhere]\n" });
    const c = byName(validatePath(dir, { states: {} }), "c");
    expect(c.ok).toBe(false);
    const messages = c.errors!.map((e) => e.message);
    expect(messages[0]).toContain("unknown state sesion-full");
    expect(messages[0]).toContain("did you mean session-full");
    expect(c.errors![0].line).toBe(5);
    expect(messages[1]).toContain("unknown state nowhere");
  });

  it("errors on a need nothing provides: a configured state with no hooks and no walkthrough leaving it", () => {
    const dir = project({ c: "needs: [x]\n" });
    const c = byName(validatePath(dir, { states: { x: {} } }), "c");
    expect(c.ok).toBe(false);
    expect(c.errors![0].message).toContain("nothing provides it");
    // A hook makes it fine.
    expect(byName(validatePath(dir, { states: { x: { setup: () => {} } } }), "c").ok).toBe(true);
  });

  it("only warns about an unprovided need when no config was given", () => {
    const dir = project({ c: "needs: [x]\n" });
    const c = byName(validatePath(dir), "c");
    expect(c.ok).toBe(true);
    expect(c.warnings![0].message).toContain("pass --config");
  });

  it("errors on a cycle, on each walkthrough in it", () => {
    const dir = project({ a: "needs: [y]\nleaves: [x]\n", b: "needs: [x]\nleaves: [y]\n" });
    const results = validatePath(dir, { states: {} });
    for (const name of ["a", "b"]) {
      const r = byName(results, name);
      expect(r.ok).toBe(false);
      expect(r.errors![0].message).toContain("need each other's data");
    }
  });

  it("warns when {{run.id}} reaches the screen or narration, directly or through data", () => {
    const dir = project({
      a: `data:\n  session: { name: "Morning {{run.id}}" }\nsetup:\n  steps:\n    - do: fill "Name" with "{{session.name}}"\n`,
      b: `data:\n  session: { name: "Morning {{run.id}}" }\nsteps:\n  - do: fill "Name" with "{{session.name}}"\n    say: Name it {{run.id}}\n`,
    });
    const results = validatePath(dir, { states: {} });
    expect(byName(results, "a").warnings).toBeUndefined();
    const b = byName(results, "b");
    expect(b.ok).toBe(true);
    const warnings = b.warnings!.map((w) => w.message);
    expect(warnings.some((m) => m.includes("typed text, through data session.name"))).toBe(true);
    expect(warnings.some((m) => m.includes("(say)"))).toBe(true);
  });

  it("errors on an unresolved template in setup steps", () => {
    const dir = project({ a: `setup:\n  steps:\n    - do: fill "Name" with "{{nope}}"\n` });
    const a = byName(validatePath(dir, { states: {} }), "a");
    expect(a.ok).toBe(false);
    expect(a.errors![0].message).toContain("{{nope}} in setup steps");
  });

  it("doesn't count a walkthrough as its own provider: needs and leaves the same state", () => {
    const dir = project({ again: "needs: [x]\nleaves: [x]\n" });
    const again = byName(validatePath(dir, { states: {} }), "again");
    expect(again.ok).toBe(false);
    expect(again.errors![0].message).toContain("again both needs and leaves x");
    // Another walkthrough leaving it, or a hook, makes it fine.
    expect(byName(validatePath(project({ again: "needs: [x]\nleaves: [x]\n", first: "leaves: [x]\n" }), { states: {} }), "again").ok).toBe(true);
    expect(byName(validatePath(dir, { states: { x: { setup: () => {} } } }), "again").ok).toBe(true);
    // Without --config it's a warning with the same words.
    expect(byName(validatePath(dir), "again").warnings![0].message).toContain("both needs and leaves x");
  });

  it("warns when setup.as or a needed state's as isn't a known role", () => {
    const dir = project({
      a: "start:\n  page: /\n  signed_in_as: office_staff\nneeds: [x]\nsetup:\n  as: admn\n  steps:\n    - do: go to /y\n",
    });
    const a = byName(validatePath(dir, { states: { x: { setup: () => {}, as: "judge" } }, roles: { admin: "an organiser" } }), "a");
    expect(a.ok).toBe(true);
    const warnings = a.warnings!.map((w) => w.message);
    expect(warnings.some((m) => m.includes("config states.x.as is judge, which isn't a known role (known roles: admin, office_staff)"))).toBe(true);
    expect(warnings.some((m) => m.startsWith("setup.as is admn, which isn't a known role"))).toBe(true);
    // Known roles: no warning.
    const ok = byName(validatePath(dir, { states: { x: { setup: () => {}, as: "admin" } }, roles: { admin: "x", admn: "y" } }), "a");
    expect(ok.warnings).toBeUndefined();
  });

  it("validating one file reads its siblings for who leaves what, but reports only that file", () => {
    const dir = project({ p: "leaves: [x]\nneeds: [unknown-thing]\n", c: "needs: [x]\n" });
    const results = validatePath(join(dir, "c.yaml"), { states: {} });
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
  });
});
