import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const actionFile = join(dirname(fileURLToPath(import.meta.url)), "../../../../action.yml");

describe("action.yml", () => {
  const action = YAML.parse(readFileSync(actionFile, "utf8")) as {
    inputs: Record<string, { description?: string }>;
    outputs: Record<string, { description?: string }>;
  };

  // GitHub evaluates `${{ }}` even inside metadata descriptions, where the `github` context
  // doesn't exist, and refuses to load the action ("Unrecognized named-value: 'github'").
  it("has no expressions in input or output descriptions", () => {
    for (const [name, spec] of [...Object.entries(action.inputs), ...Object.entries(action.outputs)]) {
      expect(spec.description ?? "", name).not.toContain("${{");
    }
  });

  it("installs the help app's packages after aida, before running it, on Node 22", () => {
    const raw = readFileSync(actionFile, "utf8");
    const steps = (action as unknown as { runs: { steps: Array<{ name?: string; run?: string; with?: Record<string, unknown> }> } }).runs.steps;
    const names = steps.map((s) => s.name ?? "");
    const aida = names.findIndex((n) => /^Install aida/.test(n));
    const help = names.indexOf("Install the help app's packages");
    expect(help).toBeGreaterThan(aida);
    expect(help).toBeLessThan(names.indexOf("Run aida ci"));
    expect(steps[help].run).toContain("packages/engine/dist/init/help-install.js");
    expect(raw).not.toMatch(/wait-on|npx --yes/);
    expect(steps.find((s) => s.with?.["node-version"])?.with?.["node-version"]).toBe(22);
  });

  it("has a publish input for refreshing docs on push to main", () => {
    expect(action.inputs.publish).toBeDefined();
  });
});
