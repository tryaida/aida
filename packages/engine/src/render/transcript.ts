// Plain-text transcripts (M42a, decision 39), written next to a rendered video:
// `<id>.transcript.md` for the main video, `<id>.path-<pathId>.transcript.md` for a path clip. The
// narration exactly as spoken — `say` after display resolution (M35's `{{data}}` fill-in), the
// same text `commands/voice.ts`'s `narrationLinesOf`/`pathClipLines` hand the TTS provider, never
// the provider's own pronunciation-respelled text (config.voice.pronunciation substitutes inside
// the voice module, after this text leaves it — see voice/narrate.ts).
import type { Step, Walkthrough, WalkthroughPath } from "../walkthrough/types.js";
import { displayWalkthrough } from "../walkthrough/display.js";
import { cardText } from "../walkthrough/cards.js";
import { pathClipText } from "./clip-lines.js";
import type { StepNumbering } from "./timeline.js";

function section(heading: string, body: string | undefined): string {
  const text = body?.trim();
  return text ? `## ${heading}\n\n${text}\n` : `## ${heading}\n`;
}

function stepSection(step: Step, stepNumber: number): string {
  return section(`${stepNumber}. ${step.title ?? step.id ?? `Step ${stepNumber}`}`, step.say);
}

function assemble(title: string, intro: string, steps: Step[], outroHeading: string, outro: string, numbers?: number[]): string {
  const parts = [
    `# ${title}`,
    "",
    section("Intro", intro),
    ...steps.map((s, i) => stepSection(s, numbers?.[i] ?? i + 1)),
    section(outroHeading, outro),
  ];
  return `${parts.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

/** The main video's transcript, in playback order: intro narration, one `## N. Step title`
 * section per step, outro. `written` need not be display-resolved already — this resolves it
 * itself (idempotent; same pattern as `narrationLinesOf`/`pathClipLines`). `stepNumbering`
 * (a device-filtered walkthrough, decision 40): each step's `N` is its whole-walkthrough number,
 * as on the page — see `BuildTimelineOptions.stepNumbering`. */
export function buildTranscript(written: Walkthrough, stepNumbering?: StepNumbering): string {
  const wf = displayWalkthrough(written);
  const cards = cardText(wf);
  return assemble(wf.title, cards.intro.say, wf.steps, "Outro", cards.outro.say, stepNumbering?.numbers);
}

/** One path's short clip transcript: its title card, each opening step's narration, the closing
 * card (`render/clip-lines.ts`'s `pathClipText` — the same cards the clip's video shows). */
export function buildPathTranscript(written: Walkthrough, path: WalkthroughPath): string {
  const wf = displayWalkthrough(written);
  const resolvedPath = wf.paths?.find((p) => p.id === path.id) ?? path;
  const text = pathClipText(wf, resolvedPath);
  return assemble(resolvedPath.title, text.intro.say, resolvedPath.steps, "Outro", text.outro.say);
}
