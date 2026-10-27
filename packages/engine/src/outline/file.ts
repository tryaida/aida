// Reading and writing `outline.yaml` through `yaml`'s Document API, so a person's comments and
// formatting survive every write (same approach as edit/yaml-doc.ts for walkthroughs).
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import * as YAML from "yaml";
import { OutlineFileSchema, type DriftEntry, type OutlineCard, type OutlineFile, type OutlineStatus } from "./schema.js";

export class OutlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutlineError";
  }
}

/** Just the config fields the outline needs, so tests can pass a plain object. */
export interface OutlineConfigLike {
  configDir: string;
  walkthroughsDir: string;
  outline?: string;
}

/** Config `outline` (relative to the config file), else `outline.yaml` next to the walkthroughs dir. */
export function outlinePath(config: OutlineConfigLike): string {
  if (config.outline) return isAbsolute(config.outline) ? config.outline : join(config.configDir, config.outline);
  return join(dirname(config.walkthroughsDir), "outline.yaml");
}

export interface LoadedOutline {
  file: string;
  doc: YAML.Document.Parsed;
  outline: OutlineFile;
}

const HEADER =
  " Outline cards (aida outline). One card per planned walkthrough; `id` becomes the walkthrough id.\n" +
  " Capture records where a card's on-screen names differ from the real screen under `drift`.";

/** Parses and validates `text`; throws `OutlineError` with line numbers on a bad file. */
export function parseOutline(text: string, file = "outline.yaml"): { doc: YAML.Document.Parsed; outline: OutlineFile } {
  const lineCounter = new YAML.LineCounter();
  const doc = YAML.parseDocument(text, { lineCounter, prettyErrors: true });
  if (doc.errors.length > 0) throw new OutlineError(`${file}: ${doc.errors[0].message}`);
  const raw = (doc.toJS() as unknown) ?? {};
  const result = OutlineFileSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const node = issue.path.length > 0 ? doc.getIn(issue.path, true) : undefined;
      const range = node && typeof node === "object" && "range" in node ? (node as { range?: [number, number, number] }).range : undefined;
      const loc = range ? `${file}:${lineCounter.linePos(range[0]).line}` : file;
      return `${loc}: ${issue.message}${issue.path.length ? ` (at ${issue.path.join(".")})` : ""}`;
    });
    throw new OutlineError(lines.join("\n"));
  }
  return { doc, outline: result.data as OutlineFile };
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** How many times, and how far apart, a reader retries a file that doesn't parse: another
 * writer (an older aida, an editor) may be half-way through a non-atomic write. */
const READ_RETRIES = 4;
const READ_RETRY_MS = 40;

/**
 * `null` when there's no outline file: callers treat that as "nothing to do". A file that doesn't
 * parse is re-read a few times before the error is thrown, so a reader racing a writer that
 * isn't atomic sees the finished file rather than a half-written one.
 */
export function readOutline(file: string): LoadedOutline | null {
  for (let attempt = 0; ; attempt++) {
    if (!existsSync(file)) return null;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    try {
      return { file, ...parseOutline(text, file) };
    } catch (err) {
      if (!(err instanceof OutlineError) || attempt >= READ_RETRIES) throw err;
      sleepMs(READ_RETRY_MS * (attempt + 1));
    }
  }
}

/** Reads the outline, or starts an empty one (with a header comment) when the file doesn't exist. */
export function readOrCreateOutline(file: string): LoadedOutline {
  const existing = readOutline(file);
  if (existing) return existing;
  const doc = YAML.parseDocument("cards: []\n");
  doc.commentBefore = HEADER;
  return { file, doc, outline: { cards: [] } };
}

/** Writes `text` to a temp file next to `file`, then renames it over `file`: a reader sees the
 * old file or the new one, never half of one. */
function writeAtomic(file: string, text: string): void {
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`);
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
    throw err;
  }
}

/**
 * Validates the edited document, then writes it atomically. Never writes an invalid file. Callers
 * that read, change and write should do it inside `updateOutline` (or `withOutlineLock`) so two
 * aida processes can't overwrite each other's change.
 */
export function writeOutline(loaded: LoadedOutline): OutlineFile {
  const text = loaded.doc.toString();
  const { outline } = parseOutline(text, loaded.file);
  writeAtomic(loaded.file, text);
  loaded.outline = outline;
  return outline;
}

/** A lock older than this is taken to be left behind by a crashed process. Real updates take
 * milliseconds. */
export const LOCK_STALE_MS = 10_000;
/** How long to wait for another process's lock before giving up. */
const LOCK_WAIT_MS = 20_000;

interface LockInfo {
  pid: number;
  host: string;
  at: number;
  token: string;
}

function readLock(lock: string): { raw: string; info?: LockInfo } | undefined {
  try {
    const raw = readFileSync(lock, "utf8");
    try {
      return { raw, info: JSON.parse(raw) as LockInfo };
    } catch {
      return { raw };
    }
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True when the lock's holder is gone: its pid is dead (same host), or it's older than
 * `LOCK_STALE_MS`. A lock file we can't parse is judged by its age alone. */
function isStale(lock: string, info: LockInfo | undefined, now: number): boolean {
  if (info && typeof info.pid === "number" && info.host === hostname() && !pidAlive(info.pid)) return true;
  const at = info && typeof info.at === "number" ? info.at : undefined;
  if (at !== undefined) return now - at > LOCK_STALE_MS;
  try {
    // An empty/garbled lock (its writer died between open and write): use the file's own mtime.
    const { mtimeMs } = statSync(lock);
    return now - mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/** Removes a stale lock, but only if it's still the same stale lock we looked at. */
function breakStaleLock(lock: string, seenRaw: string): void {
  const aside = `${lock}.stale.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
  // Re-check right before moving it aside, so a lock another process has just taken is left alone.
  if (readLock(lock)?.raw !== seenRaw) return;
  try {
    renameSync(lock, aside);
  } catch {
    return;
  }
  try {
    unlinkSync(aside);
  } catch {
    // ignore
  }
}

/**
 * Runs `fn` holding an exclusive lock on `file` (`<file>.lock`, created with O_EXCL). A lock whose
 * holder has died (same host, pid gone) or that is older than `LOCK_STALE_MS` is broken. Throws
 * `OutlineError` if another live process holds the lock for longer than the wait limit.
 */
export function withOutlineLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const started = Date.now();
  let delay = 5;
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(lock, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    if (fd !== undefined) {
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now(), token } satisfies LockInfo));
      } finally {
        closeSync(fd);
      }
      break;
    }
    const now = Date.now();
    const held = readLock(lock);
    if (held && isStale(lock, held.info, now)) {
      breakStaleLock(lock, held.raw);
      continue;
    }
    if (now - started > LOCK_WAIT_MS) {
      const who = held?.info?.pid ? ` by process ${held.info.pid}` : "";
      throw new OutlineError(`${file} is locked${who}; if no aida command is running, delete ${lock}`);
    }
    sleepMs(delay + Math.floor(Math.random() * delay));
    delay = Math.min(delay * 2, 100);
  }
  try {
    return fn();
  } finally {
    // Only remove the lock if it's still ours (a stale-lock breaker may have replaced it).
    const held = readLock(lock);
    if (held?.info?.token === token) {
      try {
        unlinkSync(lock);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Read-modify-write under the lock: re-reads the file inside the lock, runs `fn`, and writes the
 * document back (atomically) only if `fn` changed it. With `create`, a missing file starts as an
 * empty outline (written only if `fn` adds something); without it, `fn` gets `null` and no lock
 * is taken, so a project without an outline never gets a lock file.
 */
export function updateOutline<T>(file: string, fn: (loaded: LoadedOutline | null) => T, opts: { create?: boolean } = {}): T {
  if (!opts.create && !existsSync(file)) return fn(null);
  return withOutlineLock(file, () => {
    const loaded = opts.create ? readOrCreateOutline(file) : readOutline(file);
    if (!loaded) return fn(null);
    const before = loaded.doc.toString();
    const value = fn(loaded);
    if (loaded.doc.toString() !== before) writeOutline(loaded);
    return value;
  });
}

function cardsSeq(doc: YAML.Document): YAML.YAMLSeq {
  let seq = doc.get("cards", true);
  if (!YAML.isSeq(seq)) {
    seq = new YAML.YAMLSeq();
    doc.set("cards", seq);
  }
  // An empty `cards: []` parses as a flow seq; new cards read better in block style.
  if ((seq as YAML.YAMLSeq).items.length === 0) (seq as YAML.YAMLSeq).flow = false;
  return seq as YAML.YAMLSeq;
}

export function cardNode(doc: YAML.Document, id: string): YAML.YAMLMap | undefined {
  const seq = doc.get("cards", true);
  if (!YAML.isSeq(seq)) return undefined;
  return seq.items.find((item): item is YAML.YAMLMap => YAML.isMap(item) && item.get("id") === id);
}

function requireCard(doc: YAML.Document, id: string): YAML.YAMLMap {
  const node = cardNode(doc, id);
  if (!node) throw new OutlineError(`no card "${id}" in the outline (aida outline list)`);
  return node;
}

/** Sets a scalar in place when one is already there, so its comment stays put. */
function setScalar(map: YAML.YAMLMap, key: string, value: string): void {
  const existing = map.get(key, true);
  if (YAML.isScalar(existing)) existing.value = value;
  else map.set(key, value);
}

/** Appends a card. Throws when the id is taken. */
export function addCard(doc: YAML.Document, card: OutlineCard): void {
  if (cardNode(doc, card.id)) throw new OutlineError(`card "${card.id}" is already in the outline`);
  const plain: Record<string, unknown> = { id: card.id, title: card.title };
  for (const key of ["for", "section", "purpose"] as const) if (card[key]) plain[key] = card[key];
  if (card.labels?.length) plain.labels = card.labels;
  plain.status = card.status;
  if (card.drift?.length) plain.drift = card.drift;
  if (card.notes?.length) plain.notes = card.notes;
  const node = doc.createNode(plain) as YAML.YAMLMap;
  const labels = node.get("labels", true);
  if (YAML.isSeq(labels)) labels.flow = true;
  cardsSeq(doc).items.push(node);
}

export function setStatus(doc: YAML.Document, id: string, status: OutlineStatus): void {
  setScalar(requireCard(doc, id), "status", status);
}

const DRIFT_KEYS = ["expected", "seen", "step", "at", "source"] as const;
const driftKey = (expected: unknown, source: unknown) => `${String(source)}\u0000${String(expected).trim().toLowerCase()}`;

/**
 * Replaces a card's drift list; an empty list removes the key (and any comment on it). An entry
 * that was already there (same `expected` and `source`) keeps its node, so comments on it, on the
 * `drift:` key and between entries survive; only the changed values are rewritten. Comments
 * attached to an entry that is dropped go with it.
 */
export function setDrift(doc: YAML.Document, id: string, drift: DriftEntry[]): void {
  const map = requireCard(doc, id);
  if (drift.length === 0) {
    map.delete("drift");
    return;
  }
  const existing = map.get("drift", true);
  if (!YAML.isSeq(existing)) {
    map.set("drift", doc.createNode(drift.map((d) => ({ ...d }))));
    return;
  }
  const pool = existing.items.filter((item): item is YAML.YAMLMap => YAML.isMap(item));
  const used = new Set<YAML.YAMLMap>();
  existing.items = drift.map((d) => {
    const key = driftKey(d.expected, d.source);
    const node = pool.find((n) => !used.has(n) && driftKey(n.get("expected"), n.get("source")) === key);
    if (!node) return doc.createNode({ ...d });
    used.add(node);
    for (const k of DRIFT_KEYS) {
      const value = d[k];
      if (value === undefined) node.delete(k);
      else if (node.get(k) !== value) setScalar(node, k, value);
    }
    return node;
  });
}

export function appendNote(doc: YAML.Document, id: string, text: string): void {
  const map = requireCard(doc, id);
  const existing = map.get("notes", true);
  if (YAML.isSeq(existing)) {
    existing.items.push(doc.createNode(text));
  } else if (YAML.isScalar(existing)) {
    map.set("notes", doc.createNode([String(existing.value), text]));
  } else {
    map.set("notes", doc.createNode([text]));
  }
}

export function findCard(outline: OutlineFile, id: string): OutlineCard | undefined {
  return outline.cards.find((c) => c.id === id);
}
