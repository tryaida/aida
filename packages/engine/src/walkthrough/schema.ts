import { z } from "zod";
import { TargetSchema, BoxSchema } from "./target.js";
import { ActionSchema, type Action } from "./action.js";
import { parseDoString } from "./parse-do.js";
import { sectionProblems } from "./placement.js";
import type { Step, Walkthrough, WalkthroughPath } from "./types.js";

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
    expect: z.record(z.string(), z.unknown()),
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

/**
 * Where an alternative way in starts (decision 34): its own page, signed in as the walkthrough's
 * own persona. `signed_in_as` may only repeat that persona's role — a path never switches who is
 * signed in, or its shared steps would run as someone else. No `persona`: the walkthrough's
 * `start.persona` is the one persona, used as written.
 */
const PathStartSchema = z
  .object({
    page: z.string().min(1, "a path's start needs a page, e.g. /attendees"),
    signed_in_as: z.string().min(1).optional(),
  })
  .strict();

// Fields a path can't have: the data a walkthrough needs and changes belongs to the whole
// walkthrough (every path starts from the same data and should leave the same states).
const PATH_FORBIDDEN_FIELDS = ["needs", "leaves", "clears", "setup", "validate"] as const;

/** Path ids name a build directory (`capture/paths/<id>/`), so they're slugs like walkthrough ids. */
export const PATH_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * One other way to do the task (decisions 34, 37): its own start and opening steps, then the main
 * steps from `joins` on — or, without `joins`, its own steps to its own end, the last one ending
 * in a check. `when` is one plain sentence a reader uses to pick this way.
 */
const PathSchema = z
  .object({
    id: z.string().regex(PATH_ID_PATTERN, "path ids are kebab-case, like walkthrough ids: from-attendee"),
    title: z.string().min(1),
    when: z.string().min(1, "say in one plain sentence when to use this way"),
    start: PathStartSchema,
    steps: z.array(RawStepSchema).min(1, "a path needs at least one step of its own"),
    // The main step this path joins; leave it out for a path that runs to its own end.
    joins: z.string().min(1).optional(),
    // Shown on the page only when capture flagged this path as saving differently (pathDiffs).
    note: z.string().optional(),
    // Accepted only so the refinement below can explain why they're not allowed.
    needs: z.unknown().optional(),
    leaves: z.unknown().optional(),
    clears: z.unknown().optional(),
    setup: z.unknown().optional(),
    validate: z.unknown().optional(),
  })
  .strict()
  .superRefine((raw, ctx) => {
    for (const key of PATH_FORBIDDEN_FIELDS) {
      if (raw[key] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `a path shares the walkthrough's data, so it can't have \`${key}\`; put it on the walkthrough itself`,
        });
      }
    }
  });

export type RawPath = z.infer<typeof PathSchema>;

/** Data keys the engine fills in itself; `{{run.id}}` is a short id unique to each capture run. */
export const RESERVED_DATA_KEYS = ["run", "inbox"] as const;

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
      .record(z.string(), z.unknown())
      .superRefine((data, ctx) => {
        for (const key of RESERVED_DATA_KEYS) {
          if (key in data) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [key],
              message: `\`${key}\` is reserved in data: ${key === "run" ? "aida fills in {{run.id}} itself on each run" : "{{inbox.<key>}} holds values read from emails during capture"}; rename this key`,
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
    // Other ways to do the same task (decision 34).
    paths: z.array(PathSchema).optional(),
  })
  .strict()
  .superRefine((doc, ctx) => {
    checkPaths(doc, ctx);
    // `intro` and `outro` name the title cards' narration beats (main video and each path clip).
    const reserved = (id: string | undefined, path: (string | number)[]) => {
      if (id !== undefined && RESERVED_STEP_IDS.has(id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `step id "${id}" is reserved for the video's title cards; pick another id` });
      }
    };
    doc.steps.forEach((step, i) => reserved(step.id, ["steps", i, "id"]));
    doc.paths?.forEach((p, i) => p.steps.forEach((step, j) => reserved(step.id, ["paths", i, "steps", j, "id"])));
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

/** Step ids the video's title-card beats use (`intro`, `outro`; render/timeline.ts `beatIds`). */
export const RESERVED_STEP_IDS: ReadonlySet<string> = new Set(["intro", "outro"]);

/** The role a raw start names, from `persona.role` or `signed_in_as`. */
function rawRole(start: { signed_in_as?: string; persona?: { role?: string } } | undefined): string | undefined {
  return start?.persona?.role ?? start?.signed_in_as;
}

/**
 * Cross-checks `paths` against the main steps: unique path ids, `joins` names a main step, path
 * step ids that don't clash with main step ids (a captured path run holds both), and one persona
 * (a path's start may only repeat the walkthrough's own).
 */
function checkPaths(
  doc: {
    start?: { signed_in_as?: string; persona?: { role?: string } };
    steps: { id?: string }[];
    paths?: { id: string; start: { signed_in_as?: string }; steps: RawStep[]; joins?: string }[];
  },
  ctx: z.RefinementCtx,
): void {
  if (!doc.paths) return;
  const mainIds = new Set(doc.steps.map((s) => s.id).filter((id): id is string => Boolean(id)));
  const mainRole = rawRole(doc.start);
  const pathIds = new Set<string>();
  doc.paths.forEach((path, i) => {
    if (pathIds.has(path.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["paths", i, "id"], message: `path id "${path.id}" is used twice; give each path its own id` });
    }
    pathIds.add(path.id);
    if (path.joins === undefined) {
      // Runs to its own end (decision 37): its last step proves the task is done.
      const last = path.steps[path.steps.length - 1];
      if (last && !stepEndsInCheck(last)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["paths", i, "steps", path.steps.length - 1],
          message: `path "${path.id}" has no \`joins\`, so it runs to its own end: its last step needs a check that the task is done (\`check:\`, or an \`expect\`, \`waitFor\` or \`waitForUrl\` action) — or add \`joins:\` naming the main step it continues from`,
        });
      }
    } else if (!mainIds.has(path.joins)) {
      const ids = [...mainIds];
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paths", i, "joins"],
        message: `path "${path.id}" joins "${path.joins}", which isn't a main step id${ids.length > 0 ? ` (main steps: ${ids.join(", ")})` : " (give the main steps ids)"}`,
      });
    }
    const seen = new Set<string>();
    path.steps.forEach((step, j) => {
      if (!step.id) return;
      if (mainIds.has(step.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["paths", i, "steps", j, "id"],
          message: `path "${path.id}" step id "${step.id}" is also a main step id; path steps need their own ids`,
        });
      }
      if (seen.has(step.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["paths", i, "steps", j, "id"], message: `path "${path.id}" has two steps with id "${step.id}"` });
      }
      seen.add(step.id);
    });
    const role = path.start.signed_in_as;
    if (role !== undefined && role !== mainRole) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paths", i, "start", "signed_in_as"],
        message: mainRole
          ? `path "${path.id}" signs in as "${role}" but the walkthrough signs in as "${mainRole}"; a path uses the walkthrough's persona — leave it out or make it match`
          : `path "${path.id}" signs in as "${role}" but the walkthrough's start names no persona; set it on the walkthrough's start instead`,
      });
    }
  });
}


/** Actions that prove something is on screen: what a path without `joins` must end with. */
export const CHECK_ACTIONS: ReadonlySet<string> = new Set(["expect", "waitFor", "waitForUrl"]);

/** True when a raw step ends in a check: a `check:` field, or a check action as its last action. */
export function stepEndsInCheck(raw: RawStep): boolean {
  if (raw.check !== undefined && toArray(raw.check).length > 0) return true;
  let actions: Action[];
  try {
    actions = rawStepToStep(raw).actions;
  } catch {
    return false;
  }
  const last = actions[actions.length - 1];
  return Boolean(last && CHECK_ACTIONS.has(last.do));
}

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
  const m = checkText.trim().match(/^text\s+(exactly\s+)?"([^"]+)"\s+is\s+visible$/i);
  if (m) {
    return [{ do: "expect" as const, target: m[1] ? { text: m[2], exact: true } : { text: m[2] } }];
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
    ...(doc.paths !== undefined ? { paths: doc.paths.map(rawPathToPath) } : {}),
  };
}

/** A validated raw path as its typed form (steps resolved to action lists). */
export function rawPathToPath(raw: RawPath): WalkthroughPath {
  return {
    id: raw.id,
    title: raw.title,
    when: raw.when,
    start: {
      page: raw.start.page,
      ...(raw.start.signed_in_as !== undefined ? { signed_in_as: raw.start.signed_in_as } : {}),
    },
    steps: raw.steps.map(rawStepToStep),
    ...(raw.joins !== undefined ? { joins: raw.joins } : {}),
    ...(raw.note !== undefined ? { note: raw.note } : {}),
  };
}
