// Redaction shared by everything capture hands to an agent: the failure report's snapshot, URLs,
// its error line and the short evidence lines (page/console error text) in its `changes` section,
// and the step errors `build/failures.ts` copies into report.json.
import {
  AU_MOBILE_FICTIONAL,
  AU_LANDLINE_FICTIONAL,
  US_FICTIONAL,
  UK_MOBILE_FICTIONAL,
  PHONE_CANDIDATE,
  EMAIL_PATTERN,
  SAFE_EMAIL_DOMAINS,
  looksLikeIdOrHash,
} from "../qa/pii.js";
import { SECRET_PATTERNS } from "../qa/secrets.js";

/** A path segment that looks like an opaque token (`/invite/<token>`, `/reset/<token>`): 16+
 * characters of base64/hex-ish text with a digit or mixed case, and not a plain slug
 * (`summer-show-2026`). A UUID counts: it can be an invite or reset token as easily as an id. */
const OPAQUE_SEGMENT = /^[A-Za-z0-9_\-+=.~%]{16,}$/;
const SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isOpaqueSegment(segment: string): boolean {
  if (!OPAQUE_SEGMENT.test(segment)) return false;
  if (UUID.test(segment)) return true;
  // A slug made of words is a page name; one whose parts are all hex is an id or a token.
  if (SLUG.test(segment) && /[g-z]/.test(segment)) return false;
  return /\d/.test(segment) || (/[a-z]/.test(segment) && /[A-Z]/.test(segment));
}

/** `/invite/abc...xyz` -> `/invite/[token]`. */
export function stripOpaqueSegments(path: string): string {
  return path
    .split("/")
    .map((seg) => (isOpaqueSegment(seg) ? "[token]" : seg))
    .join("/");
}

/**
 * Drops the query string and fragment from a URL before it reaches failure.json, and replaces
 * opaque path segments (`/invite/<token>`) with `[token]` — an agent-facing file (per this
 * module's own "Never full HTML or console logs" rule) must not leak a token, session id, or
 * other secret that landed in a query param (`?token=...`, `?reset=...`), a hash, or the path.
 * Falls back to a simple string cut if the URL doesn't parse (never throws).
 */
export function stripQueryAndHash(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    // `URL` would percent-encode the brackets of `[token]`, so the path is put back by hand.
    const path = stripOpaqueSegments(u.pathname);
    return u.origin === "null" ? `${u.protocol}${path}` : `${u.origin}${path}`;
  } catch {
    return stripOpaqueSegments(url.split(/[?#]/)[0]);
  }
}

/** A site-relative path in text (`/reset?token=…`), after a space, quote, bracket or `=`: not the
 * path part of an absolute URL, and not a fraction or `and/or`. */
const RELATIVE_PATH = /(^|[\s"'`(<[=,])(\/[^\s"'`<>?#)\]]*)([?#][^\s"'`<>)\]]*)?/g;

/** Every URL in a line of text, query, fragment and opaque path segments dropped — absolute URLs
 * and site-relative paths (`/reset?token=…` -> `/reset`) alike. */
export function stripUrlsInText(text: string): string {
  const absolute = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>)\]]+/gi, (url) => {
    if (!/^https?:/i.test(url)) return url.replace(/[?#].*$/, "");
    return stripQueryAndHash(url);
  });
  return absolute.replace(RELATIVE_PATH, (_m, before: string, path: string) => before + stripOpaqueSegments(path));
}

/**
 * A field label that says its value is a secret. Playwright's aria snapshot doesn't say a textbox
 * is `type=password` (it prints `textbox "Password": hunter2`), so the name is all there is.
 */
const SECRET_FIELD_NAME =
  /pass(?:word|wd|code|phrase)|\bpass\b|\bpin\b|secret|token|api[\s_-]?key|\botp\b|one[\s-]?time (?:code|password)|verification code|security code|\bcvv2?\b|\bcvc\b|card ?(?:number|no\b)|credit card|debit card|\bssn\b|social security/i;

/** `- textbox "Name" [attrs] (annotations): value` — a form control line with a typed value, in a
 * raw aria snapshot or after inspect's annotations. Group 1 is everything up to the value. */
const FIELD_VALUE_LINE =
  /^(\s*- (?:textbox|searchbox|spinbutton|combobox)\b(?: "(?:[^"\\]|\\.)*")?(?: \[[^\]]*\]| \((?:"(?:[^"\\]|\\.)*"|[^)"])*\))*: )(.+)$/;

/** Luhn check, for telling a card number from any other long digit run. */
function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** 13-19 digits, optionally in groups split by single spaces or dashes, starting 2-6 (the card
 * networks' ranges; a millisecond timestamp or snowflake id starts with 1). */
const CARD_CANDIDATE = /(?<![\d-])[2-6]\d{3}(?:[ -]?\d{1,4}){2,4}(?![\d-])/g;

/** Replaces anything shaped like a payment card number (13-19 digits passing the Luhn check). */
export function redactCardNumbers(text: string, placeholder = "[REDACTED CARD]"): string {
  return text.replace(CARD_CANDIDATE, (match) => {
    const digits = match.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) return match;
    return luhnValid(digits) ? placeholder : match;
  });
}

/** The value as the aria snapshot printed it, unquoted when it was YAML-quoted. */
function snapshotValue(raw: string): string {
  const v = raw.trim();
  if (v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1);
    }
  }
  return v;
}

/**
 * Masks typed values a person shouldn't see in a report: the value of every textbox whose name
 * looks like a secret (password, passcode, PIN, secret, token, API key, OTP, CVV, card number,
 * SSN, ...), of every textbox whose value is one of `secretValues` (what the page's
 * `input[type=password]` fields hold — the aria snapshot doesn't say a field is a password field,
 * so the caller reads them off the page; see `PASSWORD_VALUES_SCRIPT`), and any
 * card-number-shaped value anywhere. Shared by capture's failure report and `aida inspect`, over
 * raw aria-snapshot text (one line or many).
 */
export function maskSecretFieldValues(text: string, placeholder = "[REDACTED SECRET]", secretValues: string[] = []): string {
  const known = new Set(secretValues.map((v) => v.replace(/\s+/g, " ").trim()).filter(Boolean));
  const lines = text.split("\n").map((line) => {
    const m = line.match(FIELD_VALUE_LINE);
    if (!m) return line;
    if (SECRET_FIELD_NAME.test(m[1]) || known.has(snapshotValue(m[2]).replace(/\s+/g, " ").trim())) return m[1] + placeholder;
    return line;
  });
  return redactCardNumbers(lines.join("\n"), placeholder);
}

/** `page.evaluate` source (a string: see init-scripts.ts on `__name`): the values of the page's
 * password inputs, for `maskSecretFieldValues`' `secretValues`. */
export const PASSWORD_VALUES_SCRIPT = `
(() => Array.from(document.querySelectorAll("input[type=password]"))
  .map((el) => el.value)
  .filter((v) => v && v.length > 0))()
`;

/**
 * An aria snapshot made agent-safe: secret field values are masked (`secretValues`: the page's
 * password-input values), link targets (`/url: /invite/<token>?x=1`) and any URL lose their
 * query, fragment and opaque segments, then secrets and personal data go.
 */
export function redactSnapshotText(snapshot: string, secretValues: string[] = []): string {
  const links = snapshot.replace(/(\/url: )(\S+)/g, (_m, prefix: string, url: string) =>
    prefix + (url.startsWith("/") ? stripOpaqueSegments(url.split(/[?#]/)[0]) : stripQueryAndHash(url)),
  );
  return redactSnapshot(stripUrlsInText(maskSecretFieldValues(links, undefined, secretValues)));
}

/** Longest line kept in anything capture hands an agent (a snapshot line, an error line). */
export const LINE_CAP = 240;

/** Caps one line, marking the cut. */
export function capLine(line: string, cap = LINE_CAP): string {
  return line.length <= cap ? line : `${line.slice(0, cap - 1)}…`;
}

/**
 * One line of agent-facing text (an error message, a page error): first line only, URLs without
 * query strings or tokens, secrets and personal data redacted, length capped.
 */
export function redactLine(text: string, cap = LINE_CAP): string {
  const first = text.split("\n")[0] ?? text;
  return capLine(redactSnapshot(stripUrlsInText(first)), cap);
}

/** Longest `Received …` excerpt kept from a Playwright assertion error. */
export const RECEIVED_CAP = 120;

/**
 * A step's error message made safe to store (validation.json) and print: the first line, plus the
 * `Received string: …`/`Received: …` line of a Playwright assertion when there is one (it is what
 * the page actually showed, so it can hold typed values), each redacted and then capped. Drops
 * the call log and the rest of the message.
 */
export function redactErrorMessage(message: string, cap = LINE_CAP): string {
  const first = redactLine(message, cap);
  const received = message
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .find((l) => /^Received(?: string| value| array| object)?:/i.test(l));
  return received ? `${first} | ${redactLine(received, RECEIVED_CAP)}` : first;
}

/**
 * Redacts personal data and secret-shaped strings out of the aria snapshot before it reaches
 * failure.json — an accessibility snapshot includes live textbox values and table text, so a
 * step that fails mid-form (e.g. right after a `type` into an unmasked-by-name field, or a page
 * that happens to render a real token in a dev banner) must not ship that text into an
 * agent-facing file. Reuses the exact same patterns `qa/pii.ts`/`qa/secrets.ts` scan with (not a
 * parallel redaction vocabulary that could drift from what the QA pass actually flags) —
 * including `qa/pii.ts`'s own UUID/hex-id guard (`looksLikeIdOrHash`), so a database id or hash
 * that merely *looks* like a run of phone-shaped digits (bug: a UUID chunk like
 * "0491-5701-5612-..." was getting flattened to "[REDACTED PHONE]", hiding exactly the id a
 * failing step needed to debug) is left alone instead.
 */
export function redactSnapshot(text: string): string {
  // Secrets first: a secret pattern (e.g. an API key's trailing digit run) can overlap what the
  // phone-candidate scan would otherwise grab, and redacting the digits out from under it first
  // would leave a shortened, partially-redacted token that might no longer meet a pattern's own
  // length minimum — the full secret should always be matched and replaced as one unit.
  let result = text;
  for (const { pattern } of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED SECRET]");
  }
  result = result.replace(EMAIL_PATTERN, (match, domain: string) =>
    SAFE_EMAIL_DOMAINS.includes(domain.toLowerCase()) ? match : "[REDACTED EMAIL]",
  );
  // Before the phone scan, which would otherwise take a card number's digit groups for a phone.
  result = redactCardNumbers(result);
  result = result.replace(PHONE_CANDIDATE, (match: string, ...args: unknown[]) => {
    const digits = match.replace(/\D/g, "");
    if (digits.length < 7) return match;
    if (
      AU_MOBILE_FICTIONAL.test(match) ||
      AU_LANDLINE_FICTIONAL.test(match) ||
      US_FICTIONAL.test(match) ||
      UK_MOBILE_FICTIONAL.test(match)
    ) {
      return match;
    }
    // `String.replace`'s callback gets (match, ...groups, offset, fullString) — PHONE_CANDIDATE
    // has no capture groups, so the last two args are exactly those.
    const offset = args[args.length - 2] as number;
    const full = args[args.length - 1] as string;
    if (looksLikeIdOrHash(full, offset, match)) return match;
    return "[REDACTED PHONE]";
  });
  return result;
}
