// Snapshot-style assertions on each host adapter's `plan()` output — docs/build-plan.md M13
// "Tests: plan output per host (snapshot)".
import { afterEach, describe, expect, it } from "vitest";
import { createVercelAdapter } from "../../../src/publish/hosts/vercel.js";
import { createNetlifyAdapter } from "../../../src/publish/hosts/netlify.js";
import { createAmplifyAdapter } from "../../../src/publish/hosts/amplify.js";
import { createCloudflareAdapter } from "../../../src/publish/hosts/cloudflare.js";
import { createNodeAdapter } from "../../../src/publish/hosts/node.js";
import { createStaticAdapter } from "../../../src/publish/hosts/static.js";
import { getHostAdapter, listHosts } from "../../../src/publish/hosts/registry.js";
import { cleanupTmpDirs, makeHelpRoot, makeResolvedConfig } from "../helpers.js";

afterEach(cleanupTmpDirs);

describe("host adapter plans", () => {
  it("lists exactly the six hosts docs/scope.md's host table names", () => {
    expect(listHosts().sort()).toEqual(["amplify", "cloudflare", "netlify", "node", "static", "vercel"].sort());
  });

  it("vercel: writes vercel.json, plans preview + --prod commands, needs VERCEL_TOKEN", async () => {
    const helpRoot = makeHelpRoot();
    const plan = await createVercelAdapter().plan(helpRoot, makeResolvedConfig());
    expect(plan.files.map((f) => f.path)).toEqual(["vercel.json"]);
    expect(plan.commands.some((c) => c.args.includes("--prod"))).toBe(true);
    expect(plan.commands.some((c) => !c.args.includes("--prod"))).toBe(true);
    expect(plan.secrets.map((s) => s.name)).toContain("VERCEL_TOKEN");
    expect(plan.gitIntegration).toBe(false);
    expect(plan.warnings).toEqual([]);
  });

  it("netlify: writes netlify.toml, needs NETLIFY_AUTH_TOKEN + NETLIFY_SITE_ID", async () => {
    const helpRoot = makeHelpRoot();
    const plan = await createNetlifyAdapter().plan(helpRoot, makeResolvedConfig());
    expect(plan.files.map((f) => f.path)).toEqual(["netlify.toml"]);
    expect(plan.files[0].contents).toContain("publish = \".next\"");
    expect(plan.secrets.map((s) => s.name).sort()).toEqual(["NETLIFY_AUTH_TOKEN", "NETLIFY_SITE_ID"]);
  });

  it("amplify: writes amplify.yml, routes through Git integration, no deploy command", async () => {
    const helpRoot = makeHelpRoot();
    const plan = await createAmplifyAdapter().plan(helpRoot, makeResolvedConfig());
    expect(plan.files.map((f) => f.path)).toEqual(["amplify.yml"]);
    expect(plan.files[0].contents).toContain("baseDirectory: .next");
    expect(plan.commands).toEqual([]);
    expect(plan.gitIntegration).toBe(true);
  });

  it("cloudflare: writes open-next.config.ts + wrangler.jsonc, sets a 25 MiB static-asset limit", async () => {
    const helpRoot = makeHelpRoot();
    const adapter = createCloudflareAdapter();
    const plan = await adapter.plan(helpRoot, makeResolvedConfig());
    expect(plan.files.map((f) => f.path).sort()).toEqual(["open-next.config.ts", "wrangler.jsonc"]);
    expect(adapter.staticAssetLimitBytes).toBe(25 * 1024 * 1024);
    expect(plan.secrets.map((s) => s.name)).toContain("CLOUDFLARE_API_TOKEN");
  });

  it("node: writes NODE_DEPLOY.md, plans `npm run build`, no secrets", async () => {
    const helpRoot = makeHelpRoot();
    const plan = await createNodeAdapter().plan(helpRoot, makeResolvedConfig());
    expect(plan.files.map((f) => f.path)).toEqual(["NODE_DEPLOY.md"]);
    expect(plan.commands).toEqual([{ cmd: "npm", args: ["run", "build"], description: "next build" }]);
    expect(plan.secrets).toEqual([]);
  });

  it("static: disables chat/mcp with a clear warning, merges output: \"export\" and images.unoptimized into next.config.mjs", async () => {
    const helpRoot = makeHelpRoot();
    const plan = await createStaticAdapter().plan(helpRoot, makeResolvedConfig());
    expect(plan.warnings.join(" ")).toMatch(/disables chat and the MCP server/);
    expect(plan.files.map((f) => f.path)).toEqual(["next.config.mjs"]);
    expect(plan.files[0].contents).toContain('output: "export"');
    // Without this, next/image's default loader 404s every screenshot in the export — there's
    // no server to run /_next/image on (caught by actually loading an exported page).
    expect(plan.files[0].contents).toMatch(/images:\s*\{\s*unoptimized:\s*true\s*\}/);
  });

  it("static: plans the build command with AIDA_STATIC_EXPORT=1 so chat/mcp routes compile out (Opus review finding)", async () => {
    const helpRoot = makeHelpRoot();
    const plan = await createStaticAdapter().plan(helpRoot, makeResolvedConfig());
    expect(plan.commands).toEqual([
      {
        cmd: "npm",
        args: ["run", "build"],
        description: "next build, writing the static site to out/",
        env: { AIDA_STATIC_EXPORT: "1", NEXT_PUBLIC_AIDA_STATIC_EXPORT: "1" },
      },
    ]);
  });

  it("static: leaves an existing output: \"export\" alone, but still adds the images.unoptimized fix if it's missing", async () => {
    const helpRoot = makeHelpRoot({
      nextConfig: `const config = { output: "export" };\nexport default config;\n`,
    });
    const plan = await createStaticAdapter().plan(helpRoot, makeResolvedConfig());
    expect(plan.files.map((f) => f.path)).toEqual(["next.config.mjs"]);
    expect(plan.files[0].contents).toContain('output: "export"');
    expect(plan.files[0].contents).toMatch(/images:\s*\{\s*unoptimized:\s*true\s*\}/);
  });

  it("static: writes nothing when output: \"export\" and images.unoptimized are both already set", async () => {
    const helpRoot = makeHelpRoot({
      nextConfig: `const config = { output: "export", images: { unoptimized: true } };\nexport default config;\n`,
    });
    const plan = await createStaticAdapter().plan(helpRoot, makeResolvedConfig());
    expect(plan.files).toEqual([]);
  });

  it("static: warns instead of overwriting a next.config.mjs with its own different images config", async () => {
    const helpRoot = makeHelpRoot({
      nextConfig: `const config = { output: "export", images: { domains: ["example.com"] } };\nexport default config;\n`,
    });
    const plan = await createStaticAdapter().plan(helpRoot, makeResolvedConfig());
    expect(plan.files).toEqual([]);
    expect(plan.warnings.some((w) => w.includes("unoptimized: true"))).toBe(true);
  });

  it("static: warns instead of overwriting a next.config.mjs with a different output already set", async () => {
    const helpRoot = makeHelpRoot({
      nextConfig: `const config = { output: "standalone" };\nexport default config;\n`,
    });
    const plan = await createStaticAdapter().plan(helpRoot, makeResolvedConfig());
    expect(plan.files).toEqual([]);
    expect(plan.warnings.some((w) => w.includes("different `output`"))).toBe(true);
  });

  it("getHostAdapter throws on an unknown host", () => {
    expect(() => getHostAdapter("heroku")).toThrow(/Unknown publish host/);
  });
});
