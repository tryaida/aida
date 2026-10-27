// Secret scan: common API key / token shapes, plus a generic high-entropy `KEY=value` catch-all.
// Per AGENTS.md: test logins and API keys must live in CI/host secrets, never in the repo or
// published output.
import { qaCheck, type QaCheckResult } from './types.js'

export interface SecretPattern {
  id: string
  label: string
  pattern: RegExp
}

export const SECRET_PATTERNS: SecretPattern[] = [
  { id: 'aws-access-key', label: 'AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'anthropic', label: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'openai', label: 'OpenAI API key', pattern: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { id: 'github-token', label: 'GitHub token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { id: 'github-pat', label: 'GitHub fine-grained token', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  // Supabase's secret key only: an `sb_publishable_` key is meant to ship in the browser.
  { id: 'supabase-secret', label: 'Supabase secret key', pattern: /\bsb_secret_[A-Za-z0-9_-]{16,}/g },
  { id: 'google-api-key', label: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  { id: 'slack-token', label: 'Slack token', pattern: /\bxox[abpr]-[A-Za-z0-9-]{10,}/g },
  { id: 'jwt', label: 'JWT-like token', pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { id: 'stripe-key', label: 'Stripe secret or restricted key', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g },
  { id: 'bearer', label: 'Bearer token', pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]{16,}=*/g },
  {
    id: 'basic-auth',
    label: 'Basic auth credentials',
    // `Authorization: Basic <anything>`, or `Basic <base64>` on its own when the base64 is
    // padded to a multiple of 4 and has a digit, `+`, `/` or `=` in it — so "Basic information"
    // or "Basic plan" in page text isn't flagged.
    pattern:
      /(?<=\bAuthorization:\s*Basic\s+)[A-Za-z0-9+/=._~-]{4,}|(?<=\bBasic\s+)(?=[A-Za-z0-9+/]*[0-9+/=])(?:[A-Za-z0-9+/]{4}){2,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?(?![A-Za-z0-9+/=])/g,
  },
  {
    id: 'cookie',
    label: 'Cookie header value',
    // The value of a `Cookie:`/`Set-Cookie:` header line (`name=value; ...`), not the word "cookie".
    pattern: /(?<=\b(?:set-)?cookie:[ \t]*)[^\s=;,]+=[^\r\n]*/gi,
  },
  {
    id: 'password-assignment',
    label: 'password assignment',
    // `password=…`, `DB_PASSWORD=…` (any case). Placeholders (`***`, `<password>`, `${PW}`,
    // `$PW`, `[REDACTED…]`) aren't flagged.
    pattern: /(?<=\b(?:[A-Za-z0-9]+_)*(?:password|passwd|pwd)\s*=\s*["']?)(?!\*{3}|<|\$|\[REDACTED)[^\s"'&;,)]{3,}/gi,
  },
  {
    id: 'password-field',
    label: 'password assignment',
    // `DB_PASSWORD: …` (YAML/env style): an upper-case name only, so "Password: at least 8
    // characters" in page text isn't flagged.
    pattern: /(?<=\b(?:[A-Z0-9]+_)*(?:PASSWORD|PASSWD)\s*:\s*["']?)(?!\*{3}|<|\$|\[REDACTED)[^\s"'&;,)]{3,}/g,
  },
  {
    id: 'connection-password',
    label: 'password in a connection string',
    // Only the password of `scheme://user:password@host`, so a redacted URL keeps its host.
    // Placeholders (`****`, `<password>`, `${PW}`, `[REDACTED...]`) aren't flagged.
    pattern: /(?<=\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)(?!\*+@|<[^>\s]*>@|\$\{[^}\s]*\}@|\[REDACTED)[^\s@/]+(?=@)/gi,
  },
]

/** `NAME=value` or `NAME: "value"` assignments where NAME looks like a secret/key/token. */
const GENERIC_ASSIGNMENT = /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*["']?([A-Za-z0-9_\-/+.]{12,})["']?/g

export interface SecretScanOptions {
  /** Exact matched strings or substrings to ignore (e.g. known placeholders). */
  allowlist?: string[]
  /** Minimum Shannon entropy (bits/char) for the generic assignment check to flag a value. Default 3.5. */
  minEntropy?: number
}

function shannonEntropy(value: string): number {
  if (!value) return 0
  const counts = new Map<string, number>()
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let entropy = 0
  for (const count of counts.values()) {
    const p = count / value.length
    entropy -= p * Math.log2(p)
  }
  return entropy
}

function isAllowlisted(value: string, allowlist: string[]): boolean {
  return allowlist.some((a) => value.includes(a))
}

/** Scans one piece of text for secret-shaped strings. Returns short problem strings, one per hit. */
export function scanSecrets(text: string, opts: SecretScanOptions = {}): string[] {
  const allowlist = opts.allowlist ?? []
  const minEntropy = opts.minEntropy ?? 3.5
  const problems: string[] = []
  const seen = new Set<string>()
  const seenValues = new Set<string>()

  for (const { label, pattern } of SECRET_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0]
      if (seen.has(value) || isAllowlisted(value, allowlist)) continue
      seen.add(value)
      seenValues.add(value)
      problems.push(`${label}: ${redact(value)}`)
    }
  }

  for (const match of text.matchAll(GENERIC_ASSIGNMENT)) {
    const [full, name, value] = match
    if (seen.has(full) || isAllowlisted(full, allowlist) || isAllowlisted(value, allowlist)) continue
    // Already reported by a specific pattern above (e.g. `KEY=sk-ant-...`) — don't double count.
    if ([...seenValues].some((v) => v.includes(value) || value.includes(v))) continue
    const entropy = shannonEntropy(value)
    if (entropy < minEntropy) continue
    seen.add(full)
    problems.push(`high-entropy assignment ${name}=${redact(value)} (entropy ${entropy.toFixed(1)} bits/char)`)
  }

  return problems
}

function redact(value: string): string {
  if (value.length <= 8) return '***'
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}

/** Runs the secret scan over one text blob, returning a single check. */
export function checkSecrets(text: string, opts: SecretScanOptions = {}): QaCheckResult {
  const problems = scanSecrets(text, opts)
  return qaCheck('secrets:scan', problems.length === 0, problems.length ? `${problems.length} finding(s)` : 'no findings', problems)
}
