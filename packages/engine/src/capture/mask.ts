/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { Page } from "playwright";
import type { Target } from "../walkthrough/index.js";
import { locateAll } from "./locate.js";
import {
  type PiiScanOptions,
  AU_MOBILE_FICTIONAL,
  AU_LANDLINE_FICTIONAL,
  US_FICTIONAL,
  UK_MOBILE_FICTIONAL,
  PHONE_CANDIDATE,
  EMAIL_PATTERN,
  SAFE_EMAIL_DOMAINS,
} from "../qa/pii.js";
import { profileAsync } from "./profile.js";

const MASK_ATTR = "data-aida-masked";

/** `{source, flags}` so a RegExp can cross the page.evaluate() boundary and be rebuilt in-browser. */
interface RegexSource {
  source: string;
  flags: string;
}

function toRegexSource(re: RegExp): RegexSource {
  return { source: re.source, flags: re.flags };
}

/**
 * The same regex objects `qa/pii.ts` scans with, lifted into page.evaluate() once per call so the
 * personal-data scan (M11, docs/build-plan.md: "run the PII text scan... in a single
 * page.evaluate with precompiled regex sources") never round-trips node text back to Node just to
 * run a regex against it — see `scanInBrowser` below, which mirrors `scanEmails`/`scanPhones`.
 */
function personalDataRegexSources() {
  return {
    auMobile: toRegexSource(AU_MOBILE_FICTIONAL),
    auLandline: toRegexSource(AU_LANDLINE_FICTIONAL),
    usFictional: toRegexSource(US_FICTIONAL),
    ukMobile: toRegexSource(UK_MOBILE_FICTIONAL),
    phoneCandidate: toRegexSource(PHONE_CANDIDATE),
    emailPattern: toRegexSource(EMAIL_PATTERN),
  };
}

export interface MaskOptions extends PiiScanOptions {
  /**
   * Default-on page-level masking: scan every visible leaf text node for personal data (emails,
   * phone numbers) not on aida's safe fake-data domains/ranges, and blur the elements that
   * match — independent of whatever a step's own `mask` field list says, so a list/table of
   * real-looking data is never shown unmasked just because a walkthrough step forgot to name the
   * field. Set `false` (config `mask.personalData`) to disable.
   */
  personalData?: boolean;
  /** Extra CSS selectors always blurred, regardless of scanning (config `mask.selectors`). */
  selectors?: string[];
}

/**
 * Resolves a step's `mask` field names (e.g. "Email", "Phone") to targets.
 * Field names are matched as form labels — the vocabulary walkthroughs
 * already use for `label` targets.
 */
export function maskTargets(mask: string[] | undefined): Target[] {
  return (mask ?? []).map((label) => ({ label }));
}

/** Applies a CSS blur to every mask target that currently exists, before a screenshot. */
export async function applyMasks(page: Page, mask: string[] | undefined, opts: MaskOptions = {}): Promise<void> {
  for (const target of maskTargets(mask)) {
    const loc = await locateAll(target, page);
    const count = await loc.count().catch(() => 0);
    if (count === 0) continue;
    // `locate()` narrows to `.first()`; walk every match, not just the first,
    // so a repeated field (e.g. a list row rendered per-item) is fully masked.
    // A failure here must fail the step (never fail open and ship an unmasked
    // screenshot) — see AGENTS.md "safe by default".
    try {
      const locators = await loc.all();
      await Promise.all(
        locators.map((l) =>
          l.evaluate((el) => {
            el.setAttribute("data-aida-masked", "1");
            (el as HTMLElement).style.filter = "blur(8px)";
          }),
        ),
      );
    } catch (err) {
      throw new Error(`masking failed: ${(err as Error).message}`);
    }
  }

  for (const selector of opts.selectors ?? []) {
    try {
      await page.locator(selector).evaluateAll((els) => {
        for (const el of els) {
          el.setAttribute("data-aida-masked", "1");
          (el as HTMLElement).style.filter = "blur(8px)";
        }
      });
    } catch (err) {
      throw new Error(`masking failed: selector ${JSON.stringify(selector)}: ${(err as Error).message}`);
    }
  }

  if (opts.personalData !== false) {
    await applyPersonalDataMask(page, opts);
  }
}

/**
 * Page-level default masking (see `MaskOptions.personalData`). Walks every visible leaf text
 * node, scans it for personal data (mirroring `qa/pii.ts`'s scanners — example.com/.org/.net/.edu
 * emails and the reserved fictional phone ranges, e.g. a demo database's seed data, stay unmasked), and
 * blurs only the elements that still contain a real-looking email or phone number.
 *
 * M11 (docs/build-plan.md, "capture speed"): this used to be two page.evaluate() round-trips per
 * screenshot (collect text into Node, scan+decide in Node, apply back in a page.evaluate()) PLUS
 * a full DOM walk every single time, even when nothing on the page had changed since the last
 * screenshot. Now it's one round trip, entirely in-browser (regex sources passed in once — see
 * `personalDataRegexSources`), and the DOM walk+scan itself only runs again when a MutationObserver
 * installed on first use has actually seen the DOM change; otherwise the same flagged elements
 * from last time are just re-blurred (still required every screenshot — `clearMasks` strips the
 * blur after each shot, so observing `attributes` would otherwise false-positive dirty on every
 * single screenshot — the callback explicitly ignores `style`/`data-aida-masked` attribute
 * mutations so only the app's *own* attribute changes (e.g. a `hidden`/`aria-hidden`/`class`
 * toggle that reveals previously-invisible content) mark the cache dirty. Typing into a field
 * doesn't mutate the DOM at all (no new node, no attribute, no characterData change) — an `input`/
 * `change` listener covers that case directly.
 *
 * A masking failure here must fail the step rather than silently ship an unmasked screenshot — see
 * AGENTS.md "safe by default" — so this never swallows a `page.evaluate()` rejection.
 */
export async function applyPersonalDataMask(page: Page, opts: PiiScanOptions = {}): Promise<void> {
  try {
    await profileAsync("masking", () =>
      page.evaluate(
        (args: {
          maskAttr: string;
          regex: ReturnType<typeof personalDataRegexSources>;
          safeEmailDomains: string[];
          allowlistEmails: string[];
          allowlistPhones: string[];
          minPhoneDigits: number;
        }) => {
          const w = window as unknown as {
            __aidaPersonalMaskState?: { dirty: boolean; flagged: Element[]; observedBody: Element };
          };
          // `document.body` identity, not just "state exists", because `document.open()`/
          // `document.write()` (what Playwright's `page.setContent()` uses, and what a test
          // fixture reusing one page across setContent() calls relies on) replaces the body
          // element in place without tearing down `window` — so a stale cached state would
          // otherwise survive a full content swap and never rescan the new DOM. A real
          // navigation (page.goto) always gets a fresh `window` regardless, so this only ever
          // adds a cheap identity check to the common (nothing changed) case.
          if (!w.__aidaPersonalMaskState || w.__aidaPersonalMaskState.observedBody !== document.body) {
            const state = { dirty: true, flagged: [] as Element[], observedBody: document.body };
            w.__aidaPersonalMaskState = state;
            new MutationObserver((mutations) => {
              for (const m of mutations) {
                if (m.type === "attributes" && (m.attributeName === "style" || m.attributeName === args.maskAttr)) {
                  continue;
                }
                state.dirty = true;
                return;
              }
            }).observe(document.body, {
              childList: true,
              subtree: true,
              characterData: true,
              attributes: true,
              attributeOldValue: false,
            });
            // Typing into a field (controlled or uncontrolled) changes `.value` without any DOM
            // mutation at all — only `input`/`change` events see it.
            const markDirty = (): void => {
              state.dirty = true;
            };
            document.body.addEventListener("input", markDirty, { capture: true });
            document.body.addEventListener("change", markDirty, { capture: true });
          }
          const state = w.__aidaPersonalMaskState;

          const reBuild = (r: { source: string; flags: string }): RegExp => new RegExp(r.source, r.flags);
          const applyBlur = (els: Element[]): void => {
            for (const el of els) {
              if (!el.isConnected) continue;
              el.setAttribute("data-aida-masked", "1");
              (el as HTMLElement).style.filter = "blur(8px)";
            }
          };

          if (!state.dirty) {
            applyBlur(state.flagged);
            return;
          }

          const auMobile = reBuild(args.regex.auMobile);
          const auLandline = reBuild(args.regex.auLandline);
          const usFictional = reBuild(args.regex.usFictional);
          const ukMobile = reBuild(args.regex.ukMobile);
          const phoneCandidate = reBuild(args.regex.phoneCandidate);
          const emailPattern = reBuild(args.regex.emailPattern);
          const isFictionalPhone = (candidate: string): boolean =>
            auMobile.test(candidate) ||
            auLandline.test(candidate) ||
            usFictional.test(candidate) ||
            ukMobile.test(candidate);
          const allowlistEmails = new Set(args.allowlistEmails.map((e) => e.toLowerCase()));
          const hasRealEmail = (text: string): boolean => {
            for (const match of text.matchAll(emailPattern)) {
              const full = match[0].toLowerCase();
              const domain = match[1].toLowerCase();
              if (args.safeEmailDomains.includes(domain)) continue;
              if (allowlistEmails.has(full) || allowlistEmails.has(domain)) continue;
              return true;
            }
            return false;
          };
          const hasRealPhone = (text: string): boolean => {
            const seen = new Set<string>();
            for (const match of text.matchAll(phoneCandidate)) {
              const candidate = match[0];
              const digits = candidate.replace(/\D/g, "");
              if (digits.length < args.minPhoneDigits) continue;
              if (seen.has(candidate)) continue;
              seen.add(candidate);
              if (isFictionalPhone(candidate)) continue;
              if (args.allowlistPhones.some((a) => candidate.includes(a) || digits.includes(a.replace(/\D/g, "")))) continue;
              return true;
            }
            return false;
          };

          const isHiddenElement = (el: Element): boolean => {
            const style = getComputedStyle(el);
            if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return true;
            const rect = el.getBoundingClientRect();
            return rect.width === 0 || rect.height === 0;
          };

          const flagged: Element[] = [];
          const flaggedSet = new Set<Element>();
          const flag = (el: Element, text: string): void => {
            if (!text || flaggedSet.has(el)) return;
            if (isHiddenElement(el)) return;
            if (hasRealEmail(text) || hasRealPhone(text)) {
              flaggedSet.add(el);
              flagged.push(el);
            }
          };

          // Scan every text node (not just childless leaf elements), so mixed content like
          // `<td>Call <b>Jo</b> on 0412 345 678</td>` is caught — the nearest *element* parent of
          // the text node (not the text node itself, which can't be styled) is what gets blurred.
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
            acceptNode(node: Node): number {
              const parent = (node as Text).parentElement;
              if (!parent) return NodeFilter.FILTER_REJECT;
              const tag = parent.tagName;
              if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
              return NodeFilter.FILTER_ACCEPT;
            },
          });
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const parent = (node as Text).parentElement;
            if (!parent) continue;
            flag(parent, (node.textContent ?? "").trim());
          }

          // Live form state never shows up as a text node — `value` isn't reflected into the DOM.
          for (const el of document.body.querySelectorAll("input, textarea")) {
            flag(el, (el as HTMLInputElement | HTMLTextAreaElement).value ?? "");
          }
          for (const el of document.body.querySelectorAll("select")) {
            const selected = (el as HTMLSelectElement).selectedOptions[0];
            flag(el, (selected?.textContent ?? "").trim());
          }

          state.flagged = flagged;
          state.dirty = false;
          applyBlur(flagged);
        },
        {
          maskAttr: MASK_ATTR,
          regex: personalDataRegexSources(),
          safeEmailDomains: SAFE_EMAIL_DOMAINS,
          allowlistEmails: opts.allowlistEmails ?? [],
          allowlistPhones: opts.allowlistPhones ?? [],
          minPhoneDigits: opts.minPhoneDigits ?? 7,
        },
      ),
    );
  } catch (err) {
    throw new Error(`masking failed: ${(err as Error).message}`);
  }
}

/** Removes masking left by `applyMasks`, after the screenshot. */
export async function clearMasks(page: Page): Promise<void> {
  await page
    .evaluate((attr) => {
      for (const el of document.querySelectorAll(`[${attr}]`)) {
        (el as HTMLElement).style.filter = "";
        el.removeAttribute(attr);
      }
    }, MASK_ATTR)
    .catch(() => {});
}
