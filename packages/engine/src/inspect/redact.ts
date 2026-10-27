// `aida inspect` prints real page text (accessible names, option labels) straight from a
// signed-in demo session, so it has to go through the same personal-data net as everything else
// aida publishes (AGENTS.md "Safe by default"). Reuses the exact regexes qa/pii.ts already
// validates (example.com-style domains and the reserved fictional phone ranges stay visible;
// everything else is blanked), rather than re-deriving the patterns.
import {
  AU_LANDLINE_FICTIONAL,
  AU_MOBILE_FICTIONAL,
  EMAIL_PATTERN,
  PHONE_CANDIDATE,
  SAFE_EMAIL_DOMAINS,
  UK_MOBILE_FICTIONAL,
  US_FICTIONAL,
  looksLikeIdOrHash,
} from "../qa/pii.js";

import { SECRET_PATTERNS } from "../qa/secrets.js";
import { maskSecretFieldValues, stripUrlsInText } from "../capture/redact.js";

/** What inspect prints in place of anything redacted. */
export const REDACTED = "[redacted]";
const PLACEHOLDER = REDACTED;

function isFictionalPhone(candidate: string): boolean {
  return (
    AU_MOBILE_FICTIONAL.test(candidate) ||
    AU_LANDLINE_FICTIONAL.test(candidate) ||
    US_FICTIONAL.test(candidate) ||
    UK_MOBILE_FICTIONAL.test(candidate)
  );
}

/** Replaces any email outside the safe fake-data domains, and any phone number outside the
 * reserved fictional ranges, with `[redacted]`. Leaves a UUID or hex id/hash alone (via
 * `qa/pii.ts`'s `looksLikeIdOrHash`, the same guard the QA pass itself uses) rather than
 * flattening it to `[redacted]` — an inspect snapshot's whole point is showing an author real
 * page content, and a redacted id is useless for writing a `target:` against it. */
export function redactPiiText(text: string): string {
  // The same field/card masking capture's failure report uses (one shared function), then
  // secret-shaped strings and URL queries/tokens, then personal data.
  let out = stripUrlsInText(maskSecretFieldValues(text, PLACEHOLDER));
  for (const { pattern } of SECRET_PATTERNS) out = out.replace(pattern, PLACEHOLDER);
  out = out.replace(EMAIL_PATTERN, (full, domain: string) =>
    SAFE_EMAIL_DOMAINS.includes(String(domain).toLowerCase()) ? full : PLACEHOLDER,
  );
  out = out.replace(PHONE_CANDIDATE, (candidate: string, ...args: unknown[]) => {
    const digits = candidate.replace(/\D/g, "");
    if (digits.length < 7) return candidate;
    if (isFictionalPhone(candidate)) return candidate;
    const offset = args[args.length - 2] as number;
    const full = args[args.length - 1] as string;
    if (looksLikeIdOrHash(full, offset, candidate)) return candidate;
    return PLACEHOLDER;
  });
  return out;
}
