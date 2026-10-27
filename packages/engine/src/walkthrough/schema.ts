import { z } from "zod";
import { TargetSchema, BoxSchema } from "./target.js";
import { ActionSchema } from "./action.js";
import { parseDoString } from "./parse-do.js";
import { sectionProblems } from "./placement.js";
import type { Step, Walkthrough } from "./types.js";

const ViewportSchema = z.object({ width: z.number(), height: z.number() }).strict();

const PersonaSchema = z
  .object({
    role: z.string().optional(),
    name: z.string().optional(),
    email: z.string().optional(),
    cognitoSub: z.string().optional(),
  })
  .strict();

const StartSchema = z
  .object({
    signed_in_as: z.string().min(1).optional(),
    page: z.string().optional(),
    baseUrl: z.string().optional(),
    viewport: ViewportSchema.optional(),
    deviceScaleFactor: z.number().optional(),
    show: z.string().optional(),
    notes: z.string().optional(),
    persona: PersonaSchema.optional(),
  })
  .strict();

const VerifiedAgainstSchema = z
  .object({
    app: z.string().optional(),
    routes: z.array(z.string()).optional(),
    sources: z.array(z.string()).optional(),
  })
  .strict();

const VoiceConfigSchema = z
  .object({
    provider: z.string().optional(),
    model: z.string().optional(),
    voiceId: z.string().optional(),
    speed: z.number().optional(),
    gapSeconds: z.number().optional(),
  })
  .strict();

const TitleCardSchema = z
  .object({
    eyebrow: z.string().optional(),
    title: z.string().optional(),
    subtitle: z.string().optional(),
    say: z.string().optional(),
    caption: z.string().optional(),
    recap: z.array(z.string()).optional(),
  })
  .strict();

const CameraSchema = z.union([
  z.literal("full"),
  z
    .object({
      focus: TargetSchema,
      zoom: z.number().optional(),
      align: z.enum(["top", "right", "left"]).optional(),
    })
    .strict(),
]);

const DatabaseCheckSchema = z
  .object({
    name: z.string(),
    sql: z.string(),
    params: z.array(z.string()).optional(),
    expect: z.record(z.unknown()),
  })
  .strict();

const ValidateSchema = z
  .object({ database: z.array(DatabaseCheckSchema).optional() })
  .strict();

// A callout/blur box pins to exactly one of `target` (resolved to a box from the capture
// manifest at page/render time, so it follows the element when the layout moves) or a fixed
// `box` (viewport CSS-px, the same space `boxOf`/highlight boxes use) — never both, never
// neither, or the Studio/CLI edit actions that write these would have no single source of truth
// for where the box actually is.
const CalloutSchema = z
  .object({
    id: z.string(),
    target: TargetSchema.optional(),
    box: BoxSchema.optional(),
    label: z.string().optional(),
  })
  .strict()
  .refine((c) => Boolean(c.target) !== Boolean(c.box), {
    message: "a callout needs exactly one of `target` or `box`",
  });

const BlurBoxSchema = z
  .object({
    id: z.string(),
    target: TargetSchema.optional(),
    box: BoxSchema.optional(),
  })
  .strict()
  .refine((b) => Boolean(b.target) !== Boolean(b.box), {
    message: "a blur box needs exactly one of `target` or `box`",
  });

/**
 * The raw shape a YAML file may use: short plain-words fields (`do`, `check`)
 * alongside, or instead of, a full `actions:` list. `RawStepSchema.toStep()`
 * (see below) merges these into a Step with a resolved `actions` array.
 */
const RawStepSchema = z
  .object({
    id: z.string().optional(),
    chapter: z.string().optional(),
    title: z.string().optional(),
    do: z.union([z.string(), z.array(z.string())]).optional(),
    say: z.string().optional(),
    caption: z.string().optional(),
    page_text: z.string().optional(),
    check: z.union([z.string(), z.array(z.string())]).optional(),
    mask: z.array(z.string()).optional(),
    camera: CameraSchema.optional(),
    hold: z.number().min(0, "hold must be 0 or more seconds").optional(),
    callouts: z.array(CalloutSchema).optional(),
    blur: z.array(BlurBoxSchema).optional(),
    actions: z.array(ActionSchema).optional(),
  })
  .strict()
  // A step mixing `do`/`check` with `actions:` used to silently run both (rawStepToStep below
  // concatenated them), so an edit meant to replace one left the other's stale/broken actions
  // running too. Reject the ambiguous shape outright instead — a step picks either plain words
  // (`do`/`check`) or a structured `actions:` list, never both.
  .refine((raw) => !((raw.do !== undefined || raw.check !== undefined) && raw.actions !== undefined), {
    message: "a step can't have both `do`/`check` and `actions:` — pick one (use `setStepField` for do/check, `setStepActions` for actions)",
  });

export type RawStep = z.infer<typeof RawStepSchema>;

// Fields that only make sense on a recorded step. A setup step is never filmed or narrated, so
// naming one is almost always a step pasted into the wrong list — say so instead of the generic
// "unrecognized key" message.
const RECORDED_ONLY_FIELDS = ["chapter", "say", "caption", "page_text", "mask", "camera", "hold", "callouts", "blur"] as const;

/** A `setup.steps` entry: the step/action grammar without narration or frames (decision 28). */
const RawSetupStepSchema = z
  .object({
    id: z.string().optional(),
    title: z.string().optional(),
    do: z.union([z.string(), z.array(z.string())]).optional(),
    check: z.union([z.string(), z.array(z.string())]).optional(),
    actions: z.array(ActionSchema).optional(),
    // Accepted only so the refinement below can explain why they're not allowed.
    chapter: z.unknown().optional(),
    say: z.unknown().optional(),
    caption: z.unknown().optional(),
    page_text: z.unknown().optional(),
    mask: z.unknown().optional(),
    camera: z.unknown().optional(),
    hold: z.unknown().optional(),
    callouts: z.unknown().optional(),
    blur: z.unknown().optional(),
  })
  .strict()
  .superRefine((raw, ctx) => {
    for (const key of RECORDED_ONLY_FIELDS) {
      if (raw[key] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `setup steps aren't recorded or narrated, so they can't have \`${key}\`; move this step into \`steps:\` or remove \`${key}\``,
        });
      }
    }
    if ((raw.do !== undefined || raw.check !== undefined) && raw.actions !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a setup step can't have both `do`/`check` and `actions:` — pick one" });
    }
    if (raw.do === undefined && raw.check === undefined && raw.actions === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a setup step needs `do`, `check` or `actions:`" });
    }
  });

/** State names are kebab-case, like walkthrough ids: `session-full`, `alex-on-waitlist`. */
export const STATE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const StateListSchema = z
  .array(
    z
      .string()
      .regex(STATE_NAME_PATTERN, "state names are kebab-case: lowercase letters and digits joined by single hyphens, e.g. session-full"),
  )
  .superRefine((names, ctx) => {
    const seen = new Set<string>();
    for (const [i, name] of names.entries()) {
      if (seen.has(name)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i], message: `"${name}" is listed twice` });
      seen.add(name);
    }
  });

const SetupSchema = z
  .object({
    as: z.string().optional(),
    steps: z.array(RawSetupStepSchema).min(1),
  })
  .strict();

/** Data keys the engine fills in itself; `{{run.id}}` is a short id unique to each capture run. */
export const RESERVED_DATA_KEYS = ["run"] as const;

// The id is used as a path segment (capture/render output dirs, cache paths, etc.), so it's
// restricted to a slug: lowercase letters/digits, starting with one, hyphens as separators.
const WALKTHROUGH_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export const WalkthroughDocSchema = z
  .object({
    walkthrough: z
      .string()
      .regex(
        WALKTHROUGH_ID_PATTERN,
        "walkthrough id must be a slug: lowercase letters, digits and hyphens, starting with a letter or digit",
      ),
    version: z.number().optional(),
    title: z.string(),
    summary: z.string().optional(),
    product: z.string().optional(),
    for: z.string().optional(),
    // Where the page sits in the help library: a top-level category ("Getting started") or a
    // feature group inside "How do I…" ("Payments"), nested with " / " — see placement.ts.
    section: z
      .string()
      .superRefine((value, ctx) => {
        for (const message of sectionProblems(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
      })
      .optional(),
    verifiedAgainst: VerifiedAgainstSchema.optional(),
    start: StartSchema.optional(),
    data: z
      .record(z.unknown())
      .superRefine((data, ctx) => {
        for (const key of RESERVED_DATA_KEYS) {
          if (key in data) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [key],
              message: `\`${key}\` is reserved in data: aida fills in {{${key}.id}} itself on each run; rename this key`,
            });
          }
        }
      })
      .optional(),
    voice: VoiceConfigSchema.optional(),
    intro: TitleCardSchema.optional(),
    outro: TitleCardSchema.optional(),
    steps: z.array(RawStepSchema).min(1),
    validate: ValidateSchema.optional(),
    // Data this walkthrough depends on and changes (decision 28; states/order.ts).
    needs: StateListSchema.optional(),
    leaves: StateListSchema.optional(),
    clears: StateListSchema.optional(),
    setup: SetupSchema.optional(),
  })
  .strict()
  .superRefine((doc, ctx) => {
    // Leaving and clearing the same state says two opposite things about the data afterwards.
    const leaves = new Set(doc.leaves ?? []);
    for (const [i, name] of (doc.clears ?? []).entries()) {
      if (leaves.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["clears", i],
          message: `"${name}" is in both \`leaves\` and \`clears\`; keep the one that's true once this walkthrough has run`,
        });
      }
    }
  });

export type WalkthroughDoc = z.infer<typeof WalkthroughDocSchema>;

/** Turns a step's `do:` / `check:` / `actions:` fields into one action list. */
export function rawStepToStep(raw: RawStep): Step {
  const actions = [];
  for (const doText of toArray(raw.do)) {
    actions.push(...parseDoString(doText));
  }
  for (const checkText of toArray(raw.check)) {
    actions.push(...parseCheck(checkText));
  }
  if (raw.actions) {
    actions.push(...raw.actions);
  }
  return {
    id: raw.id,
    chapter: raw.chapter,
    title: raw.title,
    say: raw.say,
    caption: raw.caption,
    page_text: raw.page_text,
    mask: raw.mask,
    camera: raw.camera,
    hold: raw.hold,
    callouts: raw.callouts,
    blur: raw.blur,
    actions,
  };
}

function parseCheck(checkText: string) {
  const m = checkText.trim().match(/^text\s+"([^"]+)"\s+is\s+visible$/i);
  if (m) {
    return [{ do: "expect" as const, target: { text: m[1] } }];
  }
  // Fall back to the same grammar as `do:` (e.g. `check: expect text "..."`).
  return parseDoString(checkText);
}

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** Builds a typed Walkthrough from a validated raw document. */
export function docToWalkthrough(doc: WalkthroughDoc): Walkthrough {
  return {
    walkthrough: doc.walkthrough,
    version: doc.version,
    title: doc.title,
    summary: doc.summary,
    product: doc.product,
    for: doc.for,
    ...(doc.section !== undefined ? { section: doc.section } : {}),
    verifiedAgainst: doc.verifiedAgainst,
    start: doc.start,
    data: doc.data,
    ...(doc.needs !== undefined ? { needs: doc.needs } : {}),
    ...(doc.leaves !== undefined ? { leaves: doc.leaves } : {}),
    ...(doc.clears !== undefined ? { clears: doc.clears } : {}),
    ...(doc.setup !== undefined
      ? {
          setup: {
            ...(doc.setup.as !== undefined ? { as: doc.setup.as } : {}),
            steps: doc.setup.steps.map((raw) => rawStepToStep({ id: raw.id, title: raw.title, do: raw.do, check: raw.check, actions: raw.actions })),
          },
        }
      : {}),
    voice: doc.voice,
    intro: doc.intro,
    outro: doc.outro,
    steps: doc.steps.map(rawStepToStep),
    validate: doc.validate,
  };
}
