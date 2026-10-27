import { z } from "zod";

/**
 * A Playwright-style locator used to find an element on the page.
 * Exactly the vocabulary the original pipeline's workflow.json uses: role/name, label,
 * placeholder, text or css, narrowed by hasText/within/innermost, plus
 * padUnion for growing a highlight box to include a second target.
 */
export interface Target {
  role?: string;
  name?: string;
  exact?: boolean;
  label?: string;
  placeholder?: string;
  /** Literal text, or a "/regex/" string. */
  text?: string;
  css?: string;
  hasText?: string;
  /** Narrow the search to inside another target. */
  within?: Target;
  /** When a css/text match returns a container, pick its innermost match. */
  innermost?: boolean;
  /** 0-based index to pick when several elements match role/name/etc (e.g. two "Delete" buttons
   * in different rows). Applied last, after every other narrowing (`within`/`hasText`/etc) —
   * takes priority over `innermost` when both are set. Prefer `within` to scope the match
   * unambiguously; fall back to `nth` only when there's no containing landmark to scope by (see
   * `aida inspect`, which prints the disambiguator to use for a role+name pair that repeats). */
  nth?: number;
  /** Grow this target's box to include another target's box (for highlights). */
  padUnion?: Target;
}

export const TargetSchema: z.ZodType<Target> = z.lazy(() =>
  z
    .object({
      role: z.string().optional(),
      name: z.string().optional(),
      exact: z.boolean().optional(),
      label: z.string().optional(),
      placeholder: z.string().optional(),
      text: z.string().optional(),
      css: z.string().optional(),
      hasText: z.string().optional(),
      within: TargetSchema.optional(),
      innermost: z.boolean().optional(),
      nth: z.number().int().min(0).optional(),
      padUnion: TargetSchema.optional(),
    })
    .strict()
    .refine(
      (t) => Boolean(t.role || t.label || t.placeholder || t.text || t.css),
      { message: "a target needs at least one of role, label, placeholder, text or css" },
    ),
);

/** `true` highlights the target itself; a Target highlights a different box. */
export const HighlightSchema = z.union([z.boolean(), TargetSchema]);
export type Highlight = boolean | Target;

/**
 * A fallback box in viewport CSS-px coordinates — the same space Target-derived highlight boxes
 * already use (capture/locate.ts's `boxOf`, capture/types.ts's `Box`). Used by a step's
 * `callouts`/`blur` entries when there's no element to pin to (M22).
 */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const BoxSchema: z.ZodType<Box> = z
  .object({
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
  })
  .strict();
