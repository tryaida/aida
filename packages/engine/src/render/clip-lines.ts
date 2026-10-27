// The words of each path's short clip (decisions 34, 37; M35): a title card naming the way in,
// each opening step's own `say`, and a closing card pointing back to the main video's step — or
// "Done" for a path that runs to its own end. Shared by
// voice (which narrates them) and render (which shows them), so the two never disagree. Pure.
import type { Walkthrough, WalkthroughPath } from "../walkthrough/types.js";
import { displayWalkthrough } from "../walkthrough/display.js";
import { joinIndex } from "../walkthrough/paths.js";

/** Narration/beat id of a path clip's beat: `<pathId>/intro`, `<pathId>/<stepId>`, `<pathId>/outro`
 * (the same `<pathId>/<stepId>` form edit actions use). */
export function pathBeatId(pathId: string, beat: string): string {
  return `${pathId}/${beat}`;
}

function sentence(text: string): string {
  const t = text.trim();
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

export interface PathClipText {
  pathId: string;
  /** Title card: eyebrow, the path's title and `when`. */
  intro: { eyebrow: string; title: string; subtitle: string; say: string };
  /** Closing card: "Then continue from step N: <title>", or "Done" for a path that runs alone. */
  outro: { title: string; say: string };
  /** 1-based number and title of the main step the path joins; absent when it runs alone. */
  continueAt?: { step: number; stepId?: string; title?: string };
}

/** The closing card of a path that runs to its own end (decision 37). */
export const PATH_DONE_CARD = { title: "Done", say: "Done." } as const;

/** The cards' words for one path (display text: `{{data}}` filled in). */
export function pathClipText(written: Walkthrough, writtenPath: WalkthroughPath): PathClipText {
  const wf = displayWalkthrough(written);
  const path = wf.paths?.find((p) => p.id === writtenPath.id) ?? writtenPath;
  const join = joinIndex(wf, path);
  const intro = { eyebrow: "Another way", title: path.title, subtitle: path.when, say: sentence(`Another way: ${path.title}`) };
  if (join === -1) return { pathId: path.id, intro, outro: { ...PATH_DONE_CARD } };
  const step = wf.steps[join];
  const n = join + 1;
  const title = step?.title?.trim();
  const closing = title ? `Then continue from step ${n}: ${title}` : `Then continue from step ${n}`;
  return {
    pathId: path.id,
    intro,
    outro: { title: closing, say: sentence(closing) },
    continueAt: { step: n, stepId: step?.id, title },
  };
}

/** Every path clip's narration lines, in order: each path's card, its opening steps' `say`, its
 * closing card. Path steps without an id are skipped (validate requires one). */
export function pathClipLines(written: Walkthrough): { id: string; text: string }[] {
  const wf = displayWalkthrough(written);
  const out: { id: string; text: string }[] = [];
  for (const path of wf.paths ?? []) {
    let text: PathClipText;
    try {
      text = pathClipText(wf, path);
    } catch {
      continue; // joins no main step: the loader rejects that file; nothing to narrate
    }
    out.push({ id: pathBeatId(path.id, "intro"), text: text.intro.say });
    for (const s of path.steps) if (s.id) out.push({ id: pathBeatId(path.id, s.id), text: s.say ?? "" });
    out.push({ id: pathBeatId(path.id, "outro"), text: text.outro.say });
  }
  return out;
}
