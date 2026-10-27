// What capture hands an agent is redacted: URLs lose queries, fragments and opaque path segments
// (tokens), secrets and personal data go, and every line is capped (M28 review).
import { describe, expect, it } from "vitest";
import { capLine, isOpaqueSegment, LINE_CAP, redactLine, redactSnapshotText, stripQueryAndHash } from "../../src/capture/redact.js";

describe("capture redaction", () => {
  it("strips opaque path segments, keeps page names", () => {
    expect(stripQueryAndHash("http://127.0.0.1:3000/invite/Zx9kQ2mT7vB4nR8pL3wY?x=1#y")).toBe("http://127.0.0.1:3000/invite/[token]");
    expect(stripQueryAndHash("http://h/reset/0123456789abcdef0123")).toBe("http://h/reset/[token]");
    expect(stripQueryAndHash("http://h/r/550e8400-e29b-41d4-a716-446655440000/edit")).toBe("http://h/r/[token]/edit");
    expect(stripQueryAndHash("http://h/shows/summer-show-2026-entries")).toBe("http://h/shows/summer-show-2026-entries");
    expect(stripQueryAndHash("http://h/registrationsettings")).toBe("http://h/registrationsettings");
    expect(isOpaqueSegment("short1")).toBe(false);
  });

  it("redacts link targets and long lines in a snapshot", () => {
    const snap = redactSnapshotText(`- link "Accept":\n  - /url: /invite/Zx9kQ2mT7vB4nR8pL3wY?ref=mail\n- text: ${"x".repeat(500)}`);
    expect(snap).toContain("/url: /invite/[token]");
    expect(snap).not.toContain("ref=mail");
    expect(capLine("y".repeat(500))).toHaveLength(LINE_CAP);
  });

  it("redactLine: first line, URLs, secrets, personal data, capped", () => {
    const line = redactLine(`failed for ada@realmail.com at https://app.test/a?token=abc with Bearer abcdefghijklmnop1234567890\nmore`);
    expect(line).toBe("failed for [REDACTED EMAIL] at https://app.test/a with [REDACTED SECRET]");
  });
});
