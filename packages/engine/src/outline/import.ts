// `aida outline import`: reads the markdown card list aida-plan prints for review —
//
//   - Add a new competitor and their first entry
//     for: office staff · section: Competitors · from Competitors page to a submitted entry
//   - Record a "Cash" payment
//     id: record-payment · for: office staff · section: Payments · labels: "Record payment", "Cash"
//
// A bullet (`-`, `*` or `1.`) starts a card with its title; indented lines below it hold
// `·`/`|`-separated parts. `for:`, `section:`, `id:`, `labels:` and `status:` are fields; any
// other part is the purpose. Bold/backtick markup around a title is dropped.
import { quotedStrings } from "./drift.js";
import { cardIdFromTitle, OUTLINE_STATUSES, type OutlineCard, type OutlineStatus } from "./schema.js";

const BULLET = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;

function cleanTitle(s: string): string {
  return s
    .trim()
    .replace(/^\*\*(.+)\*\*$/, "$1")
    .replace(/^`(.+)`$/, "$1")
    .trim();
}

function parseLabels(value: string): string[] {
  const quoted = quotedStrings(value);
  if (quoted.length > 0) return quoted;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function applyDetail(card: OutlineCard, line: string): void {
  const purpose: string[] = [];
  for (const raw of line.split(/\s+[·|•]\s+|^[·|•]\s+|\s+[·|•]$/)) {
    const part = raw.trim();
    if (!part) continue;
    const field = part.match(/^(for|section|id|labels?|status)\s*:\s*(.*)$/i);
    if (!field) {
      purpose.push(part);
      continue;
    }
    const key = field[1].toLowerCase();
    const value = field[2].trim();
    if (key === "for") card.for = value;
    else if (key === "section") card.section = value;
    else if (key === "id") card.id = value;
    else if (key === "status" && (OUTLINE_STATUSES as readonly string[]).includes(value)) card.status = value as OutlineStatus;
    else if (key.startsWith("label")) card.labels = [...(card.labels ?? []), ...parseLabels(value)];
  }
  if (purpose.length > 0) card.purpose = [card.purpose, purpose.join(" · ")].filter(Boolean).join(" · ");
}

/** Parses the plan skill's markdown card list. Lines outside a card (headings, prose, fences) are ignored. */
export function parseMarkdownCards(text: string): OutlineCard[] {
  const cards: OutlineCard[] = [];
  let current: OutlineCard | undefined;
  let cardIndent = -1;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line) || !line.trim()) continue;
    const bullet = line.match(BULLET);
    const indent = line.length - line.trimStart().length;
    if (bullet && (cardIndent < 0 || indent <= cardIndent)) {
      const title = cleanTitle(bullet[2]);
      current = { id: cardIdFromTitle(title), title, status: "planned" };
      cards.push(current);
      cardIndent = indent;
      continue;
    }
    if (current && indent > cardIndent) {
      applyDetail(current, bullet ? bullet[2] : line.trim());
      continue;
    }
    // Anything else (a heading, a paragraph) ends the current card.
    current = undefined;
    cardIndent = -1;
  }
  return cards;
}
