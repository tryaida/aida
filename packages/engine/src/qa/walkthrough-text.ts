// QA checks that depend only on a walkthrough's text, run by `aida validate` and at the start of
// `aida build` (build-plan.md M26) — so a chapter title or caption that QA would reject is
// caught in seconds, not after minutes of voice and render. The cues are built the way render
// builds them (render/timeline.ts + render/captions.ts) and checked with QA's own function and
// thresholds (`cueLineProblems`), so this never disagrees with the QA stage about what fails.
import { wrapCaption } from '../render/captions.js'
import { yamlLineLocator } from '../walkthrough/loader.js'
import type { Walkthrough } from '../walkthrough/types.js'
import { displayWalkthrough, unresolvedDisplayText } from '../walkthrough/display.js'
import { cueLineProblems } from './captions.js'

export interface WalkthroughTextProblem {
  /** The QA check this would fail later, e.g. 'captions:line-length'. */
  check: string
  /** Where the text ends up: `<id>.vtt`/`.srt` captions (and each path clip's), `<id>.chapters.vtt`,
   * or any printed/spoken output (`text`: an unresolved `{{placeholder}}`). */
  track: 'captions' | 'chapters' | 'text'
  /** Step id, or 'intro'/'outro' for the title cards. */
  step?: string
  /** YAML path of the field, e.g. "steps.2.title". */
  path: string
  /** Line in the walkthrough file, when the source text was given. */
  line?: number
  /** The text exactly as written in the walkthrough. */
  text: string
  message: string
}

/**
 * Every caption and chapter-title problem QA would report for this walkthrough's video. Pass the
 * file's `source` text to get line numbers.
 */
export function checkWalkthroughText(written: Walkthrough, source?: string): WalkthroughTextProblem[] {
  const problems: Omit<WalkthroughTextProblem, 'line'>[] = []

  // Output-bound text with no data for a `{{placeholder}}` (M35): it would print raw on the page,
  // the PDF and the card, and be spoken as written.
  for (const u of unresolvedDisplayText(written)) {
    problems.push({
      check: 'text:unresolved-placeholder',
      track: 'text',
      step: u.step,
      path: u.path,
      text: u.text,
      message: `unresolved template placeholder {{${u.placeholder}}}: no value in this walkthrough's data, so it would print as written; add it under \`data:\` or reword`,
    })
  }

  // Line lengths are checked on the words as shown: `{{data}}` filled in, the way every output prints them.
  const wt = displayWalkthrough(written)

  // Caption cues, in render's order: intro, each step, outro (render/timeline.ts). Each is wrapped
  // and split exactly as `toVtt`/`toSrt` do, so a cue render wraps fine isn't flagged.
  const captionSources: { step?: string; path: (string | number)[]; text: string }[] = []
  const cardCaption = (card: 'intro' | 'outro') => {
    const c = wt[card]
    if (c?.caption !== undefined) captionSources.push({ step: card, path: [card, 'caption'], text: c.caption })
    else if (c?.say !== undefined) captionSources.push({ step: card, path: [card, 'say'], text: c.say })
  }
  cardCaption('intro')
  wt.steps.forEach((s, i) => {
    if (s.caption !== undefined) captionSources.push({ step: s.id, path: ['steps', i, 'caption'], text: s.caption })
    else if (s.say !== undefined) captionSources.push({ step: s.id, path: ['steps', i, 'say'], text: s.say })
  })
  cardCaption('outro')
  // Each path's clip (M35) captions its opening steps the same way.
  ;(wt.paths ?? []).forEach((p, pi) => {
    p.steps.forEach((s, i) => {
      const step = s.id ? `${p.id}/${s.id}` : undefined
      if (s.caption !== undefined) captionSources.push({ step, path: ['paths', pi, 'steps', i, 'caption'], text: s.caption })
      else if (s.say !== undefined) captionSources.push({ step, path: ['paths', pi, 'steps', i, 'say'], text: s.say })
    })
  })

  for (const src of captionSources) {
    const field = src.path[src.path.length - 1]
    for (const cue of wrapCaption({ t0: 0, t1: 1, text: src.text })) {
      for (const p of cueLineProblems(cue)) {
        problems.push({
          check: 'captions:line-length',
          track: 'captions',
          step: src.step,
          path: src.path.join('.'),
          text: src.text,
          message:
            p.kind === 'line-length'
              ? `caption line "${p.line}" is ${p.actual} characters even after wrapping (from \`${field}\`); the limit is ${p.max}`
              : `caption needs ${p.actual} lines in one cue (from \`${field}\`); the limit is ${p.max}`,
        })
      }
    }
  }

  // Chapter titles: one cue per step in `<id>.chapters.vtt`, never wrapped (render/captions.ts
  // `toChaptersVtt`), so each title must fit on one line as written.
  wt.steps.forEach((s, i) => {
    if (s.title === undefined) return
    for (const p of cueLineProblems({ text: s.title })) {
      problems.push({
        check: 'captions:line-length',
        track: 'chapters',
        step: s.id,
        path: `steps.${i}.title`,
        text: s.title,
        message:
          p.kind === 'line-length'
            ? `step title is ${p.actual} characters; video chapter titles allow ${p.max}`
            : `step title has ${p.actual} lines; video chapter titles allow ${p.max}`,
      })
    }
  })

  if (source === undefined) return problems
  const lineOf = yamlLineLocator(source)
  return problems.map((p) => ({ ...p, line: lineOf(p.path.split('.').map((k) => (/^\d+$/.test(k) ? Number(k) : k))) }))
}

/** One line for terse output: `line 12, step "add-name": <message> — "<text>"`. */
export function formatTextProblem(p: WalkthroughTextProblem): string {
  const where = [p.line ? `line ${p.line}` : undefined, p.step ? `step "${p.step}"` : undefined].filter(Boolean).join(', ')
  const quoted = p.text.length > 80 ? `${p.text.slice(0, 77)}...` : p.text
  return `${where ? `${where}: ` : ''}${p.message} — "${quoted}"`
}
