import { describe, expect, it } from "vitest";
import {
  FEEDBACK_LIMITS,
  cleanReaderText,
  hasHiddenCharacters,
  normaliseFeedbackPath,
  normaliseQuery,
  redactFeedbackText,
  sanitizeFeedbackEntry,
  validateFeedback,
} from "../../src/feedback/entry.js";

// Fake secrets built at run time, so no key-shaped string sits in the repo.
const ANTHROPIC_KEY = `sk-ant-${"a1B2c3D4".repeat(4)}`;
const GITHUB_TOKEN = `ghp_${"Z9y8X7w6".repeat(5)}`;

describe("validateFeedback", () => {
  it("accepts each kind with its own fields", () => {
    expect(validateFeedback({ kind: "helpful", page: "/billing/refunds" })).toEqual({
      ok: true,
      input: { kind: "helpful", page: "/billing/refunds" },
    });
    expect(validateFeedback({ kind: "not-helpful", page: "/billing/refunds", comment: "partial refunds" })).toEqual({
      ok: true,
      input: { kind: "not-helpful", page: "/billing/refunds", comment: "partial refunds" },
    });
    expect(validateFeedback({ kind: "no-results", query: "export invoices", currentPath: "/invoices", page: "/" })).toEqual({
      ok: true,
      input: { kind: "no-results", query: "export invoices", currentPath: "/invoices", page: "/" },
    });
  });

  it("refuses anything that isn't a plain object or has an unknown kind", () => {
    for (const body of [null, "helpful", ["helpful"], 3, { kind: "love-it", page: "/" }, { page: "/" }]) {
      expect(validateFeedback(body).ok).toBe(false);
    }
  });

  it("refuses fields outside the contract, including identifying ones, and fields from another kind", () => {
    for (const extra of [{ userId: "u1" }, { ip: "203.0.113.9" }, { email: "x@example.com" }, { userAgent: "Mozilla" }, { query: "x" }]) {
      expect(validateFeedback({ kind: "helpful", page: "/a", ...extra }).ok).toBe(false);
    }
    expect(validateFeedback({ kind: "helpful", page: "/a", comment: "nice" }).ok).toBe(false);
    expect(validateFeedback({ kind: "no-results", query: "x", comment: "nice" }).ok).toBe(false);
  });

  it("requires page for votes and query for no-results", () => {
    expect(validateFeedback({ kind: "helpful" }).ok).toBe(false);
    expect(validateFeedback({ kind: "not-helpful", comment: "hm" }).ok).toBe(false);
    expect(validateFeedback({ kind: "no-results" }).ok).toBe(false);
    expect(validateFeedback({ kind: "no-results", query: "   " }).ok).toBe(false);
  });

  it("refuses non-string values", () => {
    expect(validateFeedback({ kind: "helpful", page: 5 }).ok).toBe(false);
    expect(validateFeedback({ kind: "no-results", query: { $ne: "" } }).ok).toBe(false);
  });

  it("refuses over-cap text instead of cutting it", () => {
    expect(validateFeedback({ kind: "no-results", query: "q".repeat(FEEDBACK_LIMITS.query) }).ok).toBe(true);
    expect(validateFeedback({ kind: "no-results", query: "q".repeat(FEEDBACK_LIMITS.query + 1) }).ok).toBe(false);
    expect(validateFeedback({ kind: "not-helpful", page: "/a", comment: "c".repeat(FEEDBACK_LIMITS.comment + 1) }).ok).toBe(false);
    expect(validateFeedback({ kind: "helpful", page: `/${"p".repeat(FEEDBACK_LIMITS.path)}` }).ok).toBe(false);
  });

  it("refuses paths that aren't site-relative", () => {
    for (const page of ["https://evil.example.com/x", "//evil.example.com/x", "billing", "/a b", "javascript:alert(1)"]) {
      expect(validateFeedback({ kind: "helpful", page }).ok).toBe(false);
    }
  });

  it("never repeats the input in an error", () => {
    const secret = "sam@acme-mail.net";
    const results = [
      validateFeedback({ kind: "helpful", page: "/a", [secret]: 1 }),
      validateFeedback({ kind: secret }),
      validateFeedback({ kind: "helpful", page: secret }),
    ];
    for (const r of results) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).not.toContain(secret);
    }
  });

  it("drops an empty optional comment", () => {
    expect(validateFeedback({ kind: "not-helpful", page: "/a", comment: "  " })).toEqual({ ok: true, input: { kind: "not-helpful", page: "/a" } });
  });

  it("redacts and normalises before returning", () => {
    const r = validateFeedback({
      kind: "not-helpful",
      page: "/orders/12345?token=abc#top",
      currentPath: "/users/9f1c2a7e-1b2c-4d5e-8f90-123456789abc/edit",
      comment: `email me at sam@acme-mail.net or 0412 345 678, key ${ANTHROPIC_KEY}`,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.page).toBe("/orders/*");
    expect(r.input.currentPath).toBe("/users/*/edit");
    expect(r.input.comment).not.toContain("sam@acme-mail.net");
    expect(r.input.comment).not.toContain("0412 345 678");
    expect(r.input.comment).not.toContain(ANTHROPIC_KEY);
  });
});

describe("redactFeedbackText", () => {
  it("removes emails, phone numbers, account numbers and keys, keeping fictional data", () => {
    const out = redactFeedbackText(
      `sam@acme-mail.net test@example.com 0412 345 678 555-0123 acct 98765432 ${GITHUB_TOKEN} api_key=Hunter2Hunter2`,
      300,
    );
    expect(out).not.toMatch(/sam@acme-mail\.net|0412 345 678|98765432|Hunter2/);
    expect(out).not.toContain(GITHUB_TOKEN);
    expect(out).toContain("test@example.com");
    expect(out).toContain("555-0123");
    expect(out).toContain("[redacted-secret]");
    expect(out).toContain("[redacted-email]");
  });

  it("drops the query string of a pasted URL and long unprefixed tokens", () => {
    const out = redactFeedbackText("see https://app.example.com/reset?token=abc123 and code a8F3k2L9q0W7e6R5t4Y3u2I1o0", 300);
    expect(out).toContain("https://app.example.com/reset");
    expect(out).not.toContain("token=abc123");
    expect(out).not.toContain("a8F3k2L9q0W7e6R5t4Y3u2I1o0");
  });

  it("turns control characters into spaces, removes invisible ones and collapses whitespace", () => {
    const zeroWidth = String.fromCharCode(0x200b);
    const rtlOverride = String.fromCharCode(0x202e);
    // A zero-width space is removed, not spaced, so a word split by one joins back up.
    expect(redactFeedbackText(`a\u0000b${zeroWidth}c\n\n${rtlOverride}d   e`, 300)).toBe("a bc d e");
  });

  it("removes tag characters, variation selectors, soft hyphens, joiners and fillers", () => {
    const tags = Array.from({ length: 53 }, (_, i) => String.fromCodePoint(0xe0020 + i)).join("");
    const hidden = [tags, "\u{e0001}", "\u{e007f}", "\ufe0f", "\u{e0100}", "\u00ad", "\u034f", "\u180e", "\u3164", "\uffa0", "\u115f", "\u2060", "\ufeff", "\u{f0000}"].join("");
    const out = redactFeedbackText(`refund${hidden} policy`, 300);
    expect(out).toBe("refund policy");
    expect(hasHiddenCharacters(out)).toBe(false);
    for (const ch of hidden) expect(hasHiddenCharacters(`x${ch}`)).toBe(true);
    expect(cleanReaderText(`Ｅｘｐｏｒｔ\u00adinvoices`)).toBe("Exportinvoices");
  });

  it("redacts a secret whose key word an invisible character split", () => {
    expect(redactFeedbackText("pass\u200bword: hunter2xx", 300)).toBe("password=[redacted-secret]");
    expect(redactFeedbackText("pass\u00adword hunter2", 300)).toBe("password [redacted-secret]");
  });

  it("redacts bare key words with a value, with or without a prefix", () => {
    for (const [input, gone] of [
      ["password: hunter2xx", "hunter2xx"],
      ["token=abcdef12", "abcdef12"],
      ["secret: s3cr3tvalue", "s3cr3tvalue"],
      ["password hunter2", "hunter2"],
      ["my pin is 4821", "4821"],
      ["db_password=Tr0ub4dor", "Tr0ub4dor"],
      ["x-api-key: abc123xyz", "abc123xyz"],
      ["authtoken=zzz999", "zzz999"],
    ] as const) {
      const out = redactFeedbackText(input, 300);
      expect(out, input).not.toContain(gone);
      expect(out, input).toContain("[redacted-secret]");
    }
  });

  it("keeps plain words after a key word", () => {
    expect(redactFeedbackText("the password reset link never came", 300)).toBe("the password reset link never came");
    expect(redactFeedbackText("which token expires first", 300)).toBe("which token expires first");
  });

  it("drops query strings from relative and scheme-less URLs, whole", () => {
    expect(redactFeedbackText("went to app.acme.io/reset?token=abc123def456ghi then stuck", 300)).toBe("went to app.acme.io/reset then stuck");
    expect(redactFeedbackText("opened /reset?token=abcdef1234567890 and", 300)).toBe("opened /reset and");
    expect(redactFeedbackText("see /billing?invoice=88&email=sam@acme-mail.net", 300)).toBe("see /billing");
  });

  it("redacts ids, tokens and personal data in URL and path segments", () => {
    expect(redactFeedbackText("link https://app.example.com/i/a8Kx9Q failed", 300)).toBe("link https://app.example.com/i/* failed");
    expect(redactFeedbackText("on /users/jane@acme.io/billing.", 300)).toBe("on /users/*/billing.");
    expect(redactFeedbackText("https://app.example.com/reset/abcdefghijklmnop", 300)).toBe("https://app.example.com/reset/*");
    expect(redactFeedbackText("app.acme.io/orders/12345/edit", 300)).toBe("app.acme.io/orders/*/edit");
  });

  it("redacts social security numbers and card numbers whole, spaced or not", () => {
    for (const input of ["123-45-6789", "123 45 6789", "4111 1111 1111 1111", "4111-1111-1111-1111", "4111111111111111", "1234 5678 9012 3456"]) {
      const out = redactFeedbackText(`mine is ${input} ok`, 300);
      expect(out, input).not.toMatch(/\d{3,}/);
    }
    // The fictional ranges stay, as everywhere else in aida.
    expect(redactFeedbackText("call 0491 570 006 or 555-0123", 300)).toBe("call 0491 570 006 or 555-0123");
  });

  it("caps the stored length", () => {
    expect(redactFeedbackText("word ".repeat(200), 50).length).toBeLessThanOrEqual(51);
  });
});

describe("normaliseFeedbackPath", () => {
  it("stores the screen pattern: ids and tokens as *, no query or fragment", () => {
    expect(normaliseFeedbackPath("/invite/AbCdEf0123456789XyZ/accept?x=1")).toBe("/invite/*/accept");
    expect(normaliseFeedbackPath("/events/42#step-3")).toBe("/events/*");
    expect(normaliseFeedbackPath("/getting-started/add-a-show")).toBe("/getting-started/add-a-show");
  });

  it("redacts each segment and drops ;params", () => {
    expect(normaliseFeedbackPath("/users/jane@acme.io/billing")).toBe("/users/*/billing");
    expect(normaliseFeedbackPath("/users/jane%40acme.io/billing")).toBe("/users/*/billing");
    expect(normaliseFeedbackPath("/x;jsessionid=ABC123DEF456")).toBe("/x");
    expect(normaliseFeedbackPath("/reset/abcdefghijklmnop")).toBe("/reset/*");
    expect(normaliseFeedbackPath("/i/a8Kx9Q")).toBe("/i/*");
    expect(normaliseFeedbackPath("/call/0412345678")).toBe("/call/*");
  });

  it("refuses a path with invisible characters", () => {
    expect(normaliseFeedbackPath("/billing\u{e0041}\u{e0047}")).toBeUndefined();
    expect(normaliseFeedbackPath("/bill\u00ading")).toBeUndefined();
  });
});

describe("normaliseQuery", () => {
  it("groups by case, punctuation and spacing", () => {
    expect(normaliseQuery("  Export   Invoices?! ")).toBe("export invoices");
    expect(normaliseQuery("export invoices")).toBe("export invoices");
  });

  it("groups full-width and invisibly padded forms with the plain one", () => {
    expect(normaliseQuery("Ｅｘｐｏｒｔ invoices")).toBe("export invoices");
    expect(normaliseQuery("export\u{e0041} invoi\u200bces")).toBe("export invoices");
  });
});

describe("sanitizeFeedbackEntry", () => {
  it("keeps only contract fields, re-redacts, and trims the time to a day", () => {
    const entry = sanitizeFeedbackEntry({
      kind: "not-helpful",
      page: "/a/123",
      comment: "call 0412 345 678",
      at: "2026-11-11T10:22:33.000Z",
      ip: "203.0.113.9",
      userAgent: "Mozilla/5.0",
      cookie: "session=abc",
    });
    expect(entry).toEqual({ kind: "not-helpful", page: "/a/*", comment: expect.not.stringContaining("0412"), at: "2026-11-11" });
    expect(Object.keys(entry!).sort()).toEqual(["at", "comment", "kind", "page"]);
  });

  it("rejects entries without a kind, a date or their required field", () => {
    expect(sanitizeFeedbackEntry({ kind: "helpful", page: "/a" })).toBeUndefined();
    expect(sanitizeFeedbackEntry({ kind: "helpful", at: "2026-11-11" })).toBeUndefined();
    expect(sanitizeFeedbackEntry({ kind: "nope", page: "/a", at: "2026-11-11" })).toBeUndefined();
  });
});
