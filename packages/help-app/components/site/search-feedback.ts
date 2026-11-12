// Records a site search that found nothing (M47), so `aida suggest` can show what readers look
// for and can't find, with no chat key. Never per keystroke: a query is recorded once the reader
// pauses on it or closes the dialog with it showing, and each distinct query once per session.
import { QUERY_MAX, searchKey } from "./feedback-client";

/** How long a reader has to stop typing before a no-result query counts. Long enough that
 * "invo" on the way to "invoices" isn't recorded. */
export const SEARCH_PAUSE_MS = 1500;

/** Shorter queries are usually a word half typed. */
export const SEARCH_MIN_CHARS = 3;

export interface SearchMissRecorderOptions {
  send(query: string): void;
  /** Checked before anything is queued or sent: false while the owner's switch is off (or not
   * yet known) or this session found the route missing. Default: always on. */
  isEnabled?: () => boolean;
  isRecorded(key: string): boolean;
  markRecorded(key: string): void;
  pauseMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export class SearchMissRecorder {
  private pending: { query: string; key: string } | undefined;
  private timer: unknown;

  constructor(private readonly opts: SearchMissRecorderOptions) {}

  /** Call whenever the query or its results change. `resultCount` undefined: the index is
   * still loading, so nothing is known yet. */
  update(query: string, resultCount: number | undefined): void {
    this.cancel();
    if (this.opts.isEnabled && !this.opts.isEnabled()) return;
    const trimmed = query.trim();
    if (resultCount === undefined || resultCount > 0 || trimmed.length < SEARCH_MIN_CHARS) return;
    const key = searchKey(trimmed);
    if (!key || this.opts.isRecorded(key)) return;
    this.pending = { query: trimmed.slice(0, QUERY_MAX), key };
    this.timer = (this.opts.setTimer ?? setTimeout)(() => this.flush(), this.opts.pauseMs ?? SEARCH_PAUSE_MS);
  }

  /** The dialog closed: record what it was showing now rather than waiting out the pause. */
  flush(): void {
    const pending = this.pending;
    this.cancel();
    if (!pending || this.opts.isRecorded(pending.key)) return;
    if (this.opts.isEnabled && !this.opts.isEnabled()) return;
    this.opts.markRecorded(pending.key);
    this.opts.send(pending.query);
  }

  /** Drop the pending query without recording it. */
  cancel(): void {
    if (this.timer !== undefined) (this.opts.clearTimer ?? clearTimeout)(this.timer as ReturnType<typeof setTimeout>);
    this.timer = undefined;
    this.pending = undefined;
  }
}
