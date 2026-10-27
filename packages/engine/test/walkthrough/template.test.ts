import { describe, expect, it } from "vitest";
import {
  findUnresolvedTemplates,
  resolveTemplate,
  resolveTemplatesDeep,
  UnresolvedTemplateError,
} from "../../src/walkthrough/index.js";

describe("resolveTemplate", () => {
  const data = { competitor: { firstName: "Sophie", lastName: "Harrington" } };

  it("substitutes a dotted path", () => {
    expect(resolveTemplate("{{competitor.firstName}}", data)).toBe("Sophie");
  });

  it("substitutes multiple placeholders", () => {
    expect(resolveTemplate("{{competitor.firstName}} {{competitor.lastName}}", data)).toBe(
      "Sophie Harrington",
    );
  });

  it("throws a short, path-naming error for an unresolved placeholder instead of leaving it in place", () => {
    // Regression: this used to silently return "{{missing.path}}" unchanged, which then got
    // passed straight through to a click/fill target and failed confusingly downstream.
    expect(() => resolveTemplate("{{missing.path}}", data)).toThrow(UnresolvedTemplateError);
    expect(() => resolveTemplate("{{missing.path}}", data)).toThrow(/missing\.path/);
  });

  it("resolves nested structures", () => {
    const action = { do: "type", target: { label: "x" }, text: "{{competitor.firstName}}" };
    expect(resolveTemplatesDeep(action, data)).toEqual({
      do: "type",
      target: { label: "x" },
      text: "Sophie",
    });
  });

  it("resolveTemplatesDeep also throws on an unresolved placeholder anywhere in the tree", () => {
    const action = { do: "type", target: { label: "x" }, text: "{{missing.path}}" };
    expect(() => resolveTemplatesDeep(action, data)).toThrow(UnresolvedTemplateError);
  });
});

describe("findUnresolvedTemplates", () => {
  const data = { competitor: { firstName: "Sophie" } };

  it("returns an empty list when everything resolves", () => {
    expect(findUnresolvedTemplates({ say: "Hi {{competitor.firstName}}" }, data)).toEqual([]);
  });

  it("reports every unresolved placeholder across a nested structure, without throwing", () => {
    const value = {
      steps: [
        { say: "Hi {{competitor.firstName}}" },
        { say: "Bye {{competitor.lastName}}" },
        { caption: "{{other.missing}}" },
      ],
    };
    expect(findUnresolvedTemplates(value, data).sort()).toEqual(
      ["competitor.lastName", "other.missing"].sort(),
    );
  });
});
