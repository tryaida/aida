// `aida init --tunnel-host` merges into help/.env.local and never clobbers other lines.
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureStudioKey, localStudioAccessUrl, normalizeTunnelHost, studioAccessUrl, writeTunnelHosts } from "../../src/init/env-local.js";

const createdDirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-env-local-test-"));
  createdDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (createdDirs.length > 0) rmSync(createdDirs.pop()!, { recursive: true, force: true });
});

describe("normalizeTunnelHost", () => {
  it("takes the hostname from a URL or host:port", () => {
    expect(normalizeTunnelHost("https://Abc-123.trycloudflare.com/studio")).toBe("abc-123.trycloudflare.com");
    expect(normalizeTunnelHost("dev.example.com:8443")).toBe("dev.example.com");
  });
  it("refuses wildcards and non-hostnames", () => {
    expect(() => normalizeTunnelHost("*.ngrok.app")).toThrow(/wildcard/);
    expect(() => normalizeTunnelHost("bad host")).toThrow(/isn't a hostname/);
  });
});

describe("writeTunnelHosts", () => {
  it("creates .env.local with the variable", () => {
    const dir = tmpDir();
    const r = writeTunnelHosts(dir, ["dev.example.com", "dev.example.com"]);
    expect(r).toMatchObject({ hosts: ["dev.example.com"], added: ["dev.example.com"], written: true });
    expect(readFileSync(join(dir, ".env.local"), "utf8")).toMatch(/^# .*\nAIDA_STUDIO_ALLOWED_HOSTS=dev\.example\.com\n$/);
  });

  it("merges into an existing line in place and keeps every other line", () => {
    const dir = tmpDir();
    const before = 'ANTHROPIC_API_KEY=keep-me\n# a comment\nAIDA_STUDIO_ALLOWED_HOSTS="a.example.com, b.example.com"\nOTHER=1\n';
    writeFileSync(join(dir, ".env.local"), before);
    const r = writeTunnelHosts(dir, ["b.example.com", "c.example.com"]);
    expect(r.added).toEqual(["c.example.com"]);
    expect(readFileSync(join(dir, ".env.local"), "utf8")).toBe(
      "ANTHROPIC_API_KEY=keep-me\n# a comment\nAIDA_STUDIO_ALLOWED_HOSTS=a.example.com,b.example.com,c.example.com\nOTHER=1\n",
    );
  });

  it("appends to a file without the variable and leaves it alone when nothing's new", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, ".env.local"), "FOO=bar");
    writeTunnelHosts(dir, ["x.example.com"]);
    const after = readFileSync(join(dir, ".env.local"), "utf8");
    expect(after.startsWith("FOO=bar\n")).toBe(true);
    expect(after.endsWith("AIDA_STUDIO_ALLOWED_HOSTS=x.example.com\n")).toBe(true);
    expect(writeTunnelHosts(dir, ["x.example.com"]).written).toBe(false);
    expect(readFileSync(join(dir, ".env.local"), "utf8")).toBe(after);
  });
});

describe("ensureStudioKey", () => {
  it("writes a random 32-byte key when there's none, and keeps it on the next run", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, ".env.local"), "ANTHROPIC_API_KEY=keep-me\nAIDA_STUDIO_ALLOWED_HOSTS=x.example.com\n");
    const first = ensureStudioKey(dir);
    expect(first.created).toBe(true);
    expect(Buffer.from(first.key, "base64url")).toHaveLength(32);
    const after = readFileSync(join(dir, ".env.local"), "utf8");
    expect(after.startsWith("ANTHROPIC_API_KEY=keep-me\nAIDA_STUDIO_ALLOWED_HOSTS=x.example.com\n# ")).toBe(true);
    expect(after.endsWith(`\nAIDA_STUDIO_KEY=${first.key}\n`)).toBe(true);

    const second = ensureStudioKey(dir);
    expect(second).toMatchObject({ key: first.key, created: false });
    expect(readFileSync(join(dir, ".env.local"), "utf8")).toBe(after);
    expect(ensureStudioKey(tmpDir()).key).not.toBe(first.key);
  });

  it("keeps a key the user set, quoted or not, and replaces one too short to be safe in place", () => {
    const dir = tmpDir();
    const mine = "m".repeat(40);
    writeFileSync(join(dir, ".env.local"), `A=1\nAIDA_STUDIO_KEY="${mine}"\nB=2\n`);
    expect(ensureStudioKey(dir)).toMatchObject({ key: mine, created: false });

    writeFileSync(join(dir, ".env.local"), "A=1\nAIDA_STUDIO_KEY=short\nB=2\n");
    const r = ensureStudioKey(dir);
    expect(r.created).toBe(true);
    expect(readFileSync(join(dir, ".env.local"), "utf8")).toBe(`A=1\nAIDA_STUDIO_KEY=${r.key}\nB=2\n`);
  });

  it("builds the access links with the key in the fragment, never the query", () => {
    expect(studioAccessUrl("dev.example.com", "a-b_c")).toBe("https://dev.example.com/studio/access#key=a-b_c");
    expect(localStudioAccessUrl("a-b_c")).toBe("http://localhost:3000/studio/access#key=a-b_c");
    expect(localStudioAccessUrl("a-b_c", 3001)).toBe("http://localhost:3001/studio/access#key=a-b_c");
  });
});

describe(".env.local permissions (it holds the Studio key)", () => {
  const mode = (file: string) => statSync(file).mode & 0o777;
  const posix = process.platform !== "win32";

  it.runIf(posix)("writeTunnelHosts creates it 0600, so the key ensureStudioKey adds next is owner-only", () => {
    const dir = tmpDir();
    const file = join(dir, ".env.local");
    writeTunnelHosts(dir, ["dev.example.com"]);
    expect(mode(file)).toBe(0o600);
    ensureStudioKey(dir);
    expect(mode(file)).toBe(0o600);
  });

  it.runIf(posix)("ensureStudioKey creates it 0600", () => {
    const dir = tmpDir();
    ensureStudioKey(dir);
    expect(mode(join(dir, ".env.local"))).toBe(0o600);
  });

  it.runIf(posix)("tightens an existing world-readable file once it holds the key", () => {
    const dir = tmpDir();
    const file = join(dir, ".env.local");
    writeFileSync(file, "A=1\n", { mode: 0o644 });
    chmodSync(file, 0o644);
    ensureStudioKey(dir);
    expect(mode(file)).toBe(0o600);

    // A key already there (kept as is) is tightened too, by either function.
    chmodSync(file, 0o644);
    expect(ensureStudioKey(dir).created).toBe(false);
    expect(mode(file)).toBe(0o600);
    chmodSync(file, 0o644);
    writeTunnelHosts(dir, ["x.example.com"]);
    expect(mode(file)).toBe(0o600);
  });

  it.runIf(posix)("leaves a file without the key as it was", () => {
    const dir = tmpDir();
    const file = join(dir, ".env.local");
    writeFileSync(file, "A=1\n");
    chmodSync(file, 0o644);
    writeTunnelHosts(dir, ["x.example.com"]);
    expect(mode(file)).toBe(0o644);
  });
});
