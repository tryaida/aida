import { z } from "zod";
import { TargetSchema, HighlightSchema, type Target, type Highlight } from "./target.js";
import { keyProblem, normaliseKey } from "./keys.js";
import { textPatternProblem } from "./text-pattern.js";

/**
 * One captured interaction. The vocabulary is the original pipeline's: click, type, point,
 * expect, waitFor, waitForUrl, scrollTo, plus `goto` (a plain-words addition
 * for `go to /path` navigation, which workflow.json never needed explicitly), and the keyboard
 * and pointer actions `press`, `hover` and `focus` (M38).
 */
export type Action =
  | { do: "click"; target: Target; highlight?: Highlight }
  | { do: "type"; target: Target; text: string }
  /**
   * Drives a dropdown: a native `<select>` via Playwright's `selectOption`
   * (by option label, falling back to value), or — for a custom combobox
   * that isn't a native `<select>` — the same open-then-click-option
   * behaviour explicit `click`/`click` pairs already perform.
   */
  | { do: "select"; target: Target; option: string; highlight?: Highlight }
  | { do: "point"; target: Target; highlight?: Highlight }
  /**
   * Proves `target` is on screen. With `text`, its text must also contain `text` (Playwright's
   * `toContainText`), or with `exact: true` equal it (`toHaveText`: whole text, whitespace
   * collapsed and trimmed). A `"/pattern/"` (or `"/pattern/i"`) `text` is a regular expression:
   * searched for, or with `exact` matched against the whole text.
   */
  | { do: "expect"; target: Target; text?: string; exact?: boolean; highlight?: Highlight }
  /**
   * Presses a key or chord (Playwright key names: "Enter", "Escape", "Tab", "ArrowDown",
   * "Control+K", "ControlOrMeta+K"). With `target`, the element is focused first and the key goes
   * to it; without, it goes to whatever has focus on the page.
   */
  | { do: "press"; key: string; target?: Target; highlight?: Highlight }
  /** Moves the pointer over `target` without clicking: menus and tooltips that open on hover. */
  | { do: "hover"; target: Target; highlight?: Highlight }
  /** Puts keyboard focus on `target` without clicking it. */
  | { do: "focus"; target: Target; highlight?: Highlight }
  | { do: "waitFor"; target: Target; snapshot?: boolean | string; highlight?: Highlight }
  | { do: "waitForUrl"; pattern: string }
  | { do: "scrollTo"; target: Target }
  | { do: "goto"; path: string }
  /**
   * Shows an email on screen, drawn as a mail client over the app, until the next action. Either
   * one the app sent during this capture, caught by the local mail catcher (config `mail.port`)
   * and matched by `to` and/or `subject` (text it contains, or a `"/pattern/"`), or an emulated
   * one written out in `mock`, for mail capture can't receive. `remember` reads values out of
   * the email for later actions: `{ code: "/(\\d{6})/" }` makes `{{inbox.code}}` (the first
   * group, else the whole match) usable in a later `type` text or `goto` path.
   */
  | { do: "showEmail"; to?: string; subject?: string; mock?: MockEmail; highlight?: boolean; remember?: Record<string, string> };

/** An emulated email for `showEmail`: written in the walkthrough, never sent. */
export interface MockEmail {
  from: string;
  to: string;
  subject: string;
  /** Plain text body; blank lines separate paragraphs. */
  text?: string;
  /** HTML body, drawn in a sandbox (no scripts). */
  html?: string;
}

const base = { target: TargetSchema, highlight: HighlightSchema.optional() };

export const ActionSchema: z.ZodType<Action> = z.discriminatedUnion("do", [
  z.object({ do: z.literal("click"), ...base }).strict(),
  z.object({ do: z.literal("type"), target: TargetSchema, text: z.string() }).strict(),
  z.object({ do: z.literal("select"), target: TargetSchema, option: z.string(), highlight: HighlightSchema.optional() }).strict(),
  z.object({ do: z.literal("point"), ...base }).strict(),
  z
    .object({
      do: z.literal("expect"),
      ...base,
      text: z
        .string()
        .min(1)
        .optional()
        .describe('The target\'s text must contain this; with exact: true it must equal it. "/pattern/" (or "/pattern/i" to ignore case) is a regular expression.'),
      exact: z
        .boolean()
        .optional()
        .describe("With text: the target's whole text must equal text (whitespace collapsed), not just contain it."),
    })
    .strict(),
  z
    .object({
      do: z.literal("press"),
      key: z
        .string()
        // Written any case ("enter", "ctrl+k"); stored the way Playwright names it, and checked
        // here so a typo fails at validate rather than mid-capture.
        .transform((k, ctx) => {
          const key = normaliseKey(k);
          const problem = keyProblem(key);
          if (problem) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
            return z.NEVER;
          }
          return key;
        })
        .describe('A key or chord, in Playwright key names: "Enter", "Escape", "Tab", "ArrowDown", "Control+K", "ControlOrMeta+K".'),
      target: TargetSchema.optional().describe("Focus this element first and press the key in it; without it, the key goes to whatever has focus."),
      highlight: HighlightSchema.optional(),
    })
    .strict(),
  z.object({ do: z.literal("hover"), ...base }).strict().describe("Moves the pointer over the target without clicking."),
  z.object({ do: z.literal("focus"), ...base }).strict().describe("Puts keyboard focus on the target without clicking it."),
  z
    .object({
      do: z.literal("waitFor"),
      target: TargetSchema,
      snapshot: z.union([z.boolean(), z.string()]).optional(),
      highlight: HighlightSchema.optional(),
    })
    .strict(),
  z.object({ do: z.literal("waitForUrl"), pattern: z.string() }).strict(),
  z.object({ do: z.literal("scrollTo"), target: TargetSchema }).strict(),
  z.object({ do: z.literal("goto"), path: z.string() }).strict(),
  z
    .object({
      do: z.literal("showEmail"),
      to: z.string().optional(),
      subject: z.string().optional(),
      mock: z
        .object({ from: z.string(), to: z.string(), subject: z.string(), text: z.string().optional(), html: z.string().optional() })
        .strict()
        .optional(),
      highlight: z.boolean().optional(),
      remember: z.record(z.string().regex(/^\w+$/, "a remember key is letters, digits and _"), z.string()).optional(),
    })
    .strict()
    .describe("Shows an email on screen: one the app sent (caught locally, matched by to/subject) or an emulated `mock`."),
]).superRefine((a, ctx) => {
  if (a.do === "showEmail") {
    if (a.mock && (a.to !== undefined || a.subject !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["mock"], message: "showEmail takes either `mock` (an emulated email) or `to`/`subject` (one the app sent), not both" });
    }
    if (!a.mock && a.to === undefined && a.subject === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["do"], message: "showEmail needs `to` and/or `subject` to find the email the app sent, or a `mock` email" });
    }
    if (a.mock && a.mock.text === undefined && a.mock.html === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["mock"], message: "a mock email needs `text` or `html`" });
    }
    if (a.subject !== undefined) {
      const problem = textPatternProblem(a.subject);
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["subject"], message: problem });
    }
    for (const [key, pattern] of Object.entries(a.remember ?? {})) {
      const problem = /^\/.+\/[a-z]*$/.test(pattern) ? textPatternProblem(pattern) : `remember.${key} must be a "/pattern/" (its first group, else the whole match, is kept)`;
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["remember", key], message: problem });
    }
  }
  if (a.do === "expect" && a.text !== undefined) {
    const problem = textPatternProblem(a.text);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["text"], message: problem });
  }
  if (a.do === "expect" && a.exact !== undefined && a.text === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["exact"],
      message: "`exact` on an expect needs `text` (for an exact name or text match, put `exact: true` on the target)",
    });
  }
});
