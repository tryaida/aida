// Outbound side effects (build-plan.md M24): capture fills in real forms, so an app with a live
// email/SMS sender or a live payment key may send real messages or take real payments while
// aida captures it. Scans the same settings as the database guard (process.env plus the app's
// env files, safety/env.ts) and reports variable names only, never values.
//
// Two levels:
//   - Email/SMS/chat senders: a warning. `app.outbound: "dry-run"` in aida.config confirms the
//     app sends nothing real and silences it.
//   - A live Stripe secret or restricted key (`sk_live_`, `rk_live_`) in any variable, alone or
//     inside a longer value (JSON): a refusal. "dry-run" doesn't cover it; only
//     `app.allowLivePayments` listing that exact setting bound to that exact key
//     (`.env.local:STRIPE_SECRET_KEY#<fingerprint>`, a one-way fingerprint, never the key) does.
//     A different key in that setting refuses again.
import { classifyHost, fingerprint } from "./classify.js";
import { collectAppEnv } from "./env.js";
import { resolveAppDir } from "./database.js";
import type { AppSafetyConfig } from "./database.js";

export type OutboundKind = "email" | "sms" | "chat" | "payments";

export interface OutboundFinding {
  /** `process.env.RESEND_API_KEY` or `.env.local:RESEND_API_KEY`. */
  source: string;
  variable: string;
  kind: OutboundKind;
  /** The service, e.g. "Resend", "Stripe (LIVE key)". */
  service: string;
  /** A live payment key: real money moves. */
  live?: boolean;
  /** A live payment key listed in `app.allowLivePayments`. */
  allowed?: boolean;
  /** A live payment key's fingerprint (first 10 hex of sha256; never the key), for `allowLivePayments`. */
  fingerprint?: string;
}

export interface OutboundCheck {
  findings: OutboundFinding[];
  /** `app.outbound: "dry-run"` is set (covers email, texts and chat only). */
  acknowledged: boolean;
  /** Any live payment key found. */
  livePayments: boolean;
  /** Plain-English warning about senders; empty when there's nothing to say (no findings, or acknowledged). */
  message: string;
  /** Plain-English refusal for a live payment key not in `app.allowLivePayments`; empty otherwise. */
  refusal: string;
  /** What to do about the refusal. */
  refusalSuggestions: string[];
}

interface Rule {
  service: string;
  kind: OutboundKind;
  /** Name test. */
  name: (n: string) => boolean;
  /** Optional value test; the value is never kept. */
  value?: (v: string) => boolean;
  live?: boolean;
}

/** A sender host that isn't this machine (a local mail catcher such as Mailpit is fine). */
function remoteHost(v: string): boolean {
  let host = v.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    try {
      host = new URL(host).hostname;
    } catch {
      return true;
    }
  } else {
    host = host.split(":")[0];
  }
  return classifyHost(host).kind !== "local";
}

/** Live Stripe secret/restricted keys, alone or inside a longer value (a JSON blob). */
const LIVE_KEY = /(?<![A-Za-z0-9_])(?:sk|rk)_live_[A-Za-z0-9]+/g;

function liveKeys(value: string): string[] {
  return [...new Set(value.match(LIVE_KEY) ?? [])].sort();
}

const RULES: Rule[] = [
  // Any variable: a live Stripe secret or restricted key moves real money whatever it's called.
  { service: "Stripe (LIVE key)", kind: "payments", name: () => true, value: (v) => liveKeys(v).length > 0, live: true },
  { service: "Resend", kind: "email", name: (n) => n === "RESEND_API_KEY" },
  { service: "SendGrid", kind: "email", name: (n) => n === "SENDGRID_API_KEY" },
  { service: "Postmark", kind: "email", name: (n) => /^POSTMARK_.*(TOKEN|KEY)$/.test(n) },
  { service: "Mailgun", kind: "email", name: (n) => n === "MAILGUN_API_KEY" },
  { service: "Amazon SES", kind: "email", name: (n) => /(^|_)SES(_|$)/.test(n) },
  { service: "SMTP", kind: "email", name: (n) => /^(SMTP_HOST|SMTP_SERVER|MAIL_HOST|EMAIL_HOST|EMAIL_SERVER_HOST)$/.test(n), value: remoteHost },
  // Auth.js's email provider: `EMAIL_SERVER=smtp://user:pass@host:587`.
  { service: "SMTP", kind: "email", name: (n) => n === "EMAIL_SERVER" || n === "SMTP_URL", value: remoteHost },
  { service: "Twilio", kind: "sms", name: (n) => n === "TWILIO_AUTH_TOKEN" || n === "TWILIO_API_SECRET" },
  { service: "Vonage", kind: "sms", name: (n) => /^(VONAGE|NEXMO)_(API_SECRET|API_KEY|PRIVATE_KEY.*)$/.test(n) },
  { service: "MessageBird", kind: "sms", name: (n) => /^MESSAGEBIRD_.*(KEY|TOKEN)$/.test(n) },
  { service: "Slack webhook", kind: "chat", name: (n) => /SLACK/.test(n) && /WEBHOOK/.test(n) },
  { service: "Slack webhook", kind: "chat", name: () => true, value: (v) => v.startsWith("https://hooks.slack.com/") },
];

function matchRule(variable: string, value: string): Rule | undefined {
  return RULES.find((r) => r.name(variable) && (!r.value || r.value(value)));
}

export interface CheckOutboundOptions {
  config?: AppSafetyConfig;
  appDir?: string;
  env?: Record<string, string | undefined>;
}

/** `app.allowLivePayments` entries: `source#fingerprint`, source normalised (`process.env:X` -> `process.env.X`). */
function allowedLive(config: AppSafetyConfig | undefined): { text: string; source: string; fp?: string }[] {
  const raw = config?.app?.allowLivePayments;
  const list = Array.isArray(raw) ? raw : raw ? [raw as unknown as string] : [];
  return list
    .map((e) => String(e).trim())
    .filter((e) => e !== "")
    .map((text) => {
      const i = text.indexOf("#");
      const source = (i >= 0 ? text.slice(0, i) : text).replace(/^process\.env:/, "process.env.");
      return { text, source, ...(i >= 0 ? { fp: text.slice(i + 1).trim().toLowerCase() } : {}) };
    });
}

/** The entry that allows this exact key in this exact setting. */
function allowEntry(f: OutboundFinding): string {
  return `${f.source.replace(/^process\.env\./, "process.env:")}#${f.fingerprint}`;
}

/** Lists live senders and payment keys the app may start with. Synchronous; reads files only. */
export function checkOutbound(opts: CheckOutboundOptions = {}): OutboundCheck {
  const env = opts.env ?? process.env;
  const appDir = opts.appDir ?? resolveAppDir(opts.config)?.dir;
  // Every variable is a candidate (the Stripe and Slack rules match on value); rules filter below.
  const appEnv = collectAppEnv(appDir, env, () => true);
  const allow = allowedLive(opts.config);
  const findings: OutboundFinding[] = [];
  const stale: string[] = [];
  for (const v of appEnv.values) {
    const rule = matchRule(v.variable, v.value);
    if (!rule) continue;
    const fp = rule.live ? fingerprint(liveKeys(v.value).join(",")) : undefined;
    const entries = rule.live ? allow.filter((a) => a.source === v.source) : [];
    const allowed = entries.some((a) => a.fp === fp);
    const finding: OutboundFinding = {
      source: v.source,
      variable: v.variable,
      kind: rule.kind,
      service: rule.service,
      ...(rule.live ? { live: true, fingerprint: fp } : {}),
      ...(allowed ? { allowed: true } : {}),
    };
    findings.push(finding);
    if (entries.length > 0 && !allowed) {
      stale.push(
        entries[0].fp
          ? `app.allowLivePayments lists "${entries[0].text}", but ${v.source} now holds a different live key (fingerprint ${fp}), so it's refused again. ` +
              `If this key is also meant to be allowed, list it as "${allowEntry(finding)}" instead.`
          : `app.allowLivePayments lists "${entries[0].text}" without the key's fingerprint, so it doesn't apply. To allow exactly the key it holds now, list it as "${allowEntry(finding)}".`,
      );
    }
  }
  const acknowledged = opts.config?.app?.outbound === "dry-run";
  const livePayments = findings.some((f) => f.live);
  const senders = findings.filter((f) => !f.live);
  const refused = findings.filter((f) => f.live && !f.allowed);
  return {
    findings,
    acknowledged,
    livePayments,
    message: acknowledged ? "" : describeSenders(senders),
    refusal: refused.length > 0 ? describeLive(refused) : "",
    refusalSuggestions: refused.length > 0 ? [...stale, ...liveSuggestions(refused)] : [],
  };
}

function describeSenders(findings: OutboundFinding[]): string {
  if (findings.length === 0) return "";
  const kinds = new Set(findings.map((f) => f.kind));
  const sends = [kinds.has("email") ? "emails" : "", kinds.has("sms") ? "texts" : "", kinds.has("chat") ? "Slack messages" : ""].filter(Boolean);
  const names = findings.map((f) => `${f.source} (${f.service})`).join(", ");
  return (
    `The app may send real ${sends.join(", ")} during capture: ${names}. Set the app to dry-run (or blank these for the capture server), ` +
    `then confirm with app: { outbound: "dry-run" } in aida.config.`
  );
}

function describeLive(refused: OutboundFinding[]): string {
  const sources = refused.map((f) => f.source);
  return (
    `Refusing to capture: ${sources.join(", ")} ${refused.length === 1 ? "holds" : "hold"} a LIVE Stripe key (sk_live_ or rk_live_). ` +
    "Capture runs each walkthrough's steps for real, so it could charge real cards or move real money. " +
    'app.outbound: "dry-run" covers emails and texts only, not payments.'
  );
}

function liveSuggestions(refused: OutboundFinding[]): string[] {
  const entries = refused.map(allowEntry);
  const value = entries.length === 1 ? `"${entries[0]}"` : `[${entries.map((s) => `"${s}"`).join(", ")}]`;
  return [
    "Use a Stripe test key (sk_test_...) for the capture server, and blank or remove the live key from the files it reads.",
    "Only if the server you capture against doesn't use this key (it's started with a test key that overrides it), or you really mean " +
      `to capture against live payments, allow exactly this key in this setting in aida.config: app: { allowLivePayments: ${value} }. ` +
      "After # is a fingerprint of the key (never the key itself): a different key in that setting is refused again.",
  ];
}
