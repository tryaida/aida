// Reader feedback entries (M47): "Was this helpful?" votes on guide pages and help-site searches
// that found nothing. Both work with no chat key, so they're the signal most sites will have
// (decision 25: chat stays off until the owner adds a key). This is end-user-typed text written
// to the owner's own disk or host log, so everything here is strict: a fixed set of fields per
// kind, small caps, and the same personal-data and secret redaction the rest of aida uses,
// applied before anything is stored or logged.
import { isOpaqueSegment, redactCardNumbers, stripUrlsInText } from "../capture/redact.js";
import { redactPii } from "../chat/unanswered.js";
import { SECRET_PATTERNS } from "../qa/secrets.js";
import { looksLikeId, routePatternFor } from "../routes/pattern.js";

export const FEEDBACK_KINDS = ["helpful", "not-helpful", "no-results"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/** The JSON body `POST /api/feedback` accepts (the help site's controls and the in-app widget
 * both post this exact shape). */
export interface FeedbackInput {
  kind: FeedbackKind;
  /** Help site path the reader was on (a guide, or the page they searched from). */
  page?: string;
  /** Search text that found nothing. */
  query?: string;
  /** App path the reader was on, when the in-app widget sends it. */
  currentPath?: string;
  /** "What were you looking for?" after a No vote. */
  comment?: string;
}

/** A stored entry: the redacted input plus the day it arrived. Never an IP address, cookie,
 * user id or user agent. */
export interface FeedbackEntry extends FeedbackInput {
  /** `YYYY-MM-DD` only: enough to see what's recent, too coarse to line an entry up with a
   * host's access log. */
  at: string;
}

/** Caps on what a reader can send. Over a cap is a 400, not a silent cut, so a client bug shows
 * up instead of filling the log with clipped text; the help site's own controls stay under them. */
export const FEEDBACK_LIMITS = {
  query: 120,
  comment: 300,
  path: 300,
  /** Whole request body, bytes. */
  body: 2048,
} as const;

type Field = "page" | "query" | "currentPath" | "comment";

/** Which fields each kind may carry. Anything else is refused, so the store never holds a field
 * nobody reviewed for personal data. */
const FIELDS: Record<FeedbackKind, { required: Field[]; optional: Field[] }> = {
  helpful: { required: ["page"], optional: ["currentPath"] },
  "not-helpful": { required: ["page"], optional: ["currentPath", "comment"] },
  "no-results": { required: ["query"], optional: ["page", "currentPath"] },
};

export type FeedbackValidation = { ok: true; input: FeedbackInput } | { ok: false; error: string };

// Text a reader typed ends up in front of the owner's coding agent (`aida suggest`), so anything
// that renders as nothing has to go: it can hide instructions from the person reading over the
// agent's shoulder (Unicode tag characters spell out ASCII invisibly), or split a word so the
// redaction below misses it ("pass<zero-width space>word: hunter2"). Format characters (`Cf`:
// zero-width, bidi overrides, soft hyphen, the tag block's letters), private-use, unassigned and
// lone-surrogate code points, variation selectors, the combining grapheme joiner and the Hangul
// and Khmer fillers are removed outright, so the word they split joins back up. Control characters
// and line or paragraph separators become a space, so the lines they separated stay apart.
// Browser copy: help-app components/site/feedback-client.ts (`searchKey`); keep the two in step.
const HIDDEN =
  /[\p{Cf}\p{Co}\p{Cn}\p{Cs}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u3164\ufe00-\ufe0f\uffa0\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
const BREAKS = /[\p{Cc}\p{Zl}\p{Zp}\u2800]/gu;
const HAS_HIDDEN = new RegExp(`${HIDDEN.source}|${BREAKS.source}`, "u");

/** Reader text with every invisible character gone and whitespace collapsed. NFKC first, so a
 * full-width or ligature form can't slip a keyword past the redaction or the search grouping. */
export function cleanReaderText(text: string): string {
  return text.normalize("NFKC").replace(HIDDEN, "").replace(BREAKS, " ").replace(/\s+/g, " ").trim();
}

/** True when `text` holds anything `cleanReaderText` would remove or turn into a space. */
export function hasHiddenCharacters(text: string): boolean {
  return HAS_HIDDEN.test(text);
}

/** A host with a dot and a top-level domain, then a path or query, typed without a scheme
 * (`app.example.com/reset?token=…`): `stripUrlsInText` only sees URLs with a scheme. */
const SCHEMELESS_URL_QUERY = /\b((?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s?#]*)?)[?#]\S*/gi;

/** Anything left that reads as a query string (`?token=…&x=…`) after the URL passes. */
const LOOSE_QUERY = /\?[^\s=?]*=\S*/g;

/** A word that names a secret: a password (or pass, passcode, pwd), a token, a secret, a PIN or
 * one-time code, or an API, access, auth, session, private or licence key, with or without a
 * prefix (`db_password`, `authtoken`, `x-api-key`). */
const KEY_WORD = String.raw`(?:[A-Za-z][A-Za-z0-9]*?[_-]?)?(?:pass(?:word|wd|code|phrase)?|pwd|secret|token|pin|otp|(?:api|access|auth|session|private|secret|license|licence)[ _-]?key)`;

/** `password: hunter2xx`, `token=abcdef12`, `x-api-key = "…"`: a key word, `:` or `=`, a value. */
const KEYED_SECRET = new RegExp(String.raw`\b(${KEY_WORD})\s*[:=]\s*["']?[^\s"']{3,}["']?`, "gi");

/** `password hunter2`, `my pin is 4821`: a key word, a space (and maybe "is"/"was"), then a value
 * with a digit or a symbol in it. Plain words after a key word ("password reset link") stay. */
const SPACED_SECRET = new RegExp(String.raw`\b(${KEY_WORD})\s+(?:(?:is|was)\s+)?["']?(?=[^\s"']*[\d!@#$%^&*+=~])[^\s"']{4,}["']?`, "gi");

/** A long run of letters and digits mixed (an unprefixed key, a session id, a reset code). No
 * real word is 24+ characters with a digit in it. */
const OPAQUE_TOKEN = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g;

/** A US social security number, dashed or spaced. */
const SSN = /\b\d{3}[- ]\d{2}[- ]\d{4}\b/g;

/** A card-shaped number that fails the Luhn check (an account or reference number, or a typo'd
 * card): 4-digit first group, then groups of 4-6 split by one repeated separator. Phone numbers,
 * the fictional ranges included, don't take this shape, so they're left for `redactPii`. */
const CARD_SHAPED = /(?<![\d])\d{4}([ .-])\d{4,6}\1\d{4,5}(?:\1\d{1,4})?(?![\d])/g;

/** Mixed letters and digits, 5+ characters, no separator: `a8Kx9Q` in `/i/a8Kx9Q`. Too short for
 * `looksLikeId` and `isOpaqueSegment`, long enough to be someone's share or reset link. */
const SHORT_TOKEN_SEGMENT = /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9]{5,}$/;
/** 16+ characters with no separator (`abcdefghijklmnop`): a code, not a screen name. */
const LONG_RUN_SEGMENT = /^[A-Za-z0-9]{16,}$/;

/** Secrets and personal data out of one piece of text, with no path handling (paths call it per
 * segment, so it mustn't call back into them). */
function redactPlain(text: string): string {
  let out = text;
  for (const { pattern } of SECRET_PATTERNS) out = out.replace(pattern, "[redacted-secret]");
  out = out
    .replace(KEYED_SECRET, "$1=[redacted-secret]")
    .replace(SPACED_SECRET, "$1 [redacted-secret]")
    .replace(OPAQUE_TOKEN, "[redacted-secret]");
  // Cards before the phone scan inside `redactPii`, which would otherwise take a card's digit
  // groups for a phone number and leave the last group showing.
  out = redactCardNumbers(out, "[redacted-card]").replace(SSN, "[redacted-number]");
  out = out.replace(CARD_SHAPED, "[redacted-number]");
  return redactPii(out);
}

/** One path segment as it may be stored or shown: `*` for anything that names a record or a
 * person rather than a screen (an id, a token, an email address, a phone number), the segment
 * otherwise. `;params` (`;jsessionid=…`) are dropped. */
function screenSegment(segment: string): string {
  const bare = segment.split(";")[0];
  if (!bare || bare === "*" || bare === "[token]" || bare === ":id") return bare;
  let decoded: string;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    return "*";
  }
  if (looksLikeId(decoded) || isOpaqueSegment(decoded)) return "*";
  if (SHORT_TOKEN_SEGMENT.test(decoded) || LONG_RUN_SEGMENT.test(decoded)) return "*";
  if (/[@\s]/.test(decoded) || hasHiddenCharacters(decoded) || redactPlain(decoded) !== decoded) return "*";
  return bare;
}

/** A path with every segment through `screenSegment`; query and fragment already gone. */
function screenPath(path: string): string {
  return path
    .split("/")
    .map((segment) => (segment ? screenSegment(segment) : segment))
    .join("/");
}

/** Trailing punctuation that ends a sentence, not a URL. */
const TRAILING = /[.,;:!?)\]}'"]+$/;

/** Every URL and path in a line of text with its segments through `screenSegment`:
 * `https://app.example.com/i/a8Kx9Q` keeps its host and loses the code. */
function screenPathsInText(text: string): string {
  return text.replace(/\S+/g, (word) => {
    const tail = TRAILING.exec(word)?.[0] ?? "";
    const body = tail ? word.slice(0, -tail.length) : word;
    let split = -1;
    const scheme = body.indexOf("://");
    if (scheme > 0) split = body.indexOf("/", scheme + 3);
    else if (/^["'(<[=]?\//.test(body)) split = body.indexOf("/");
    else if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\//i.test(body)) split = body.indexOf("/");
    if (split === -1) return word;
    return body.slice(0, split) + screenPath(body.slice(split)) + tail;
  });
}

/**
 * Redacts secrets and personal data out of reader-typed text, then caps it. URLs go first (query
 * strings and fragments with `stripUrlsInText`, the same redaction capture uses, then the
 * scheme-less forms it doesn't see, then each path segment), then secrets, so a key's digits
 * aren't half-eaten by the phone or digit-run checks and left partly visible. Emails, phone
 * numbers and long digit runs go through the chat's own `redactPii`, so the help chat and
 * feedback store the same shapes (example.com and the fictional phone ranges stay).
 */
export function redactFeedbackText(text: string, max: number): string {
  let out = stripUrlsInText(cleanReaderText(text)).replace(SCHEMELESS_URL_QUERY, "$1").replace(LOOSE_QUERY, "");
  out = redactPlain(screenPathsInText(out)).replace(/\s+/g, " ").trim();
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

/** A help-site or app path made safe to store, as a screen pattern: no query, fragment or
 * `;params`; record ids, tokens and anything personal as `*` (`routePatternFor`, the same
 * patterns the help map uses, plus `screenSegment`'s checks). Undefined for anything that isn't
 * a site-relative path. */
export function normaliseFeedbackPath(path: string): string | undefined {
  if (!path.startsWith("/") || path.startsWith("//") || /\s/.test(path) || hasHiddenCharacters(path)) return undefined;
  const bare = path.split(/[?#]/, 1)[0].split("/").map((segment) => segment.split(";")[0]).join("/");
  const normalised = screenPath(routePatternFor(bare));
  return normalised.length > FEEDBACK_LIMITS.path ? normalised.slice(0, FEEDBACK_LIMITS.path) : normalised;
}

/** The key searches are grouped by in `aida suggest`: case, punctuation and spacing don't make
 * two searches different. */
export function normaliseQuery(query: string): string {
  return cleanReaderText(query)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Checks a parsed request body against the entry contract. Error messages never repeat what was
 * sent (not even a field name), so nothing a reader typed is echoed back or into a log.
 */
export function validateFeedback(body: unknown): FeedbackValidation {
  if (!isPlainObject(body)) return { ok: false, error: "expected a JSON object" };
  const kind = body.kind;
  if (typeof kind !== "string" || !(FEEDBACK_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: "kind must be helpful, not-helpful or no-results" };
  }
  const spec = FIELDS[kind as FeedbackKind];
  const allowed = new Set<string>(["kind", ...spec.required, ...spec.optional]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return { ok: false, error: `unexpected field for ${kind}` };

  const input: FeedbackInput = { kind: kind as FeedbackKind };
  for (const field of [...spec.required, ...spec.optional]) {
    const value = body[field];
    if (value === undefined) {
      if (spec.required.includes(field)) return { ok: false, error: `${field} is required for ${kind}` };
      continue;
    }
    if (typeof value !== "string") return { ok: false, error: `${field} must be a string` };
    if (field === "page" || field === "currentPath") {
      if (value.length > FEEDBACK_LIMITS.path) return { ok: false, error: `${field} is too long` };
      const path = normaliseFeedbackPath(value);
      if (!path) return { ok: false, error: `${field} must be a path starting with /` };
      input[field] = path;
    } else {
      const max = FEEDBACK_LIMITS[field];
      if (value.length > max) return { ok: false, error: `${field} is longer than ${max} characters` };
      const text = redactFeedbackText(value, max);
      if (!text) {
        if (spec.required.includes(field)) return { ok: false, error: `${field} is required for ${kind}` };
        continue;
      }
      input[field] = text;
    }
  }
  return { ok: true, input };
}

/** Today's date as stored on an entry. */
export function feedbackDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The one shape every store writes and every reader returns: only the contract's fields, each
 * redacted and capped again. Stores call it on the way in and readers on the way out, so a
 * hand-edited JSONL file or a pasted host log can't bring an unredacted or extra field into
 * `aida suggest`. Undefined for anything that isn't an entry.
 */
export function sanitizeFeedbackEntry(raw: unknown): FeedbackEntry | undefined {
  if (!isPlainObject(raw)) return undefined;
  const kind = raw.kind;
  if (typeof kind !== "string" || !(FEEDBACK_KINDS as readonly string[]).includes(kind)) return undefined;
  const spec = FIELDS[kind as FeedbackKind];
  const at = typeof raw.at === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw.at) ? raw.at.slice(0, 10) : undefined;
  if (!at) return undefined;
  const entry: FeedbackEntry = { kind: kind as FeedbackKind, at };
  for (const field of [...spec.required, ...spec.optional]) {
    const value = raw[field];
    if (typeof value !== "string") continue;
    if (field === "page" || field === "currentPath") {
      const path = normaliseFeedbackPath(value);
      if (path) entry[field] = path;
    } else {
      const text = redactFeedbackText(value, FEEDBACK_LIMITS[field]);
      if (text) entry[field] = text;
    }
  }
  if (spec.required.some((field) => entry[field] === undefined)) return undefined;
  return entry;
}
