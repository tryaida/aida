// `aida outline add|import|list|note|check|status` (M29): the planner's outline cards, kept in
// `outline.yaml` so differences between a card and the real screen come back to the plan.
import { readFileSync } from "node:fs";
import { loadConfig } from "../config/index.js";
import {
  addCard,
  cardIdFromTitle,
  cardLabels,
  checkOutline,
  describeDrift,
  noteOutline,
  OUTLINE_STATUSES,
  outlinePath,
  parseMarkdownCards,
  readOutline,
  setStatus,
  updateOutline,
  walkthroughIds,
  type OutlineCard,
  type OutlineStatus,
} from "../outline/index.js";

type Print = { json: boolean };

function failWith(json: boolean, message: string): number {
  if (json) console.log(JSON.stringify({ ok: false, error: message }));
  else console.error(`error: ${message}`);
  return 1;
}

async function withOutline(configPath: string, json: boolean, fn: (file: string, config: Awaited<ReturnType<typeof loadConfig>>) => number): Promise<number> {
  try {
    const config = await loadConfig(configPath);
    return fn(outlinePath(config), config);
  } catch (err) {
    return failWith(json, ((err as Error).message ?? String(err)).split("\n")[0]);
  }
}

function cardLine(card: OutlineCard): string {
  const where = [card.for ? `for ${card.for}` : "", card.section ?? ""].filter(Boolean).join(" · ");
  return `${card.status.padEnd(8)}  ${card.id}  ${card.title}${where ? `  (${where})` : ""}`;
}

export interface OutlineAddOptions extends Print {
  configPath: string;
  title: string;
  id?: string;
  for?: string;
  section?: string;
  purpose?: string;
  labels?: string[];
}

export async function runOutlineAdd(opts: OutlineAddOptions): Promise<number> {
  return withOutline(opts.configPath, opts.json, (file) => {
    const card: OutlineCard = {
      id: opts.id ?? cardIdFromTitle(opts.title),
      title: opts.title,
      ...(opts.for ? { for: opts.for } : {}),
      ...(opts.section ? { section: opts.section } : {}),
      ...(opts.purpose ? { purpose: opts.purpose } : {}),
      ...(opts.labels?.length ? { labels: opts.labels } : {}),
      status: "planned",
    };
    updateOutline(file, (loaded) => addCard(loaded!.doc, card), { create: true });
    if (opts.json) console.log(JSON.stringify({ ok: true, file, card }));
    else console.log(`added ${card.id} to ${file}`);
    return 0;
  });
}

export interface OutlineImportOptions extends Print {
  configPath: string;
  /** A markdown file, or "-" for stdin. */
  source: string;
}

export async function runOutlineImport(opts: OutlineImportOptions): Promise<number> {
  return withOutline(opts.configPath, opts.json, (file) => {
    const text = readFileSync(opts.source === "-" ? 0 : opts.source, "utf8");
    const cards = parseMarkdownCards(text);
    if (cards.length === 0) return failWith(opts.json, `no cards found in ${opts.source === "-" ? "stdin" : opts.source} (expected "- Title" lines, details indented below)`);
    const added: string[] = [];
    const skipped: string[] = [];
    updateOutline(
      file,
      (loaded) => {
        for (const card of cards) {
          if (loaded!.outline.cards.some((c) => c.id === card.id) || added.includes(card.id)) {
            skipped.push(card.id);
            continue;
          }
          addCard(loaded!.doc, card);
          added.push(card.id);
        }
      },
      { create: true },
    );
    if (opts.json) console.log(JSON.stringify({ ok: true, file, added, skipped }));
    else {
      console.log(`added ${added.length} card${added.length === 1 ? "" : "s"} to ${file}${added.length ? `: ${added.join(", ")}` : ""}`);
      if (skipped.length) console.log(`already in the outline, left as they are: ${skipped.join(", ")}`);
    }
    return 0;
  });
}

export interface OutlineListOptions extends Print {
  configPath: string;
  /** Only cards with drift. */
  drift?: boolean;
}

export async function runOutlineList(opts: OutlineListOptions): Promise<number> {
  return withOutline(opts.configPath, opts.json, (file, config) => {
    const loaded = readOutline(file);
    const all = loaded?.outline.cards ?? [];
    const cards = opts.drift ? all.filter((c) => (c.drift ?? []).length > 0) : all;
    const written = cards.length > 0 ? walkthroughIds(config.walkthroughsDir) : new Set<string>();
    if (opts.json) {
      console.log(
        JSON.stringify({ ok: true, file, exists: Boolean(loaded), cards: cards.map((c) => ({ ...c, promised: cardLabels(c), walkthrough: written.has(c.id) })) }),
      );
      return 0;
    }
    if (!loaded) {
      console.log(`no outline yet (${file}); aida outline add or import creates it`);
      return 0;
    }
    if (cards.length === 0) {
      console.log(opts.drift ? "no drift: every card matches what capture saw" : `no cards in ${file}`);
      return 0;
    }
    for (const card of cards) {
      const missing = card.status !== "dropped" && !written.has(card.id);
      console.log(`${cardLine(card)}${missing ? "  [no walkthrough yet]" : ""}`);
      for (const d of card.drift ?? []) console.log(`    differs: ${describeDrift(d)}`);
      if (!opts.drift) for (const n of card.notes ?? []) console.log(`    note: ${n}`);
    }
    return 0;
  });
}

export interface OutlineNoteOptions extends Print {
  configPath: string;
  id: string;
  text: string;
  expected?: string;
  seen?: string;
  step?: string;
}

export async function runOutlineNote(opts: OutlineNoteOptions): Promise<number> {
  return withOutline(opts.configPath, opts.json, (file, config) => {
    const result = noteOutline(config, opts.id, opts.text, { expected: opts.expected, seen: opts.seen, step: opts.step });
    if (!result) return failWith(opts.json, `no outline at ${file}`);
    const { drift, added } = result;
    if (opts.json) console.log(JSON.stringify({ ok: true, file, id: opts.id, ...(drift ? { drift } : {}), ...(added ? { added } : {}) }));
    else {
      if (added) console.log(`no card for ${opts.id} in the outline; added one (status ${added.status}, title "${added.title}")`);
      console.log(drift ? `noted on ${opts.id}: differs: ${describeDrift(drift)}` : `noted on ${opts.id}`);
    }
    return 0;
  });
}

export interface OutlineCheckOptions extends Print {
  configPath: string;
  ids: string[];
}

export async function runOutlineCheck(opts: OutlineCheckOptions): Promise<number> {
  return withOutline(opts.configPath, opts.json, (_file, config) => {
    const result = checkOutline(config, opts.ids);
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, ...result }));
      return 0;
    }
    if (!result.exists) {
      console.log(`no outline yet (${result.file}); nothing to check`);
      return 0;
    }
    const label: Record<string, string> = {
      checked: "",
      "not-written": "no walkthrough yet",
      "not-captured": "not captured yet",
      "capture-failed": "last capture failed, drift not updated",
      dropped: "dropped",
    };
    for (const c of result.cards) {
      const state = label[c.state];
      const summary = state || (c.drift.length ? `${c.drift.length} difference${c.drift.length === 1 ? "" : "s"}` : "matches the screen");
      console.log(`${c.status.padEnd(8)}  ${c.id}  ${summary}${c.cleared.length ? ` (${c.cleared.length} cleared)` : ""}`);
      for (const d of c.drift) console.log(`    differs: ${describeDrift(d)}`);
    }
    return 0;
  });
}

export interface OutlineStatusOptions extends Print {
  configPath: string;
  id: string;
  status: string;
}

export async function runOutlineStatus(opts: OutlineStatusOptions): Promise<number> {
  if (!(OUTLINE_STATUSES as readonly string[]).includes(opts.status)) {
    return failWith(opts.json, `status must be one of ${OUTLINE_STATUSES.join(", ")}`);
  }
  return withOutline(opts.configPath, opts.json, (file) => {
    const found = updateOutline(file, (loaded) => {
      if (!loaded) return false;
      setStatus(loaded.doc, opts.id, opts.status as OutlineStatus);
      return true;
    });
    if (!found) return failWith(opts.json, `no outline at ${file}`);
    if (opts.json) console.log(JSON.stringify({ ok: true, file, id: opts.id, status: opts.status }));
    else console.log(`${opts.id}: ${opts.status}`);
    return 0;
  });
}
