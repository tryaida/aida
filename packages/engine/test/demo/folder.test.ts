// The demo folder's safety rules: only a new, empty or earlier demo folder; a marker; edited
// files kept; nothing deleted; never through a symbolic link.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { MARKER_FILE, DemoFolderError, checkDemoFolder, claimDemoFolder, sha256, syncDemoFiles, verifyDemoCode, writeMarker } from "../../src/demo/folder.js";
import { DEMO_APP_DIR, demoCodeFiles, demoConfigSource, demoFileEntries } from "../../src/demo/assets.js";
import { aidaInvocation } from "../../src/demo/invocation.js";

const dirs: string[] = [];
function tmp(): string {
  // Not "aida-*": a cleaner on the dev machine deletes /tmp/aida-* folders mid-run.
  const dir = mkdtempSync(join(tmpdir(), "demo-folder-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("checkDemoFolder", () => {
  it("accepts a new folder and an empty one", () => {
    const root = tmp();
    expect(checkDemoFolder(join(root, "aida-demo"))).toEqual({ kind: "new" });
    expect(checkDemoFolder(root)).toEqual({ kind: "empty" });
  });

  it("refuses a folder with other things in it, and writes nothing there", () => {
    const root = tmp();
    writeFileSync(join(root, "notes.txt"), "mine");
    expect(() => checkDemoFolder(root)).toThrow(DemoFolderError);
    expect(() => claimDemoFolder(root)).toThrow(/isn't a demo folder/);
    expect(existsSync(join(root, MARKER_FILE))).toBe(false);
  });

  it("refuses a file, a symbolic link, and a marker that isn't one", () => {
    const root = tmp();
    writeFileSync(join(root, "file"), "x");
    expect(() => checkDemoFolder(join(root, "file"))).toThrow(/isn't a folder/);
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "link"));
    expect(() => checkDemoFolder(join(root, "link"))).toThrow(/symbolic link/);
    const fake = join(root, "fake");
    mkdirSync(fake);
    writeFileSync(join(fake, MARKER_FILE), '{"something":"else"}');
    expect(() => checkDemoFolder(fake)).toThrow(DemoFolderError);
  });

  it("refuses the home folder, and a folder of dotfiles like it", () => {
    const home = tmp();
    writeFileSync(join(home, ".bashrc"), "# mine");
    mkdirSync(join(home, ".ssh"));
    expect(() => checkDemoFolder(home)).toThrow(/isn't a demo folder/);
    expect(readdirSync(home).sort()).toEqual([".bashrc", ".ssh"]);
    if (readdirSync(homedir()).length > 0 && !existsSync(join(homedir(), MARKER_FILE))) {
      expect(() => checkDemoFolder(homedir())).toThrow(DemoFolderError);
    }
  });

  it("names the way to run aida again in its refusals", () => {
    const root = tmp();
    writeFileSync(join(root, "notes.txt"), "mine");
    expect(() => checkDemoFolder(root)).toThrow(`Pick another folder: ${aidaInvocation()} demo <dir>`);
  });

  it("refuses a planted marker that records no sample app, and runs nothing in that folder", () => {
    const dir = tmp();
    writeFileSync(join(dir, MARKER_FILE), '{"aidaDemo":1}');
    writeFileSync(join(dir, "server.mjs"), "console.log('not the demo');\n");
    expect(() => checkDemoFolder(dir)).toThrow(/doesn't record the sample app/);
    expect(() => claimDemoFolder(dir)).toThrow(DemoFolderError);
    expect(readFileSync(join(dir, "server.mjs"), "utf8")).toBe("console.log('not the demo');\n");
    expect(readdirSync(dir).sort()).toEqual([MARKER_FILE, "server.mjs"]);
  });

  it("refuses a marker none of whose sample-app files are there", () => {
    const dir = tmp();
    writeFileSync(join(dir, MARKER_FILE), JSON.stringify({ aidaDemo: 1, files: { "server.mjs": "0".repeat(64), "lib/store.mjs": "1".repeat(64) } }));
    writeFileSync(join(dir, "other.txt"), "x");
    expect(() => checkDemoFolder(dir)).toThrow(/isn't the demo folder aida demo made/);
  });

  it("takes up a first run that stopped before copying anything", () => {
    const dir = join(tmp(), "aida-demo");
    claimDemoFolder(dir);
    expect(readdirSync(dir)).toEqual([MARKER_FILE]);
    expect(checkDemoFolder(dir).kind).toBe("demo");
  });

  it("recognises a folder an earlier demo made", () => {
    const dir = join(tmp(), "aida-demo");
    const marker = claimDemoFolder(dir);
    syncDemoFiles(dir, marker, demoFileEntries(dir));
    writeMarker(dir, marker);
    writeFileSync(join(dir, "extra.txt"), "the person's own file");
    const state = checkDemoFolder(dir);
    expect(state.kind).toBe("demo");
    expect(JSON.parse(readFileSync(join(dir, MARKER_FILE), "utf8")).aidaDemo).toBe(1);
  });
});

describe("syncDemoFiles", () => {
  it("writes new files, refreshes untouched ones, keeps edited ones and deletes nothing", () => {
    const dir = join(tmp(), "aida-demo");
    const marker = claimDemoFolder(dir);
    const first = syncDemoFiles(dir, marker, [
      { rel: "server.mjs", content: "// the app" },
      { rel: "a.txt", content: "one" },
      { rel: "sub/b.txt", content: "two" },
    ]);
    expect(first.written).toEqual(["server.mjs", "a.txt", "sub/b.txt"]);
    writeMarker(dir, marker);
    writeFileSync(join(dir, "sub", "b.txt"), "edited by the person");
    writeFileSync(join(dir, "mine.txt"), "not the demo's");

    const again = claimDemoFolder(dir);
    const second = syncDemoFiles(dir, again, [
      { rel: "a.txt", content: "one, updated" },
      { rel: "sub/b.txt", content: "two, updated" },
      { rel: "mine.txt", content: "the demo's version" },
    ]);
    expect(second.updated).toEqual(["a.txt"]);
    expect(second.kept).toEqual(["sub/b.txt", "mine.txt"]);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("one, updated");
    expect(readFileSync(join(dir, "sub", "b.txt"), "utf8")).toBe("edited by the person");
    expect(readFileSync(join(dir, "mine.txt"), "utf8")).toBe("not the demo's");

    const third = syncDemoFiles(dir, again, [{ rel: "a.txt", content: "one, updated" }]);
    expect(third.unchanged).toEqual(["a.txt"]);
    expect(existsSync(join(dir, "sub", "b.txt"))).toBe(true);
  });

  it("never writes through a symbolic link or outside the folder", () => {
    const root = tmp();
    const dir = join(root, "aida-demo");
    const marker = claimDemoFolder(dir);
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(dir, "linked"));
    const report = syncDemoFiles(dir, marker, [
      { rel: "linked/x.txt", content: "x" },
      { rel: "../escape.txt", content: "x" },
    ]);
    expect(report.kept).toEqual(["linked/x.txt", "../escape.txt"]);
    expect(existsSync(join(outside, "x.txt"))).toBe(false);
    expect(existsSync(join(root, "escape.txt"))).toBe(false);
  });

  it("copies the sample app to the folder's root and the walkthroughs into help/walkthroughs", () => {
    const entries = demoFileEntries("/demo");
    const rels = entries.map((e) => e.rel);
    expect(rels).toContain("server.mjs");
    expect(rels).toContain("src/styles.css");
    expect(rels).toContain("help/walkthroughs/mark-a-repair-ready.yaml");
    expect(rels.every((r) => !r.includes("..") && !r.startsWith("/"))).toBe(true);
  });

  it("writes a config that points at the sample app and carries the brand read from it", () => {
    const dir = join(tmp(), "aida-demo");
    const marker = claimDemoFolder(dir);
    syncDemoFiles(dir, marker, demoFileEntries(dir));
    const config = demoConfigSource(dir);
    expect(config).toContain('process.env.ACME_REPAIRS_URL ?? "http://127.0.0.1:4310"');
    expect(config).toContain('name: "Acme Repairs"');
    expect(config).toContain('primaryColor: "#c2410c"');
    expect(config).toContain('logo: "../public/logo.svg"');
    expect(config).not.toMatch(/database\s*:/);
  });
});

describe("verifyDemoCode", () => {
  /** A demo folder as a run leaves it: the sample app, walkthroughs and config, all recorded. */
  function demoFolder(): { dir: string; marker: ReturnType<typeof claimDemoFolder> } {
    const dir = join(tmp(), "aida-demo");
    const marker = claimDemoFolder(dir);
    syncDemoFiles(dir, marker, demoFileEntries(dir));
    syncDemoFiles(dir, marker, [{ rel: "help/aida.config.ts", content: demoConfigSource(dir) }]);
    writeMarker(dir, marker);
    return { dir, marker };
  }

  it("covers the server, its modules, package.json, the public files and the config", () => {
    const code = demoCodeFiles();
    for (const rel of ["server.mjs", "package.json", "lib/store.mjs", "lib/pages.mjs", "public/app.js", "help/aida.config.ts"]) expect(code).toContain(rel);
    expect(code).not.toContain("help/walkthroughs/mark-a-repair-ready.yaml");
  });

  it("passes the folder a run made, and a re-copy of the app over an unchanged one", () => {
    const { dir, marker } = demoFolder();
    expect(() => verifyDemoCode(dir, marker, demoCodeFiles())).not.toThrow();
    // A newer AIDA with a different server.mjs: the unchanged copy is replaced and recorded.
    const again = claimDemoFolder(dir);
    const report = syncDemoFiles(dir, again, [{ rel: "server.mjs", content: "// a newer sample app\n" }]);
    expect(report.updated).toEqual(["server.mjs"]);
    expect(() => verifyDemoCode(dir, again, ["server.mjs"])).not.toThrow();
  });

  it("refuses to run a sample-app file changed since the demo wrote it, naming it, and keeps it", () => {
    const { dir, marker } = demoFolder();
    writeFileSync(join(dir, "lib", "store.mjs"), "process.exit(9);\n");
    const again = claimDemoFolder(dir);
    const report = syncDemoFiles(dir, again, demoFileEntries(dir));
    expect(report.kept).toEqual(["lib/store.mjs"]);
    expect(readFileSync(join(dir, "lib", "store.mjs"), "utf8")).toBe("process.exit(9);\n");
    expect(() => verifyDemoCode(dir, again, demoCodeFiles())).toThrow(/lib\/store\.mjs .* has changed since aida demo wrote it/);
    expect(marker.files["lib/store.mjs"]).toBe(sha256(readFileSync(join(DEMO_APP_DIR, "lib", "store.mjs"))));
  });

  it("refuses a planted server.mjs under a marker with a made-up hash", () => {
    const dir = tmp();
    writeFileSync(join(dir, MARKER_FILE), JSON.stringify({ aidaDemo: 1, files: { "server.mjs": "0".repeat(64) } }));
    writeFileSync(join(dir, "server.mjs"), "console.log('planted');\n");
    const marker = claimDemoFolder(dir);
    syncDemoFiles(dir, marker, demoFileEntries(dir));
    expect(readFileSync(join(dir, "server.mjs"), "utf8")).toBe("console.log('planted');\n");
    expect(() => verifyDemoCode(dir, marker, demoCodeFiles())).toThrow(/server\.mjs .* has changed since aida demo wrote it/);
  });

  it("refuses a file the demo never wrote, and an edited config", () => {
    const { dir, marker } = demoFolder();
    delete marker.files["public/app.js"];
    expect(() => verifyDemoCode(dir, marker, demoCodeFiles())).toThrow(/public\/app\.js .* wasn't written by aida demo/);
    const { dir: other, marker: m2 } = demoFolder();
    writeFileSync(join(other, "help", "aida.config.ts"), "export default {};\n");
    expect(() => verifyDemoCode(other, m2, demoCodeFiles())).toThrow(/help\/aida\.config\.ts .* has changed/);
  });

  it("still keeps an edited walkthrough, which isn't code", () => {
    const { dir } = demoFolder();
    const file = join(dir, "help", "walkthroughs", "find-a-job.yaml");
    writeFileSync(file, `${readFileSync(file, "utf8")}# my note\n`);
    const again = claimDemoFolder(dir);
    expect(syncDemoFiles(dir, again, demoFileEntries(dir)).kept).toEqual(["help/walkthroughs/find-a-job.yaml"]);
    expect(() => verifyDemoCode(dir, again, demoCodeFiles())).not.toThrow();
  });
});
