import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/index.js";
import { runOrder } from "../../src/commands/order.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function project(states: string, walkthroughs: Record<string, string>, extraConfig = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-order-"));
  dirs.push(dir);
  mkdirSync(join(dir, "walkthroughs"));
  writeFileSync(
    join(dir, "hooks.mjs"),
    `export async function setup() {}\nexport async function check() { return true; }\nexport default async function () {}\n`,
  );
  writeFileSync(
    join(dir, "aida.config.mjs"),
    `export default { app: { baseUrl: "http://127.0.0.1:1" }, walkthroughsDir: "./walkthroughs", states: ${states}, ${extraConfig} };\n`,
  );
  for (const [name, extra] of Object.entries(walkthroughs)) {
    writeFileSync(join(dir, "walkthroughs", `${name}.yaml`), `walkthrough: ${name}\ntitle: ${name}\nsteps:\n  - do: go to /x\n${extra}`);
  }
  return dir;
}

async function orderJson(dir: string, ids: string[], opts: { withDeps?: boolean; ci?: boolean } = {}) {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  try {
    const code = await runOrder({ configPath: join(dir, "aida.config.mjs"), walkthroughIds: ids, ...opts }, true);
    return { code, out: JSON.parse(logs[0]) };
  } finally {
    spy.mockRestore();
  }
}

describe("config states", () => {
  it("loads hooks from a module path: the named setup/check export, else the default", async () => {
    const dir = project(`{ "session-full": { description: "a full session", setup: "./hooks.mjs", check: "./hooks.mjs" }, other: { setup: { modulePath: "./hooks.mjs", export: "default" } } }`, {});
    const config = await loadConfig(join(dir, "aida.config.mjs"));
    expect(config.states?.["session-full"].description).toBe("a full session");
    expect(typeof config.states?.["session-full"].setup).toBe("function");
    expect(await config.states?.["session-full"].check?.({} as never)).toBe(true);
    expect(typeof config.states?.other.setup).toBe("function");
  });

  it("rejects a state name that isn't kebab-case, and a module with no usable hook", async () => {
    await expect(loadConfig(join(project(`{ Session_Full: {} }`, {}), "aida.config.mjs"))).rejects.toThrow("isn't kebab-case");
    // The module is imported at the hook's first run, not at load: the bad export shows up then.
    const config = await loadConfig(join(project(`{ x: { check: { modulePath: "./hooks.mjs", export: "nope" } } }`, {}), "aida.config.mjs"));
    await expect(Promise.resolve(config.states!.x.check!({} as never))).rejects.toThrow('no usable hook (expected an export named "nope"');
    // A missing module path is still caught at load, without importing anything.
    await expect(loadConfig(join(project(`{ x: { setup: "./missing.mjs" } }`, {}), "aida.config.mjs"))).rejects.toThrow("config states.x.setup: no module at");
  });
});

describe("aida order", () => {
  it("prints the order, why each walkthrough is there and how each need is met", async () => {
    const dir = project(`{ "admin-exists": { setup: "./hooks.mjs" } }`, {
      "add-session": "leaves: [session-exists]\n",
      overbook: "needs: [session-exists, admin-exists]\n",
    });
    const { code, out } = await orderJson(dir, ["overbook"], { withDeps: true });
    expect(code).toBe(0);
    expect(out.walkthroughs).toEqual([
      expect.objectContaining({ walkthrough: "add-session", reason: "dependency", pulledInFor: [{ walkthrough: "overbook", state: "session-exists" }] }),
      expect.objectContaining({
        walkthrough: "overbook",
        reason: "selected",
        needs: [
          { state: "session-exists", metBy: "walkthrough", providers: ["add-session"] },
          { state: "admin-exists", metBy: "hook", providers: [] },
        ],
      }),
    ]);
  });

  it("exits 1 with the problem when a need has no provider in the run", async () => {
    const dir = project(`{}`, { "add-session": "leaves: [session-exists]\n", overbook: "needs: [session-exists]\n" });
    const { code, out } = await orderJson(dir, ["overbook"]);
    expect(code).toBe(1);
    expect(out.problems[0].message).toContain("add add-session to the run, or use --with-deps");
  });

  it("--ci plans CI's resets: every walkthrough except inside a chain", async () => {
    const dir = project(
      `{}`,
      { a: "", "add-session": "leaves: [session-exists]\n", overbook: "needs: [session-exists]\n" },
      `database: { url: () => "postgres://127.0.0.1/x", query: async () => [], reset: async () => {} }`,
    );
    const { out } = await orderJson(dir, [], { ci: true });
    expect(out.reset).toBe("every");
    expect(out.walkthroughs.map((w: { walkthrough: string; resetBefore: boolean }) => [w.walkthrough, w.resetBefore])).toEqual([
      ["a", true],
      ["add-session", true],
      ["overbook", false],
    ]);
  });

  it("plans no reset, and says why, when the database adapter can't reset", async () => {
    const dir = project(`{}`, { a: "validate:\n  database:\n    - name: n\n      sql: select 1\n      expect: { x: 1 }\n" }, `database: { url: () => "postgres://127.0.0.1/x", query: async () => [] }`);
    const { out } = await orderJson(dir, [], { ci: true });
    expect(out.reset).toBe("none");
    expect(out.walkthroughs[0].resetBefore).toBe(false);
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    try {
      await runOrder({ configPath: join(dir, "aida.config.mjs"), walkthroughIds: [], ci: true }, false);
    } finally {
      spy.mockRestore();
    }
    expect(logs.join("\n")).toContain("database reset: none (the database adapter in config has no reset)");
    expect(logs.join("\n")).not.toContain("reset before");
  });

  it("never imports a state hook module: its top-level code doesn't run", async () => {
    const dir = project(`{ x: { setup: "./side-effect.mjs" } }`, { a: "needs: [x]\n" });
    const marker = join(dir, "hook-module-ran");
    writeFileSync(join(dir, "side-effect.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\nexport async function setup() {}\n`);
    const { code } = await orderJson(dir, ["a"]);
    expect(code).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });
});
