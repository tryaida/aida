// Shared, pure text-normalisation for `<label>` text, used by BOTH capture's label-target
// matching (locate.ts) and `aida inspect`'s printed field names (inspect/snapshot.ts,
// inspect/format.ts) — so an author sees, and can type, the exact same "short name" aida itself
// matches against. Kept dependency-free (no DOM, no Playwright) so it's usable from plain Node
// code and copy-able, nearly verbatim, into the small browser-evaluate scripts that need the same
// behaviour inside a page (see inspect/snapshot.ts's COLLECT_FIELD_HINTS_SCRIPT).
//
// Real design systems put a label's required/optional hint in one of two shapes:
//   1. Inline text on the label itself: `<label>First Name (Required for this action)</label>`
//   2. A nested element (a hint `<span>`, a badge, an icon): `<label>Address <span>Optional</span></label>`
// Shape 2 is the one that broke matching/printing before this module existed: a label's *full*
// text (what `ariaSnapshot()`/`getByLabel()` sees as the accessible name) folds the nested
// element's text in too, becoming "Address Optional" — a reasonable author never guesses that.
// `shortLabelText` on its own only strips a trailing `*`/`:`; the DOM-side callers combine it with
// "this label's own *direct* text nodes only" (excluding any nested element, control or not) to
// get shape 2's short name for free — the nested hint's text simply isn't a direct text node.

/** Whitespace-normalises `text` and strips a trailing run of `*`/`:` — the minimal cleanup a
 * label's own *direct* text nodes need before being compared against (or printed as) a
 * walkthrough's short `label` name. Deliberately does NOT strip "(Required...)"/"(Optional)"
 * parenthetical hint text — that's `stripHintMarkers` below, used as the separate, broader
 * fallback tier so the two stay distinguishable (see locate.ts `resolveLabel`'s matching order). */
export function shortLabelText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[*:]+$/, "")
    .trim();
}

/** Strips the common required/optional hint markers real design systems put inline in a
 * `<label>`'s own text: parenthetical "(Required...)"/"(Optional...)" text, or a trailing `*`/
 * `:`. Used for the historical, broader "marker-stripped full-token" matching tier — a label
 * whose hint is nested in a child element (rather than inline text) needs `shortLabelText` over
 * the label's *direct* text instead; see this module's header comment. */
export const HINT_MARKER_RE = /\(\s*(required|optional)[^)]*\)|[*:]+\s*$/gi;

export function stripHintMarkers(text: string): string {
  return text.replace(HINT_MARKER_RE, " ").replace(/\s+/g, " ").trim();
}
