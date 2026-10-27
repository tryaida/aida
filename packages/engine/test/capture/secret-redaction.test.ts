// Security review fixes: typed passwords and other secret field values never reach failure.json
// (one shared masking function with `aida inspect`), redaction runs before lines are capped,
// relative URLs lose their query, and Playwright step errors are redacted and capped before
// they're stored in validation.json or printed.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCapture } from "../../src/capture/runner.js";
import {
  LINE_CAP,
  maskSecretFieldValues,
  redactCardNumbers,
  redactErrorMessage,
  redactLine,
  redactSnapshotText,
  stripUrlsInText,
} from "../../src/capture/redact.js";
import type { ResolvedConfig } from "../../src/config/index.js";
import type { Walkthrough } from "../../src/walkthrough/index.js";
import { startFixtureServer, type FixtureServer } from "./fixture-server.js";

const TIMEOUT = 60_000;
const JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkFkYSBMb3ZlbGFjZSIsImlhdCI6MTUxNjIzOTAyMn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

describe("maskSecretFieldValues", () => {
  it("masks the value of a textbox whose name looks like a secret", () => {
    const snap = [
      '- textbox "Password": hunter2',
      '- textbox "New passcode" [disabled]: 112233',
      '- textbox "PIN": "4821"',
      '- textbox "API key": abc',
      '- textbox "One-time code": 123456',
      '- textbox "CVV": "123"',
      '- textbox "Card number": abc',
      '- textbox "SSN": 078-05-1120',
      '- textbox "Pass" (label: "Password *", required) [required]: hunter2',
      '- textbox "Notes": Bring a hat',
      '- textbox "Passenger name": Ada',
    ].join("\n");
    const out = maskSecretFieldValues(snap);
    expect(out).not.toMatch(/hunter2|112233|4821|abc|123456|"123"|078-05-1120/);
    expect(out).toContain('- textbox "Password": [REDACTED SECRET]');
    expect(out).toContain('- textbox "Notes": Bring a hat');
    expect(out).toContain('- textbox "Passenger name": Ada');
  });

  it("masks a textbox whose value is a password input's value, whatever its name", () => {
    const out = maskSecretFieldValues('- textbox "Login code": Tr0ub4dor\n- text: Tr0ub4dor is a word', "[x]", ["Tr0ub4dor"]);
    expect(out).toBe('- textbox "Login code": [x]\n- text: Tr0ub4dor is a word');
  });

  it("masks card numbers (Luhn-valid) and leaves other digit runs", () => {
    expect(redactCardNumbers("card 4111 1111 1111 1111 and 5555-5555-5555-4444 and 378282246310005")).toBe(
      "card [REDACTED CARD] and [REDACTED CARD] and [REDACTED CARD]",
    );
    // Not Luhn-valid, a millisecond timestamp, a short number.
    expect(redactCardNumbers("4111 1111 1111 1112 at 1716239022000 ref 2026 1234")).toBe("4111 1111 1111 1112 at 1716239022000 ref 2026 1234");
  });
});

describe("redaction order and relative URLs", () => {
  it("redacts before capping, so a cut-off JWT or email still goes", () => {
    const pad = "x".repeat(LINE_CAP - 20);
    expect(redactLine(`${pad} ${JWT}`)).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(redactLine(`${pad} sophie.harrington@gmail.com`)).not.toContain("sophie");
    const snap = redactSnapshotText(`- paragraph: ${pad} ${JWT}`);
    expect(snap).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("drops the query and fragment of a site-relative URL in text", () => {
    expect(stripUrlsInText("went to /reset?token=abc123 then (/login#access_token=xyz)")).toBe("went to /reset then (/login)");
    expect(stripUrlsInText('href="/invite/Zx9kQ2mT7vB4nR8pL3wY?x=1"')).toBe('href="/invite/[token]"');
    // Not a path: fractions and and/or.
    expect(stripUrlsInText("1/2 and/or 3 / 4?")).toBe("1/2 and/or 3 / 4?");
  });
});

describe("redactErrorMessage", () => {
  it("keeps the first line and a capped, redacted Received excerpt; drops the call log", () => {
    const message = [
      'expect(locator).toHaveValue(expected) failed',
      "",
      'Locator: getByLabel("Email")',
      'Expected string: "demo@example.com"',
      `Received string: "sophie.harrington@gmail.com ${"y".repeat(400)}"`,
      "Call log:",
      "  - waiting for getByLabel('Email') at https://app.test/x?token=secret",
    ].join("\n");
    const out = redactErrorMessage(message);
    expect(out.startsWith("expect(locator).toHaveValue(expected) failed | Received string:")).toBe(true);
    expect(out).not.toContain("sophie");
    expect(out).not.toContain("Call log");
    expect(out).not.toContain("token=secret");
    expect(out.length).toBeLessThan(LINE_CAP + 130);
    expect(out).not.toContain("\n");
  });
});

describe("capture: failure.json and validation.json", () => {
  let server: FixtureServer;
  const dirs: string[] = [];
  beforeAll(async () => {
    server = await startFixtureServer();
  });
  afterAll(async () => {
    await server.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  const config = (baseUrl: string): ResolvedConfig =>
    ({
      app: { baseUrl },
      viewport: { width: 800, height: 600 },
      deviceScaleFactor: 1,
      walkthroughsDir: ".",
      buildDir: ".",
    }) as unknown as ResolvedConfig;

  it(
    "masks a typed password, secret-named fields and card numbers, and stores a capped step error",
    async () => {
      const outDir = mkdtempSync(join(tmpdir(), "aida-secret-redaction-"));
      dirs.push(outDir);
      const walkthrough: Walkthrough = {
        walkthrough: "secret-fields",
        title: "t",
        start: { page: "/secret-fields.html" },
        steps: [
          {
            id: "fill",
            actions: [
              { do: "type", target: { label: "Password" }, text: "hunter2" },
              { do: "expect", target: { text: "Nope, not here" } },
            ],
          },
        ],
      } as Walkthrough;
      const result = await runCapture({ walkthrough, config: config(server.url), outDir, maxWaitMs: 1_500 });
      expect(result.failure).toBeDefined();
      const onDisk = readFileSync(join(outDir, "failure.json"), "utf8");
      for (const secret of ["hunter2", "Tr0ub4dor", "4821", "plain-looking-value", "4111 1111 1111 1111", "5555555555554444", "Zx9kQ2mT7vB4nR8pL3wY", "eyJhbGciOiJIUzI1NiJ9"]) {
        expect(onDisk).not.toContain(secret);
      }
      expect(onDisk).toContain("Bring a hat");
      const snapshot = JSON.parse(onDisk).snapshot as string;
      expect(snapshot).toContain('textbox "Password": [REDACTED SECRET]');
      expect(snapshot).toContain('textbox "Login code": [REDACTED SECRET]');
      expect(snapshot).toContain("/url: /reset");
      // What validation.json stores (commands/capture.ts writes `result.validation`).
      const step = result.validation.steps[0] as { error: string };
      expect(step.error).not.toContain("\n");
      expect(step.error.length).toBeLessThanOrEqual(LINE_CAP + 3 + 120);
    },
    TIMEOUT,
  );
});
