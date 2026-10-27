// Pure text post-processing over a Playwright `ariaSnapshot()` (or several, joined) — no
// browser needed, so these are unit-testable without Playwright. See snapshot.ts for the part
// that actually talks to a Page.
import { redactPiiText } from "./redact.js";

const CONTROL_ROLE_RE = /^(\s*)- (textbox|combobox|listbox|checkbox|radio|searchbox|spinbutton) "([^"]*)"(.*)$/;
const OPTION_LINE_RE = /^\s*- option\b/;
const LIST_HEADER_RE = /^(\s*)- (combobox|listbox)\b/;

/** Interactive roles considered for the "two controls share a name" disambiguator — a superset
 * of `CONTROL_ROLE_RE`'s roles (form controls) plus the clickable roles a target commonly names
 * (button/link/tab/menuitem). Deliberately excludes purely structural roles. */
export const INTERACTIVE_ROLE_RE =
  /^(\s*)- (button|link|textbox|combobox|listbox|checkbox|radio|tab|menuitem|searchbox|spinbutton) "([^"]*)"/;

/** Caps each `combobox`/`listbox` block's nested `option` lines to `cap`, replacing the rest
 * with one "+N more" line — so a 200-item `<select>` doesn't blow the whole output's budget. */
export function capSelectOptions(lines: string[], cap: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    out.push(line);
    const header = line.match(LIST_HEADER_RE);
    if (!header) {
      i += 1;
      continue;
    }
    const headerIndent = header[1].length;
    i += 1;
    let count = 0;
    let skipped = 0;
    while (i < lines.length) {
      const l = lines[i];
      const indent = l.match(/^(\s*)/)?.[1].length ?? 0;
      if (indent <= headerIndent) break;
      if (OPTION_LINE_RE.test(l)) {
        count += 1;
        if (count <= cap) out.push(l);
        else skipped += 1;
      } else {
        out.push(l);
      }
      i += 1;
    }
    if (skipped > 0) {
      out.push(`${" ".repeat(headerIndent + 2)}- … (+${skipped} more)`);
    }
  }
  return out;
}

/** Normalises whitespace the same way accessible-name text is normalised, so a required
 * field's `<label>` text matches the name `ariaSnapshot()` printed for its control. */
export function normalizeName(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Appends a `[required]` marker to every form-control line whose accessible name is in
 * `requiredNames` (already normalised the same way) and doesn't already carry a required/
 * optional marker — including the richer `(label: "...", required|optional)` one
 * `annotateFieldHints` (below) may have already added, so the two passes never double-mark the
 * same field. */
export function markRequired(lines: string[], requiredNames: Set<string>): string[] {
  return lines.map((line) => {
    const m = line.match(CONTROL_ROLE_RE);
    if (!m) return line;
    const [, , , name, rest] = m;
    if (rest.includes("[required]") || rest.includes("(label:")) return line;
    if (!requiredNames.has(normalizeName(name))) return line;
    const head = line.slice(0, line.length - rest.length);
    return `${head} [required]${rest}`;
  });
}

/** One labelled field's short name + required/optional status, as collected from the live page
 * by `inspect/snapshot.ts`'s `collectFieldHints` (see there for the browser-side extraction —
 * this type is the Node-side shape it resolves to). `full` is the control's full accessible
 * name, exactly as `ariaSnapshot()` would print it — the key used to find the matching line. */
export interface FieldHint {
  full: string;
  /** The short name an author should write as a walkthrough's `target: { label: ... }` — see
   * capture/label-text.ts, the same short-name rule capture's label matching uses. */
  short: string;
  /** `true`/`false` when the control's `required`/`aria-required` attribute or its label's hint
   * text says so; `undefined` when neither gives an answer (no marker printed). */
  required?: boolean;
}

/**
 * Rewrites a matched form-control line to print the *short* name (what an author should write)
 * instead of the full accessible name when the two differ, folding the full name and the
 * required/optional status into a `(label: "...", required|optional)` annotation — e.g.
 * `textbox "Address" (label: "Address Optional", optional)`. A field whose short name matches
 * its full name just gets the plain `[required]` marker (handled by `markRequired`, left alone
 * here) instead of a redundant annotation.
 */
export function annotateFieldHints(lines: string[], hints: FieldHint[]): string[] {
  const byFull = new Map(hints.map((h) => [normalizeName(h.full).toLowerCase(), h] as const));
  return lines.map((line) => {
    const m = line.match(CONTROL_ROLE_RE);
    if (!m) return line;
    const [, indent, role, name, rest] = m;
    const hint = byFull.get(normalizeName(name).toLowerCase());
    if (!hint) return line;

    const reqWord = hint.required === true ? "required" : hint.required === false ? "optional" : null;
    const shortName = normalizeName(hint.short);
    const shortDiffers = shortName.length > 0 && shortName.toLowerCase() !== normalizeName(name).toLowerCase();
    if (!shortDiffers) {
      // Nothing this pass needs to add — `markRequired` still handles a plain `[required]`
      // marker for this line when the field's required and its short name equals its full name.
      return line;
    }

    const printedName = shortName;
    const annotation = ` (label: ${JSON.stringify(name)}${reqWord ? `, ${reqWord}` : ""})`;
    return `${indent}- ${role} ${JSON.stringify(printedName)}${annotation}${rest}`;
  });
}

/** One occurrence of a role+name pair that repeats on the page — see `snapshot.ts`'s
 * `collectDuplicateHints`, which walks the live DOM to produce these. `index` is this
 * occurrence's 0-based position among same-role-same-name matches, in the same document order
 * Playwright's own `getByRole(role, { name }).nth(index)` (and so a walkthrough target's `nth`)
 * would use. `within` is the nearest ancestor landmark/group/dialog's own accessible name, when
 * one exists — printed so an author can write `within: { ... }` instead of a brittle `nth`. */
export interface DuplicateHint {
  role: string;
  name: string;
  index: number;
  within?: string;
}

/**
 * Appends a disambiguator to every line whose role+name pair repeats elsewhere in the snapshot:
 * `(within: "<nearest named group/region/dialog>")` when one was found live on the page, else
 * `(nth: N)`. Matches `hints` to lines positionally — the Nth line with a given role+name gets
 * `hints`' Nth entry for that same role+name, which only lines up because both are walked in the
 * same document order. A role+name with no entry in `hints` (not actually a duplicate once
 * re-checked live, or resolution failed) is left alone.
 */
export function annotateDuplicates(lines: string[], hints: DuplicateHint[]): string[] {
  const byKey = new Map<string, DuplicateHint[]>();
  for (const hint of hints) {
    const key = `${hint.role}\u0000${normalizeName(hint.name).toLowerCase()}`;
    const group = byKey.get(key) ?? [];
    group.push(hint);
    byKey.set(key, group);
  }

  const seen = new Map<string, number>();
  return lines.map((line) => {
    const m = line.match(INTERACTIVE_ROLE_RE);
    if (!m) return line;
    const [, , role, name] = m;
    const key = `${role}\u0000${normalizeName(name).toLowerCase()}`;
    const group = byKey.get(key);
    if (!group || group.length < 2) return line;

    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    const hint = group[occurrence];
    if (!hint) return line;

    const disambiguator = hint.within ? `within: ${JSON.stringify(hint.within)}` : `nth: ${hint.index}`;
    return `${line} (${disambiguator})`;
  });
}

/** Redacts personal data (qa/pii's rules) out of every line's quoted text, line by line (so a
 * redaction never bleeds across the snapshot's own structural syntax). */
export function redactLines(lines: string[]): string[] {
  return lines.map((line) => redactPiiText(line));
}

/** Hard line cap, applied last — truncates with a one-line count of what got cut, same shape as
 * capture's failure-report snapshot cap. */
export function capLines(lines: string[], cap: number): { lines: string[]; truncated: boolean } {
  if (lines.length <= cap) return { lines, truncated: false };
  const kept = lines.slice(0, cap - 1);
  kept.push(`… (${lines.length - (cap - 1)} more lines trimmed — scope with --area)`);
  return { lines: kept, truncated: true };
}

export interface FormatOptions {
  optionCap?: number;
  lineCap?: number;
  /** Short-name + required/optional hints per field; see `annotateFieldHints`. */
  hints?: FieldHint[];
  /** Role+name duplicate disambiguators; see `annotateDuplicates`. */
  duplicates?: DuplicateHint[];
}

/** Runs the full pipeline: option cap -> short-name/hint annotation -> required markers ->
 * duplicate disambiguators -> PII redaction -> line cap. */
export function formatSnapshot(rawSnapshotText: string, requiredNames: Set<string>, opts: FormatOptions = {}): {
  text: string;
  lineCount: number;
  truncated: boolean;
} {
  const optionCap = opts.optionCap ?? 15;
  const lineCap = opts.lineCap ?? 80;

  let lines = rawSnapshotText.split("\n").filter((l) => l.length > 0);
  lines = capSelectOptions(lines, optionCap);
  lines = annotateFieldHints(lines, opts.hints ?? []);
  lines = markRequired(lines, requiredNames);
  lines = annotateDuplicates(lines, opts.duplicates ?? []);
  lines = redactLines(lines);
  const { lines: finalLines, truncated } = capLines(lines, lineCap);

  return { text: finalLines.join("\n"), lineCount: finalLines.length, truncated };
}
