// The help app's README is copied into every user's `help/` folder by `aida init`, so every local
// path it names must exist in the template, and docs in the AIDA repo are linked, not named as
// local paths (they don't exist inside a user's help folder).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEMPLATE_DIR, listTemplateFiles } from "../../src/init/copy-template.js";

const README = readFileSync(join(TEMPLATE_DIR, "README.md"), "utf8");

describe("help app template README", () => {
  it("is copied by aida init", () => {
    expect(listTemplateFiles(TEMPLATE_DIR)).toContain("README.md");
  });

  it("names only paths that exist in the help folder", () => {
    const code = [...README.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
    const paths = code.filter((c) => /^(app|components|lib|content|public|walkthroughs)\//.test(c) || /^[\w.-]+\.(ts|tsx|md|json|js)$/.test(c));
    expect(paths.length).toBeGreaterThan(3);
    for (const p of paths) {
      // Files aida build writes, or that init writes per app, aren't in the template itself.
      if (/^content\/docs\/$|^aida\.config\.ts$|^llms\.txt$/.test(p)) continue;
      expect(existsSync(join(TEMPLATE_DIR, p)), p).toBe(true);
    }
  });

  it("links AIDA's own docs instead of naming repo paths", () => {
    const outsideLinks = README.replace(/\]\(https:\/\/github\.com\/tryaida\/aida\/[^)]*\)/g, "](link)").replace(/\[[^\]]*\]\(link\)/g, "");
    expect(outsideLinks).not.toMatch(/packages\/|help-app\/|docs\/(scope|decisions|setup)\.md|#\d+/);
    for (const m of README.matchAll(/https:\/\/github\.com\/tryaida\/aida\/blob\/main\/([^)#\s]+)/g)) {
      expect(existsSync(join(TEMPLATE_DIR, "..", "..", m[1])) || !existsSync(join(TEMPLATE_DIR, "..", "..", "docs")), m[1]).toBe(true);
    }
  });
});
