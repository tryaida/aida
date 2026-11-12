// `aida export playwright`: every action kind as Playwright code, `{{data}}` resolved, TODOs for
// what a spec can't carry, deterministic bytes, the overwrite guard, specs that parse, and a
// round trip through `aida import playwright`.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import * as YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportPlaywright, GENERATED_HEADER } from "../../src/export/index.js";
import { runExportPlaywright } from "../../src/commands/export-playwright.js";
import { runImportPlaywright } from "../../src/commands/import-playwright.js";
import { ActionSchema, docToWalkthrough, WalkthroughDocSchema, type Action } from "../../src/walkthrough/index.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-export-test-"));
  dirs.push(dir);
  return dir;
}

const EVERY_ACTION = `
walkthrough: every-action
title: "Book a {{session.name}}"
start:
  page: /sessions
  persona:
    role: office-staff
    email: pat@example.com
data:
  person:
    first: Jordan
  session:
    name: "Morning {{run.id}}"
needs: [session-exists, coach-free]
leaves: [booking-made]
clears: [coach-free]
setup:
  as: admin
  steps:
    - title: Add a coach
      do: go to /coaches/new
validate:
  database:
    - name: booking saved
      sql: select count(*) as n from bookings
      expect: { n: 1 }
steps:
  - id: open
    title: Open the form
    actions:
      - do: goto
        path: /sessions/new
      - do: click
        target: { role: button, name: "Add {{person.first}}" }
      - do: point
        target: { css: "[data-testid=total]" }
      - do: scrollTo
        target: { text: Summary }
  - id: fill
    title: Fill it in
    actions:
      - do: type
        target: { label: First name }
        text: "{{person.first}}"
      - do: type
        target: { placeholder: Session }
        text: "{{session.name}}"
      - do: select
        target: { label: Class, exact: true }
        option: Open
      - do: press
        key: Enter
        target: { label: Search }
      - do: press
        key: Escape
      - do: hover
        target: { role: link, name: Settings }
      - do: focus
        target: { label: Email }
  - id: check
    title: Check it saved
    actions:
      - do: waitForUrl
        pattern: "/sessions/\\\\d+$"
      - do: waitFor
        target: { text: "/Saved/" }
      - do: expect
        target: { role: status }
        text: Saved
      - do: expect
        target: { role: status }
        text: "Saved {{session.name}}"
        exact: true
      - do: expect
        target: { role: heading }
        text: "/booking \\\\d+/i"
        exact: true
      - do: expect
        target: { text: Done }
  - id: mail
    title: Read the email
    actions:
      - do: showEmail
        to: pat@example.com
        subject: Your code
        remember: { code: "/(\\\\d{6})/" }
      - do: type
        target: { label: Code }
        text: "{{inbox.code}}"
      - do: showEmail
        mock: { from: a@example.com, to: b@example.com, subject: Welcome, text: Hi }
  - id: phone-menu
    title: Open the menu
    devices: [phone]
    actions:
      - do: click
        target: { role: button, name: Menu }
devices: [desktop, phone]
paths:
  - id: from-coach
    title: From the coach's page
    when: You start from the coach.
    start: { page: /coaches/1 }
    steps:
      - title: Book
        check: expect text "Booked"
`;

const SIMPLE = `
walkthrough: add-thing
title: Add a thing
start:
  page: /things
data:
  thing: { name: Widget }
steps:
  - id: open
    title: Open the form
    do: click "Add thing" button
  - id: name
    title: Name it
    do:
      - fill "Name" with "{{thing.name}}"
      - press "Enter" in "Name"
  - id: check
    title: See it
    actions:
      - do: hover
        target: { role: link, name: Widget }
      - do: focus
        target: { role: link, name: Widget }
      - do: waitForUrl
        pattern: "^[^?#]*://[^/]+/things/1(?:[?#].*)?$"
      - do: expect
        target: { role: status, name: Saved }
        text: Widget saved
`;

function project(walkthroughs: Record<string, string>, configExtra = ""): { dir: string; config: string } {
  const dir = tmp();
  mkdirSync(join(dir, "walkthroughs"));
  for (const [name, text] of Object.entries(walkthroughs)) writeFileSync(join(dir, "walkthroughs", `${name}.yaml`), text);
  writeFileSync(join(dir, "sign-in.mjs"), "export default async function signIn() {}\n");
  writeFileSync(
    join(dir, "aida.config.mjs"),
    `export default {
      app: { baseUrl: "http://127.0.0.1:9" },
      walkthroughsDir: "./walkthroughs",
      buildDir: "./.build",
      ${configExtra}
    };\n`,
  );
  return { dir, config: join(dir, "aida.config.mjs") };
}

/** Syntax errors in a generated spec, from the TypeScript compiler. */
function syntaxErrors(text: string): string[] {
  const out = ts.transpileModule(text, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  return (out.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    return await fn();
  } finally {
    vi.restoreAllMocks();
  }
}

describe("aida export playwright: the spec", () => {
  it("covers every action kind the schema has", () => {
    // zod 4: the union's options, each an object schema whose `do` is a literal.
    const kinds = (ActionSchema as unknown as { options: { shape: { do: { value: string } } }[] }).options.map((o) => o.shape.do.value);
    const used = new Set(docToWalkthrough(WalkthroughDocSchema.parse(YAML.parse(EVERY_ACTION))).steps.flatMap((s) => s.actions.map((a: Action) => a.do)));
    expect([...kinds].sort()).toEqual([...used].sort());
  });

  it("writes each action as the Playwright call capture makes, with {{data}} resolved", async () => {
    const { dir, config } = project(
      { "every-action": EVERY_ACTION },
      `signIn: "./sign-in.mjs", states: { "session-exists": { setup: async () => {} } }, database: { url: () => "postgres://127.0.0.1/demo", reset: async () => {} },`,
    );
    const out = join(dir, "specs");
    const result = await exportPlaywright({ configPath: config, walkthroughs: [], outDir: out });
    expect(result).toMatchObject({ ok: true, specs: [{ walkthrough: "every-action", status: "written" }] });
    const spec = readFileSync(join(out, "every-action.spec.ts"), "utf8");

    expect(spec.startsWith(`${GENERATED_HEADER} from walkthroughs/every-action.yaml (walkthrough "every-action").`)).toBe(true);
    expect(spec).toContain("change it and run `aida export playwright` again. Don't edit this file.");
    expect(spec).toContain('import { expect, test, type Locator, type Page } from "@playwright/test";');
    // The helpers its code calls, once each, before the test.
    for (const helper of ["aidaLabel", "aidaSelect", "aidaText"]) expect(spec.split(`async function ${helper}(`)).toHaveLength(2);
    expect(spec.indexOf("async function aidaLabel(")).toBeLessThan(spec.indexOf("test("));
    expect(spec).toContain('test("Book a Morning {{run.id}}", async ({ page }) => {');
    expect(spec).toContain('await page.goto("/sessions");');
    expect(spec).toContain('await test.step("Open the form", async () => {');
    // goto, click (data resolved), point, scrollTo
    expect(spec).toContain('    await page.goto("/sessions/new");');
    expect(spec).toContain('await page.getByRole("button", { name: "Add Jordan" }).filter({ visible: true }).first().click();');
    expect(spec).toContain('await expect(page.locator("[data-testid=total]").filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });');
    expect(spec).toContain('await page.getByText("Summary").filter({ visible: true }).first().scrollIntoViewIfNeeded();');
    // type, with the run id filled in at run time
    expect(spec).toContain('await (await aidaLabel(page, "First name")).filter({ visible: true }).first().fill("Jordan");');
    expect(spec).toContain('await page.getByPlaceholder("Session", { exact: true }).filter({ visible: true }).first().fill(`Morning ${runId}`);');
    // select: a native <select> or a custom dropdown, through the helper
    expect(spec).toContain('await aidaSelect(page, page.getByLabel("Class", { exact: true }).filter({ visible: true }).first(), "Open");');
    // press (in a field and to the page), hover, focus
    expect(spec).toContain('await (await aidaLabel(page, "Search")).filter({ visible: true }).first().press("Enter");');
    expect(spec).toContain('await page.keyboard.press("Escape");');
    expect(spec).toContain('await page.getByRole("link", { name: "Settings" }).filter({ visible: true }).first().hover();');
    expect(spec).toContain('await (await aidaLabel(page, "Email")).filter({ visible: true }).first().focus();');
    // waits and expects
    expect(spec).toContain("await expect(page).toHaveURL(/\\/sessions\\/\\d+$/, { timeout: 60_000 });");
    expect(spec).toContain("await expect(page.getByText(/Saved/).filter({ visible: true }).first()).toBeVisible({ timeout: 60_000 });");
    expect(spec).toContain('await expect(page.getByRole("status").filter({ visible: true }).first()).toContainText("Saved", { timeout: 20_000 });');
    expect(spec).toContain('await expect(page.getByRole("status").filter({ visible: true }).first()).toHaveText(`Saved Morning ${runId}`, { timeout: 20_000 });');
    expect(spec).toContain('await expect.poll(() => aidaText(page.getByRole("heading").filter({ visible: true }).first()), { timeout: 20_000 }).toMatch(/^(?:booking \\d+)$/i);');
    expect(spec).toContain('await expect(page.getByText("Done").filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });');
    // emails and {{inbox.*}}
    expect(spec).toContain('fill(`${inbox["code"]}`);');
    expect(spec).toContain("const inbox: Record<string, string> = {};");
    expect(spec).toContain("// TODO from walkthrough: aida shows the email the app sent to pat@example.com with subject Your code");
    expect(spec).toContain('// TODO from walkthrough: aida reads {{inbox.code}} from that email; set inbox["code"] from it here.');
    expect(spec).toContain('// TODO from walkthrough: aida shows an example email here ("Welcome")');
    // a step for another device is left out, and said so
    expect(spec).toContain('// Step "Open the menu" only runs on phone: not in this desktop spec.');
    expect(spec).not.toContain('name: "Menu"');
  });

  it("writes what a spec can't carry as TODO comments, and never a secret or a persona's details", async () => {
    process.env.ACME_TEST_SECRET = "s3cret-value-123";
    try {
      const { dir, config } = project(
        { "every-action": EVERY_ACTION, "add-session": "walkthrough: add-session\ntitle: Add\nleaves: [session-exists]\nsteps:\n  - title: x\n    do: go to /x\n" },
        `signIn: "./sign-in.mjs", states: { "session-exists": { setup: async () => {} } }, database: { url: () => "postgres://u:pw@127.0.0.1/demo", reset: async () => {} },`,
      );
      await exportPlaywright({ configPath: config, walkthroughs: ["every-action"], outDir: join(dir, "specs") });
      const spec = readFileSync(join(dir, "specs", "every-action.spec.ts"), "utf8");
      const todos = spec.split("\n").filter((l) => l.includes("// TODO from walkthrough:")).map((l) => l.trim().replace("// TODO from walkthrough: ", ""));
      expect(todos).toEqual([
        "aida signs in as \"office-staff\" with the config's sign-in adapter. Save a signed-in session for that role (https://playwright.dev/docs/auth) at this path.",
        "aida resets the demo data (the config's database adapter) before a run that starts with this walkthrough. Start this test from the same data.",
        'needs data state "session-exists" before step 1: left by "add-session", which aida runs first; or made by the config\'s setup hook for "session-exists". Make sure this test starts with that data.',
        'needs data state "coach-free" before step 1: nothing in this project leaves it. Make sure this test starts with that data.',
        'before step 1 aida runs 1 unrecorded setup step(s) signed in as "admin": "Add a coach". Do the same in a beforeEach or a fixture.',
        "{{run.id}} is a short id aida makes once per run, shared by every walkthrough in it so one can find what another made. Use the id your test data was made with.",
        "values aida reads from emails during the run ({{inbox.code}}): fill them in where the email is shown.",
        "aida shows the email the app sent to pat@example.com with subject Your code, caught by its local mail catcher. Check it with your own mail catcher.",
        'aida reads {{inbox.code}} from that email; set inbox["code"] from it here.',
        'aida shows an example email here ("Welcome"), drawn over the app for the guide; there is nothing to check.',
        'after the last step aida checks the database (validate.database): "booking saved".',
        'leaves data state(s) "booking-made" for the walkthroughs that need them.',
        'clears data state(s) "coach-free".',
        'other ways in, captured by aida but not exported: "from-coach" (From the coach\'s page).',
      ]);
      expect(spec).toContain('test.use({ storageState: "playwright/.auth/office-staff.json" });');
      expect(spec).toContain('const runId = process.env.AIDA_RUN_ID ?? "local";');
      // Nothing from the config, the environment or the persona beyond its role.
      for (const leaked of ["s3cret-value-123", "pw@", "postgres://", "sign-in.mjs", "pat@example.com\n", "email: "]) expect(spec).not.toContain(leaked);
      expect(spec).not.toMatch(/persona|cognito/i);
      expect(spec).not.toContain("select count(*)");
    } finally {
      delete process.env.ACME_TEST_SECRET;
    }
  });

  it("is the same bytes every time, and says nothing changed on a second run", async () => {
    const { dir, config } = project({ "every-action": EVERY_ACTION, "add-thing": SIMPLE }, `signIn: "./sign-in.mjs",`);
    const a = join(dir, "a");
    const b = join(dir, "b");
    await exportPlaywright({ configPath: config, walkthroughs: [], outDir: a });
    await exportPlaywright({ configPath: config, walkthroughs: [], outDir: b });
    for (const f of readdirSync(a)) expect(readFileSync(join(a, f))).toEqual(readFileSync(join(b, f)));
    const again = await exportPlaywright({ configPath: config, walkthroughs: [], outDir: a });
    expect(again.specs.map((s) => s.status)).toEqual(["unchanged", "unchanged"]);
  });

  it("parses cleanly with the TypeScript compiler, whatever the walkthrough's text holds", async () => {
    const hostile = `
walkthrough: hostile
title: "Quotes \\" back\` ticks \${x} */ and a \\\\ slash"
start: { page: "/a b" }
steps:
  - title: "Line\\nbreak \\u2028 and \`tick\`"
    actions:
      - do: click
        target: { role: button, name: "Say \\"hi\\" \${y} \`z\`" }
      - do: expect
        target: { text: "/a\\\\/b[/]c/" }
      - do: expect
        target: { text: "//" }
      - do: expect
        target: { css: "a[href='/x']", hasText: "*/ end" }
        text: "/x\\\\/y/i"
      - do: waitForUrl
        pattern: "a/b\\\\/c"
      - do: type
        target: { label: "Name (Required)", within: { role: dialog, name: "New" }, nth: 1 }
        text: "back\\\\slash \`tick\` \${z}"
      - do: click
        target: { css: ".row", innermost: true, text: Remove }
`;
    const { dir, config } = project({ hostile: hostile, "every-action": EVERY_ACTION, "add-thing": SIMPLE }, `signIn: "./sign-in.mjs",`);
    const out = join(dir, "specs");
    const result = await exportPlaywright({ configPath: config, walkthroughs: [], outDir: out });
    expect(result.errors).toEqual([]);
    for (const f of readdirSync(out)) {
      const text = readFileSync(join(out, f), "utf8");
      expect({ file: f, errors: syntaxErrors(text) }).toEqual({ file: f, errors: [] });
    }
    const spec = readFileSync(join(out, "hostile.spec.ts"), "utf8");
    expect(spec).toContain("getByText(/a\\/b[/]c/)");
    expect(spec).toContain('getByText(new RegExp(""))');
    expect(spec).toContain('(await aidaLabel(page.getByRole("dialog", { name: "New" }).filter({ visible: true }).first(), "Name (Required)"))');
    expect(spec).toContain(".filter({ visible: true }).nth(1).fill(");
    // `text` wins over `css`, as in locate.ts.
    expect(spec).toContain('page.getByText("Remove").filter({ visible: true }).last().click();');
    expect(spec).toContain('await test.step("Line\\nbreak \\u2028 and `tick`", async () => {');
  });

  it("fails on a {{placeholder}} the walkthrough's data doesn't have, and writes nothing", async () => {
    const { dir, config } = project({ broken: "walkthrough: broken\ntitle: B\nsteps:\n  - title: x\n    do: fill \"Name\" with \"{{nobody.name}}\"\n", "add-thing": SIMPLE });
    const out = join(dir, "specs");
    const result = await exportPlaywright({ configPath: config, walkthroughs: [], outDir: out });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatchObject({ walkthrough: "broken" });
    expect(result.errors[0].error).toContain("nobody.name");
    expect(existsSync(out)).toBe(false);
  });
});

describe("aida export playwright: the overwrite guard", () => {
  it("refuses to overwrite a file it didn't generate (and writes nothing), unless --force", async () => {
    const { dir, config } = project({ "every-action": EVERY_ACTION, "add-thing": SIMPLE });
    const out = join(dir, "specs");
    mkdirSync(out);
    writeFileSync(join(out, "add-thing.spec.ts"), "// my own test\n");

    const refused = await quiet(() => runExportPlaywright({ configPath: config, walkthroughIds: [], outDir: out }));
    expect(refused).toBe(1);
    expect(readFileSync(join(out, "add-thing.spec.ts"), "utf8")).toBe("// my own test\n");
    expect(existsSync(join(out, "every-action.spec.ts"))).toBe(false);

    const forced = await quiet(() => runExportPlaywright({ configPath: config, walkthroughIds: [], outDir: out, force: true }));
    expect(forced).toBe(0);
    expect(readFileSync(join(out, "add-thing.spec.ts"), "utf8").startsWith(GENERATED_HEADER)).toBe(true);
  });

  it("overwrites its own earlier spec without --force", async () => {
    const { dir, config } = project({ "add-thing": SIMPLE });
    const out = join(dir, "specs");
    mkdirSync(out);
    writeFileSync(join(out, "add-thing.spec.ts"), `${GENERATED_HEADER} from an older walkthrough.\n`);
    const result = await exportPlaywright({ configPath: config, walkthroughs: ["add-thing"], outDir: out });
    expect(result).toMatchObject({ ok: true, specs: [{ status: "written" }] });
  });

  it("names an unknown walkthrough and exits non-zero, in --json too", async () => {
    const { dir, config } = project({ "add-thing": SIMPLE });
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: string) => void logs.push(m));
    const code = await runExportPlaywright({ configPath: config, walkthroughIds: ["nope"], outDir: join(dir, "specs"), json: true });
    vi.restoreAllMocks();
    expect(code).toBe(1);
    expect(JSON.parse(logs[0])).toMatchObject({ ok: false, errors: [{ walkthrough: "nope" }] });
  });
});

describe("aida export playwright: what it refuses", () => {
  it("refuses a walkthrough whose file name holds a line break, so the name can't become code", async () => {
    const { dir, config } = project({ "x\nprocess.exit(7);": SIMPLE.replace("add-thing", "sneaky"), "add-thing": SIMPLE });
    const out = join(dir, "specs");
    const result = await exportPlaywright({ configPath: config, walkthroughs: [], outDir: out });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([{ walkthrough: "sneaky", error: expect.stringContaining("has a control character") }]);
    expect(existsSync(out)).toBe(false);
    // Named by its file, the same.
    const named = await exportPlaywright({ configPath: config, walkthroughs: [join(dir, "walkthroughs", "x\nprocess.exit(7);.yaml")], outDir: out });
    expect(named.errors[0].error).toContain("has a control character");
  });

  it("refuses two walkthrough files with the same id, naming both", async () => {
    const { dir, config } = project({ "add-thing": SIMPLE, "add-thing-copy": SIMPLE });
    const out = join(dir, "specs");
    const result = await exportPlaywright({ configPath: config, walkthroughs: [], outDir: out });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      { walkthrough: "add-thing", error: expect.stringContaining("walkthroughs/add-thing-copy.yaml and walkthroughs/add-thing.yaml") },
    ]);
    expect(existsSync(out)).toBe(false);
    const byId = await exportPlaywright({ configPath: config, walkthroughs: ["add-thing"], outDir: out });
    expect(byId.errors[0].error).toContain("is in more than one file");
  });

  it("never writes through a symlink, even with --force", async () => {
    const { dir, config } = project({ "add-thing": SIMPLE });
    const out = join(dir, "specs");
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(out);
    mkdirSync(elsewhere);
    // A dangling symlink: the file it points at doesn't exist yet.
    symlinkSync(join(elsewhere, "made.ts"), join(out, "add-thing.spec.ts"));
    for (const force of [false, true]) {
      const result = await exportPlaywright({ configPath: config, walkthroughs: [], outDir: out, force });
      expect(result.ok).toBe(false);
      expect(result.errors[0].error).toContain("is a symlink");
    }
    expect(existsSync(join(elsewhere, "made.ts"))).toBe(false);

    // A symlink to a file that looks like one of ours.
    rmSync(join(out, "add-thing.spec.ts"));
    writeFileSync(join(elsewhere, "ours.ts"), `${GENERATED_HEADER} from an older walkthrough.\n`);
    symlinkSync(join(elsewhere, "ours.ts"), join(out, "add-thing.spec.ts"));
    const result = await exportPlaywright({ configPath: config, walkthroughs: [], outDir: out, force: true });
    expect(result.errors[0].error).toContain("is a symlink");
    expect(readFileSync(join(elsewhere, "ours.ts"), "utf8")).toBe(`${GENERATED_HEADER} from an older walkthrough.\n`);

    // Something that isn't a file at all.
    rmSync(join(out, "add-thing.spec.ts"));
    mkdirSync(join(out, "add-thing.spec.ts"));
    const dirResult = await exportPlaywright({ configPath: config, walkthroughs: [], outDir: out, force: true });
    expect(dirResult.errors[0].error).toContain("is not a regular file");
  });

  it("writes into the folder --out resolves to when --out is itself a symlink", async () => {
    const { dir, config } = project({ "add-thing": SIMPLE });
    const real = join(dir, "real-specs");
    mkdirSync(real);
    symlinkSync(real, join(dir, "specs"));
    const result = await exportPlaywright({ configPath: config, walkthroughs: [], outDir: join(dir, "specs") });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(real, "add-thing.spec.ts"), "utf8").startsWith(GENERATED_HEADER)).toBe(true);
  });
});

describe("aida export playwright: round trip through aida import playwright", () => {
  it("recovers the core actions, one step per test.step with its title", async () => {
    const { dir, config } = project({ "add-thing": SIMPLE });
    const out = join(dir, "specs");
    await exportPlaywright({ configPath: config, walkthroughs: [], outDir: out });
    const drafts = join(dir, "drafts");
    const code = await quiet(() => runImportPlaywright(join(out, "add-thing.spec.ts"), drafts, false));
    expect(code).toBe(0);
    const [file] = readdirSync(drafts);
    const raw = YAML.parse(readFileSync(join(drafts, file), "utf8"));
    const back = docToWalkthrough(WalkthroughDocSchema.parse(raw));

    // The draft's data holds the typed values: resolve them to compare like for like.
    const resolve = (a: Action): Action => (a.do === "type" ? { ...a, text: a.text.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => String(raw.data[k])) } : a);
    // `.first()` comes back as `nth: 0`, which is what no `nth` means.
    const plain = (a: Action): Action => JSON.parse(JSON.stringify(a, (k, v) => (k === "nth" && v === 0 ? undefined : v)));
    const steps = back.steps.map((s) => ({ title: s.title, actions: s.actions.map((a) => plain(resolve(a))) }));
    expect(steps).toEqual([
      { title: undefined, actions: [{ do: "goto", path: "/things" }] },
      { title: "Open the form", actions: [{ do: "click", target: { role: "button", name: "Add thing" } }] },
      {
        title: "Name it",
        actions: [
          { do: "type", target: { label: "Name" }, text: "Widget" },
          { do: "press", key: "Enter", target: { label: "Name" } },
        ],
      },
      {
        title: "See it",
        actions: [
          { do: "hover", target: { role: "link", name: "Widget" } },
          { do: "focus", target: { role: "link", name: "Widget" } },
          { do: "waitForUrl", pattern: "^[^?#]*:\\/\\/[^/]+\\/things\\/1(?:[?#].*)?$" },
          { do: "expect", target: { role: "status", name: "Saved" }, text: "Widget saved" },
        ],
      },
    ]);
    // The URL pattern is the same expression, with its slashes escaped for a literal.
    const url = steps[3].actions[2] as Extract<Action, { do: "waitForUrl" }>;
    expect(new RegExp(url.pattern).source).toBe(new RegExp("^[^?#]*://[^/]+/things/1(?:[?#].*)?$").source);
  });

  it("reads back a label, a select, a /pattern/ check and a relative goto through the spec's helpers", async () => {
    const wt = `
walkthrough: helpers
title: Helpers
start: { page: /orders }
steps:
  - title: Fill
    actions:
      - do: goto
        path: "new?draft=1"
      - do: type
        target: { label: Customer, within: { role: dialog, name: New } }
        text: Acme
      - do: select
        target: { label: Status }
        option: Open
      - do: expect
        target: { role: status }
        text: "/Saved|Queued/i"
`;
    const { dir, config } = project({ helpers: wt });
    const out = join(dir, "specs");
    await exportPlaywright({ configPath: config, walkthroughs: [], outDir: out });
    const drafts = join(dir, "drafts");
    expect(await quiet(() => runImportPlaywright(join(out, "helpers.spec.ts"), drafts, false))).toBe(0);
    const yaml = readFileSync(join(drafts, readdirSync(drafts)[0]), "utf8");
    expect(yaml).not.toContain("TODO from test");
    const back = docToWalkthrough(WalkthroughDocSchema.parse(YAML.parse(yaml)));
    expect(back.steps[1].actions).toEqual([
      { do: "goto", path: "new?draft=1" },
      { do: "type", target: { label: "Customer", within: { role: "dialog", name: "New", nth: 0 }, nth: 0 }, text: "{{customer}}" },
      { do: "select", target: { label: "Status", nth: 0 }, option: "Open" },
      { do: "expect", target: { role: "status", nth: 0 }, text: "/Saved|Queued/i" },
    ]);
  });

  it("leaves a hand-written label .or() and anything only like a helper call as TODOs", async () => {
    const dir = tmp();
    const spec = join(dir, "other.spec.ts");
    writeFileSync(
      spec,
      [
        'import { expect, test } from "@playwright/test";',
        'test("other", async ({ page }) => {',
        '  await page.getByRole("button", { name: "Save" }).or(page.getByText("Save")).click();',
        '  await page.getByLabel("Name", { exact: true }).or(page.getByLabel(/^Name/i)).filter({ visible: true }).first().fill("Acme");',
        '  await (await aidaLabel(page, "Name", { exact: false })).fill("Acme");',
        '  await (await aidaLabel(page, someLabel)).fill("Acme");',
        '  await aidaSelect(page, page.getByLabel("Status"), "Open", { force: true });',
        '  await expect.poll(() => page.getByRole("status").textContent()).toMatch(/Saved/);',
        '  await page.getByRole("button", { name: "Done" }).click();',
        "});",
      ].join("\n"),
    );
    expect(await quiet(() => runImportPlaywright(spec, join(dir, "drafts"), false))).toBe(0);
    const yaml = readFileSync(join(dir, "drafts", readdirSync(join(dir, "drafts"))[0]), "utf8");
    for (const line of [3, 4, 5, 6, 7, 8]) expect(yaml).toContain(`TODO from test: line ${line}:`);
    const back = docToWalkthrough(WalkthroughDocSchema.parse(YAML.parse(yaml)));
    expect(back.steps.flatMap((s) => s.actions)).toEqual([{ do: "click", target: { role: "button", name: "Done" } }]);
  });
});
