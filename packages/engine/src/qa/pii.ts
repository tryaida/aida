// Personal-data scan: flags emails and phone numbers in text that aren't on aida's safe-by-
// default fake-data domains/ranges (see AGENTS.md ground rules and docs/scope.md "Safety and
// trust"). Scans plain text; callers decide which files to feed it (md, srt, vtt, json, html).
import { qaCheck, type QaCheckResult } from './types.js'

/** Email domains treated as fake/safe by convention (IANA reserved for documentation/testing). */
export const SAFE_EMAIL_DOMAINS = ['example.com', 'example.org', 'example.net', 'example.edu']

/**
 * Phone-number ranges reserved by regulators for fictional/drama use, so they're safe to publish.
 *
 * - Australia (ACMA): mobile block 0491 570 xxx–0491 579 xxx (0491 57 prefix; ACMA publishes 30
 *   specific numbers within this block, but any number sharing the 0491 57 prefix is being used
 *   as a fictional number, not a real subscriber's). Landline: (0X) 5550 xxxx and (0X) 7010 xxxx
 *   for X in {2,3,7,8} (state area codes), per ACMA's fictitious-number list.
 * - US/Canada (NANP): 555-0100 through 555-0199 in any area code, reserved for fictional use.
 * - UK (Ofcom): 07700 900000–07700 900999, the drama/fiction mobile range Ofcom reserves for
 *   this exact purpose (see Ofcom's "numbers for drama use" allocation).
 *
 * `references/safety.md` lists these same ranges for authors — keep the two in sync; don't widen
 * either past what the other actually allows (a prior version of safety.md advertised a broad
 * "04xx xxx xxx" as fictional, which this file never allowed).
 */
// Exported (not just module-local) so capture/mask.ts can lift the exact same regex sources into
// a page.evaluate() for in-browser scanning (see applyPersonalDataMask) without duplicating the
// patterns — keep any edit here in sync with that one source of truth.
export const AU_MOBILE_FICTIONAL = /(?:\b0491|\+?61[\s-]?4[\s-]?91)[\s-]?57\d[\s-]?\d{3}\b/
export const AU_LANDLINE_FICTIONAL = /\(?0[2378]\)?[\s-]?(5550|7010)[\s-]?\d{4}\b/
export const US_FICTIONAL = /\b(?:\(\d{3}\)\s?|\d{3}[\s.-])?555[\s.-]01\d{2}\b/
export const UK_MOBILE_FICTIONAL = /(?:\b0|\+?44[\s-]?)7700[\s-]?900[\s-]?\d{3}\b/

export const PHONE_CANDIDATE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/g
export const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g

export interface PiiScanOptions {
  /** Extra email addresses or domains to ignore (exact match or domain suffix). */
  allowlistEmails?: string[]
  /** Extra phone number substrings/patterns (as plain digit sequences) to ignore. */
  allowlistPhones?: string[]
  /** Minimum run of digits to consider a phone-number candidate at all. Default 7. */
  minPhoneDigits?: number
}

function isFictionalPhone(candidate: string): boolean {
  return (
    AU_MOBILE_FICTIONAL.test(candidate) ||
    AU_LANDLINE_FICTIONAL.test(candidate) ||
    US_FICTIONAL.test(candidate) ||
    UK_MOBILE_FICTIONAL.test(candidate)
  )
}

/** A UUID (any version/variant, case-insensitive). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Characters that plausibly extend a phone-candidate match into the id/hash it's actually part
 * of, when scanning engine bookkeeping that slipped into a QA target (content-hash caches,
 * capture manifests): hex digits and the hyphens a UUID or a hash-with-separators would use. */
const ID_TOKEN_CHAR = /[0-9a-fA-F-]/

/** Expands a regex match's span outward over `ID_TOKEN_CHAR` characters, to recover the full
 * token (e.g. a UUID or hex hash) a phone-shaped digit run might be a fragment of. */
function widerToken(text: string, index: number, length: number): string {
  let start = index
  let end = index + length
  while (start > 0 && ID_TOKEN_CHAR.test(text[start - 1])) start--
  while (end < text.length && ID_TOKEN_CHAR.test(text[end])) end++
  return text.slice(start, end)
}

/** True for a candidate that's really an id/hash, not a phone number:
 * - a pure, unformatted run of 13+ digits (no spaces/dashes/dots/parens) — a millisecond epoch
 *   timestamp or a database/generated id, never a phone number written as one in prose.
 * - a UUID, or a hex id/hash fragment of 12+ characters that includes at least one letter
 *   (a-f) — a sha/git-style hash or similar, not a phone number.
 */
// Exported so other PII-adjacent redaction passes that reuse this file's phone-candidate
// matching (capture/failure-report.ts, inspect/redact.ts) can skip the same UUIDs/hex ids this
// scan already skips, instead of redacting them into a less useful "[REDACTED PHONE]" and hiding
// the actual cause of a failure. Read-only reuse — no behaviour here changes for QA itself.
export function looksLikeIdOrHash(text: string, index: number, candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '')
  const isUnformatted = /^\d+$/.test(candidate)
  if (isUnformatted && digits.length >= 13) return true

  const token = widerToken(text, index, candidate.length)
  if (UUID_PATTERN.test(token)) return true
  if (token.length >= 12 && /^[0-9a-f]+$/i.test(token) && /[a-f]/i.test(token)) return true

  return false
}

/** Scans one piece of text for emails outside the safe fake-data domains. */
export function scanEmails(text: string, opts: PiiScanOptions = {}): string[] {
  const allowlist = new Set((opts.allowlistEmails ?? []).map((e) => e.toLowerCase()))
  const problems: string[] = []
  for (const match of text.matchAll(EMAIL_PATTERN)) {
    const full = match[0].toLowerCase()
    const domain = match[1].toLowerCase()
    if (SAFE_EMAIL_DOMAINS.includes(domain)) continue
    if (allowlist.has(full) || allowlist.has(domain)) continue
    problems.push(`email not on a safe fake-data domain: ${match[0]}`)
  }
  return problems
}

/** Scans one piece of text for phone numbers outside the reserved fictional ranges. */
export function scanPhones(text: string, opts: PiiScanOptions = {}): string[] {
  const minDigits = opts.minPhoneDigits ?? 7
  const allowlist = opts.allowlistPhones ?? []
  const problems: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(PHONE_CANDIDATE)) {
    const candidate = match[0]
    const digits = candidate.replace(/\D/g, '')
    if (digits.length < minDigits) continue
    if (seen.has(candidate)) continue
    seen.add(candidate)
    if (isFictionalPhone(candidate)) continue
    if (looksLikeIdOrHash(text, match.index ?? 0, candidate)) continue
    if (allowlist.some((a) => candidate.includes(a) || digits.includes(a.replace(/\D/g, '')))) continue
    problems.push(`phone number not in a reserved fictional range: ${candidate}`)
  }
  return problems
}

/** Runs the personal-data scan over one text blob, returning a single check. */
export function checkPersonalData(text: string, opts: PiiScanOptions = {}): QaCheckResult {
  const problems = [...scanEmails(text, opts), ...scanPhones(text, opts)]
  return qaCheck('personal-data:scan', problems.length === 0, problems.length ? `${problems.length} finding(s)` : 'no findings', problems)
}
