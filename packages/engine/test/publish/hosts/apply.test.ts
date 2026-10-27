// docs/build-plan.md M13 "Tests: ... idempotent apply" — apply() never overwrites a file the
// user has already changed, same rule as init/copy-template.ts.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createVercelAdapter } from "../../../src/publish/hosts/vercel.js";
import { createStaticAdapter } from "../../../src/publish/hosts/static.js";
import { cleanupTmpDirs, makeHelpRoot, makeResolvedConfig } from "../helpers.js";

afterEach(cleanupTmpDirs);

describe("apply() idempotency", () => {
  it("writes a host config file that doesn't exist yet", async () => {
    const helpRoot = makeHelpRoot();
    const adapter = createVercelAdapter();
    const plan = await adapter.plan(helpRoot, makeResolvedConfig());
    const result = await adapter.apply(helpRoot, plan);
    expect(result.files).toEqual([{ path: "vercel.json", action: "written" }]);
    expect(existsSync(join(helpRoot, "vercel.json"))).toBe(true);
  });

  it("never overwrites a vercel.json the user already changed, and reports it skipped", async () => {
    const helpRoot = makeHelpRoot();
    writeFileSync(join(helpRoot, "vercel.json"), '{\n  "custom": true\n}\n');
    const adapter = createVercelAdapter();
    const plan = await adapter.plan(helpRoot, makeResolvedConfig());
    const result = await adapter.apply(helpRoot, plan);
    expect(result.files[0].action).toBe("skipped");
    expect(readFileSync(join(helpRoot, "vercel.json"), "utf8")).toContain("custom");
  });

  it("running apply() twice is a no-op the second time (idempotent)", async () => {
    const helpRoot = makeHelpRoot();
    const adapter = createVercelAdapter();
    const plan = await adapter.plan(helpRoot, makeResolvedConfig());
    await adapter.apply(helpRoot, plan);
    const contentsAfterFirst = readFileSync(join(helpRoot, "vercel.json"), "utf8");
    const second = await adapter.apply(helpRoot, plan);
    expect(second.files[0].action).toBe("skipped");
    expect(readFileSync(join(helpRoot, "vercel.json"), "utf8")).toBe(contentsAfterFirst);
  });

  it("static's special-case merge into next.config.mjs is also idempotent", async () => {
    const helpRoot = makeHelpRoot();
    const adapter = createStaticAdapter();
    const plan1 = await adapter.plan(helpRoot, makeResolvedConfig());
    const first = await adapter.apply(helpRoot, plan1);
    expect(first.files[0].action).toBe("written");
    const contentsAfterFirst = readFileSync(join(helpRoot, "next.config.mjs"), "utf8");

    const plan2 = await adapter.plan(helpRoot, makeResolvedConfig());
    const second = await adapter.apply(helpRoot, plan2);
    expect(second.files[0].action).toBe("skipped");
    expect(readFileSync(join(helpRoot, "next.config.mjs"), "utf8")).toBe(contentsAfterFirst);
  });
});
