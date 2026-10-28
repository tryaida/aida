// What the video's title cards say when a walkthrough leaves them out. Without `intro:`/`outro:`
// the intro card would sit silent and the outro card would show nothing, so both fall back to
// text built from the walkthrough itself. A field the walkthrough sets always wins; an explicit
// empty `say: ""` stays silent.
import type { Walkthrough } from "./types.js";

export interface CardText {
  intro: { say: string; caption: string };
  outro: { title: string; say: string; caption: string; recap: string[] };
}

/** The most recap lines a default outro lists. */
export const DEFAULT_RECAP_LINES = 4;

/** Spoken and shown text for the intro and outro cards, with defaults filled in. Expects a
 * walkthrough with `{{data}}` already resolved (`displayWalkthrough`). */
export function cardText(wf: Walkthrough): CardText {
  const summary = wf.summary?.replace(/\s+/g, " ").trim();
  const introSay = wf.intro?.say ?? (summary ? `${sentence(wf.title)} ${summary}` : sentence(wf.title));
  const outroSay = wf.outro?.say ?? "That's it. You're done.";
  return {
    intro: { say: introSay, caption: wf.intro?.caption ?? wf.intro?.say ?? (summary || wf.title) },
    outro: {
      title: wf.outro?.title ?? "You're done",
      say: outroSay,
      caption: wf.outro?.caption ?? outroSay,
      recap: wf.outro?.recap ?? defaultRecap(wf),
    },
  };
}

/** The chapters, else the step titles, at most DEFAULT_RECAP_LINES. */
function defaultRecap(wf: Walkthrough): string[] {
  const chapters = [...new Set(wf.steps.map((s) => s.chapter?.trim()).filter((c): c is string => Boolean(c)))];
  const lines = chapters.length >= 2 ? chapters : wf.steps.map((s) => s.title?.trim()).filter((t): t is string => Boolean(t));
  return lines.slice(0, DEFAULT_RECAP_LINES);
}

function sentence(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}
