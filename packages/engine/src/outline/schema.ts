// `outline.yaml` (M29): the planner's outline cards, stored so the differences writers and
// capture find between a card and the real screen ("Save session" was really "Add session")
// flow back to the plan instead of living only in a conversation.
import { z } from "zod";

export const CARD_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const OUTLINE_STATUSES = ["planned", "written", "captured", "dropped"] as const;
export type OutlineStatus = (typeof OUTLINE_STATUSES)[number];

export const DRIFT_SOURCES = ["capture", "writer"] as const;
export type DriftSource = (typeof DRIFT_SOURCES)[number];

/** One difference between what a card promised and what the screen showed. */
export interface DriftEntry {
  /** The on-screen name the card promised, e.g. "Save session". */
  expected: string;
  /** The closest name actually on screen, e.g. "Add session"; absent when nothing came close. */
  seen?: string;
  /** Walkthrough step id where `seen` was found (or where the writer noticed). */
  step?: string;
  /** ISO time the difference was first recorded. */
  at: string;
  source: DriftSource;
}

export interface OutlineCard {
  /** kebab-case; equal to the walkthrough id once it's written. */
  id: string;
  title: string;
  for?: string;
  section?: string;
  /** One line: from where to what result. */
  purpose?: string;
  /** On-screen names the card promises. Quoted strings in `title`/`purpose` count too. */
  labels?: string[];
  status: OutlineStatus;
  drift?: DriftEntry[];
  notes?: string[];
}

export interface OutlineFile {
  cards: OutlineCard[];
}

const DriftSchema = z
  .object({
    expected: z.string().min(1),
    seen: z.string().optional(),
    step: z.string().optional(),
    at: z.string().min(1),
    source: z.enum(DRIFT_SOURCES),
  })
  .strict();

export const OutlineCardSchema = z
  .object({
    id: z.string().regex(CARD_ID_PATTERN, "card ids are kebab-case, like walkthrough ids: add-session"),
    title: z.string().min(1),
    for: z.string().optional(),
    section: z.string().optional(),
    purpose: z.string().optional(),
    labels: z.array(z.string().min(1)).optional(),
    status: z.enum(OUTLINE_STATUSES).default("planned"),
    drift: z.array(DriftSchema).optional(),
    // A single string is fine by hand; written back as a list.
    notes: z.preprocess((v) => (typeof v === "string" ? [v] : v), z.array(z.string()).optional()),
  })
  .strict();

export const OutlineFileSchema = z
  .object({
    cards: z.preprocess((v) => v ?? [], z.array(OutlineCardSchema)),
  })
  .strict()
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    file.cards.forEach((card, i) => {
      if (seen.has(card.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate card id "${card.id}"`, path: ["cards", i, "id"] });
      seen.add(card.id);
    });
  });

/** A card id from a title: "Add a session (as staff)" -> "add-a-session-as-staff". */
export function cardIdFromTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}
