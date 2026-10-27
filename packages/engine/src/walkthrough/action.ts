import { z } from "zod";
import { TargetSchema, HighlightSchema, type Target, type Highlight } from "./target.js";

/**
 * One captured interaction. The vocabulary is the original pipeline's: click, type, point,
 * expect, waitFor, waitForUrl, scrollTo, plus `goto` (a plain-words addition
 * for `go to /path` navigation, which workflow.json never needed explicitly).
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
  | { do: "expect"; target: Target; highlight?: Highlight }
  | { do: "waitFor"; target: Target; snapshot?: boolean | string; highlight?: Highlight }
  | { do: "waitForUrl"; pattern: string }
  | { do: "scrollTo"; target: Target }
  | { do: "goto"; path: string };

const base = { target: TargetSchema, highlight: HighlightSchema.optional() };

export const ActionSchema: z.ZodType<Action> = z.discriminatedUnion("do", [
  z.object({ do: z.literal("click"), ...base }).strict(),
  z.object({ do: z.literal("type"), target: TargetSchema, text: z.string() }).strict(),
  z.object({ do: z.literal("select"), target: TargetSchema, option: z.string(), highlight: HighlightSchema.optional() }).strict(),
  z.object({ do: z.literal("point"), ...base }).strict(),
  z.object({ do: z.literal("expect"), ...base }).strict(),
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
]);
