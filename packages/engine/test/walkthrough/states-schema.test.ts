import { describe, expect, it } from "vitest";
import {
  findUnresolvedTemplates,
  loadWalkthroughText,
  resolveTemplatesDeep,
  WalkthroughValidationError,
  withRunValues,
  newRunId,
} from "../../src/walkthrough/index.js";

const base = `
walkthrough: overbook-a-session
title: Overbook a session
steps:
  - do: go to /sessions
`;

function errorsOf(yaml: string): string[] {
  try {
    loadWalkthroughText(yaml, "t.yaml");
  } catch (err) {
    if (err instanceof WalkthroughValidationError) return err.errors.map((e) => `${e.path}: ${e.message}`);
    throw err;
  }
  return [];
}

describe("needs / leaves / clears / setup", () => {
  it("accepts the full shape and turns setup steps into actions", () => {
    const wt = loadWalkthroughText(
      `${base}
needs: [session-full]
leaves: [alex-on-waitlist]
clears: [alex-in-morning]
setup:
  as: admin
  steps:
    - id: open-sessions
      do: go to /admin/sessions
    - do: click "Add session" button
      check: text "Session added" is visible
`,
    );
    expect(wt.needs).toEqual(["session-full"]);
    expect(wt.leaves).toEqual(["alex-on-waitlist"]);
    expect(wt.clears).toEqual(["alex-in-morning"]);
    expect(wt.setup?.as).toBe("admin");
    expect(wt.setup?.steps).toHaveLength(2);
    expect(wt.setup?.steps[0]).toMatchObject({ id: "open-sessions", actions: [{ do: "goto", path: "/admin/sessions" }] });
    expect(wt.setup?.steps[1].actions.map((a) => a.do)).toEqual(["click", "expect"]);
  });

  it("leaves the fields off a walkthrough that doesn't use them", () => {
    const wt = loadWalkthroughText(base);
    expect("needs" in wt).toBe(false);
    expect("setup" in wt).toBe(false);
  });

  it("rejects state names that aren't kebab-case, and duplicates", () => {
    expect(errorsOf(`${base}\nneeds: [Session_Full]\n`).join()).toContain("kebab-case");
    expect(errorsOf(`${base}\nneeds: [session--full]\n`).join()).toContain("kebab-case");
    expect(errorsOf(`${base}\nleaves: [x, x]\n`).join()).toContain("listed twice");
  });

  it("rejects a state that's both left and cleared", () => {
    expect(errorsOf(`${base}\nleaves: [x]\nclears: [x]\n`).join()).toContain("in both `leaves` and `clears`");
  });

  it("rejects narration in a setup step, with a reason", () => {
    const errors = errorsOf(`${base}\nsetup:\n  steps:\n    - do: go to /x\n      say: hello\n`);
    expect(errors.join()).toContain("setup steps aren't recorded or narrated");
    expect(errors[0]).toMatch(/^setup\.steps\.0\.say/);
  });

  it("rejects an empty setup and a setup step with nothing to do", () => {
    expect(errorsOf(`${base}\nsetup:\n  steps: []\n`)).not.toEqual([]);
    expect(errorsOf(`${base}\nsetup:\n  steps:\n    - id: nothing\n`).join()).toContain("needs `do`, `check` or `actions:`");
  });

  it("rejects unknown setup fields", () => {
    expect(errorsOf(`${base}\nsetup:\n  persona: admin\n  steps:\n    - do: go to /x\n`)).not.toEqual([]);
  });
});

describe("{{run.id}}", () => {
  it("reserves `run` in data", () => {
    const errors = errorsOf(`${base}\ndata:\n  run: { id: fixed }\n`);
    expect(errors.join()).toContain("`run` is reserved");
    expect(errors[0]).toMatch(/^data\.run/);
  });

  it("isn't an unresolved template", () => {
    expect(findUnresolvedTemplates(["{{run.id}}", "{{run.other}}", "{{missing}}"], {})).toEqual(["run.other", "missing"]);
  });

  it("resolves in data values and steps, the same id everywhere", () => {
    const data = withRunValues({ session: { name: "Morning {{run.id}}" }, other: "{{not.run}}" }, { id: "k3x9p2" });
    expect(data).toEqual({ session: { name: "Morning k3x9p2" }, other: "{{not.run}}", run: { id: "k3x9p2" } });
    expect(resolveTemplatesDeep(["{{session.name}}", "id {{ run.id }}"], data)).toEqual(["Morning k3x9p2", "id k3x9p2"]);
  });

  it("is short and differs between runs", () => {
    const a = newRunId();
    expect(a).toMatch(/^[a-z0-9]{6}$/);
    expect(new Set(Array.from({ length: 20 }, newRunId)).size).toBeGreaterThan(1);
  });
});
