import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkOutbound } from "../../src/safety/index.js";
import { fingerprint } from "../../src/safety/classify.js";

const SECRET = "re_SuperSecretValue123";
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("checkOutbound", () => {
  it("finds live senders by variable name, never echoing values", () => {
    const env = {
      RESEND_API_KEY: SECRET,
      SENDGRID_API_KEY: SECRET,
      POSTMARK_SERVER_TOKEN: SECRET,
      MAILGUN_API_KEY: SECRET,
      AWS_SES_REGION: "us-east-1",
      TWILIO_AUTH_TOKEN: SECRET,
      VONAGE_API_SECRET: SECRET,
      MESSAGEBIRD_ACCESS_KEY: SECRET,
      SLACK_WEBHOOK_URL: `https://hooks.slack.com/services/${SECRET}`,
      ALERTS_HOOK: `https://hooks.slack.com/services/${SECRET}`,
    };
    const check = checkOutbound({ env });
    expect(check.findings.map((f) => f.variable).sort()).toEqual(Object.keys(env).sort());
    expect(check.message).toMatch(/send real emails, texts, Slack messages/);
    expect(JSON.stringify(check)).not.toContain(SECRET);
  });

  it("refuses a live Stripe key, and ignores test keys (finding 8)", () => {
    const live = checkOutbound({ env: { STRIPE_SECRET_KEY: "sk_live_abc123" } });
    expect(live.livePayments).toBe(true);
    expect(live.refusal).toMatch(/Refusing to capture: process\.env\.STRIPE_SECRET_KEY holds a LIVE Stripe key/);
    expect(live.refusalSuggestions.join(" ")).toContain(`app: { allowLivePayments: "process.env:STRIPE_SECRET_KEY#${fingerprint("sk_live_abc123")}" }`);
    expect(JSON.stringify(live)).not.toContain("sk_live_abc123");
    expect(checkOutbound({ env: { STRIPE_SECRET_KEY: "sk_test_abc" } }).findings).toEqual([]);
  });

  it("finds a live key by value, whatever the variable is called", () => {
    const check = checkOutbound({ env: { PAYMENTS_SECRET: "rk_live_xyz" } });
    expect(check.findings).toEqual([expect.objectContaining({ variable: "PAYMENTS_SECRET", kind: "payments", live: true })]);
    expect(check.refusal).not.toBe("");
  });

  it('app.outbound: "dry-run" doesn\'t cover a live payment key', () => {
    const check = checkOutbound({ config: { app: { outbound: "dry-run" } }, env: { STRIPE_SECRET_KEY: "sk_live_abc123", RESEND_API_KEY: SECRET } });
    expect(check.message).toBe("");
    expect(check.refusal).toMatch(/app\.outbound: "dry-run" covers emails and texts only, not payments/);
  });

  it("app.allowLivePayments allows exactly the listed setting", () => {
    const dir = mkdtempSync(join(tmpdir(), "aida-outbound-"));
    dirs.push(dir);
    writeFileSync(join(dir, ".env.local"), "STRIPE_SECRET_KEY=sk_live_abc\n");
    const entry = `.env.local:STRIPE_SECRET_KEY#${fingerprint("sk_live_abc")}`;
    const allowed = checkOutbound({ config: { app: { dir, allowLivePayments: [entry] } }, env: {} });
    expect(allowed.refusal).toBe("");
    expect(allowed.findings[0]).toMatchObject({ live: true, allowed: true });
    // Another file holding a live key refuses again.
    writeFileSync(join(dir, ".env"), "STRIPE_SECRET_KEY=sk_live_def\n");
    const again = checkOutbound({ config: { app: { dir, allowLivePayments: [entry] } }, env: {} });
    expect(again.refusal).toMatch(/^Refusing to capture: \.env:STRIPE_SECRET_KEY holds/);
  });

  it("only counts a non-local SMTP host", () => {
    expect(checkOutbound({ env: { SMTP_HOST: "localhost" } }).findings).toEqual([]);
    expect(checkOutbound({ env: { SMTP_HOST: "127.0.0.1:1025" } }).findings).toEqual([]);
    expect(checkOutbound({ env: { SMTP_HOST: "smtp.sendgrid.net" } }).findings).toHaveLength(1);
    expect(checkOutbound({ env: { EMAIL_SERVER: `smtp://u:${SECRET}@smtp.example.com:587` } }).findings).toHaveLength(1);
  });

  it("skips blank values (a capture server that blanks its keys)", () => {
    expect(checkOutbound({ env: { RESEND_API_KEY: "" } }).findings).toEqual([]);
  });

  it("reads the app's env files", () => {
    const dir = mkdtempSync(join(tmpdir(), "aida-outbound-"));
    dirs.push(dir);
    writeFileSync(join(dir, ".env.local"), `RESEND_API_KEY=${SECRET}\n`);
    const check = checkOutbound({ config: { app: { dir } }, env: {} });
    expect(check.findings).toEqual([{ source: ".env.local:RESEND_API_KEY", variable: "RESEND_API_KEY", kind: "email", service: "Resend" }]);
  });

  it('is silenced by app.outbound: "dry-run"', () => {
    const check = checkOutbound({ config: { app: { outbound: "dry-run" } }, env: { RESEND_API_KEY: SECRET } });
    expect(check.acknowledged).toBe(true);
    expect(check.message).toBe("");
    expect(check.findings).toHaveLength(1);
  });

  it("ignores look-alike names", () => {
    expect(checkOutbound({ env: { SESSION_SECRET: SECRET, NEXT_PUBLIC_STRIPE_KEY: "pk_live_x" } }).findings).toEqual([]);
  });
});
