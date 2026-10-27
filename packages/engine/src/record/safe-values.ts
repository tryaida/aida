// Typed values in a recording become the walkthrough's demo data, so they follow the same rule
// as all demo data (AGENTS.md "Safe by default"): emails on example.com, phone numbers in the
// reserved fictional ranges, no real card numbers. A value outside those is swapped, and the
// command says so. qa/pii.ts decides what counts as unsafe, so a swapped value passes `aida qa`.
import { scanEmails, scanPhones, EMAIL_PATTERN, PHONE_CANDIDATE } from "../qa/pii.js";
import { redactCardNumbers } from "../capture/redact.js";

/** A fictional phone number in the style of the capture locale. */
export function fictionalPhone(locale = "en-AU"): string {
  if (/-(US|CA)$/i.test(locale)) return "555-0100";
  if (/-GB$/i.test(locale)) return "07700 900123";
  return "0491 570 156";
}

const TEST_CARD = "4242 4242 4242 4242";

export interface SafeValue {
  value: string;
  /** What was swapped: "email", "phone number", "card number". */
  swapped: string[];
}

export function safeValue(text: string, locale?: string): SafeValue {
  const swapped: string[] = [];
  let value = text;

  if (scanEmails(value).length > 0) {
    let n = 0;
    value = value.replace(EMAIL_PATTERN, (match) => {
      if (scanEmails(match).length === 0) return match;
      n++;
      return n === 1 ? "person@example.com" : `person${n}@example.com`;
    });
    swapped.push("email");
  }

  const carded = redactCardNumbers(value, TEST_CARD);
  if (carded !== value) {
    value = carded;
    swapped.push("card number");
  }

  // The test card's digits look like a phone number too: keep them out of the phone scan.
  const held = value.split(TEST_CARD);
  if (held.some((part) => scanPhones(part).length > 0)) {
    value = held
      .map((part) => {
        const unsafe = new Set(scanPhones(part).map((p) => p.replace(/^[^:]*:\s*/, "")));
        return part.replace(PHONE_CANDIDATE, (match) => (unsafe.has(match) ? fictionalPhone(locale) : match));
      })
      .join(TEST_CARD);
    swapped.push("phone number");
  }

  return { value, swapped };
}
