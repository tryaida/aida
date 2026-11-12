// "Was this helpful?" at the end of a guide (M47). Yes sends a vote; No opens one optional field
// and a Send button, and only Send sends the not-helpful vote: nothing goes out when the reader
// leaves, so a No pressed by mistake costs nothing (press Yes, or just move on), and one press
// can never become two entries. One vote per guide per browser session. Hidden in print (the
// engine's PDFs are built from the walkthrough, not this page, so they never carry it). Where
// there's no /api/feedback (a static export, or the owner turned feedback off after this page
// was built), the control removes itself after the first failed send and stays away for the
// session.
"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type Ref } from "react";
import {
  COMMENT_MAX,
  FEEDBACK_UNAVAILABLE,
  feedbackOff,
  hasVoted,
  markFeedbackOff,
  markVoted,
  postFeedback,
  sessionStore,
  type FeedbackBody,
  type KeyValueStore,
  type PostResult,
} from "./feedback-client";

export type FeedbackState = "idle" | "asking" | "sending" | "done" | "voted-before" | "gone";

export const THANKS = "Thanks for your feedback.";
export const NOT_SENT = "That didn't send. Please try again in a minute.";

/** Where the control goes after a send. `asking` is the state to return to when it failed. */
export function afterSend(result: PostResult, asking: boolean): { state: FeedbackState; message: string; off: boolean } {
  if (result === "stored") return { state: "done", message: THANKS, off: false };
  if (result === "unavailable") return { state: "gone", message: "", off: true };
  return { state: asking ? "asking" : "idle", message: NOT_SENT, off: false };
}

/** The state to start in, once the browser's session memory can be read. */
export function initialState(off: boolean, voted: boolean): FeedbackState {
  if (off) return "gone";
  return voted ? "voted-before" : "idle";
}

/** Where focus goes once the state changes: to the thank-you after a stored vote, to the page
 * when the control removes itself from under the focused button (focus would otherwise fall to
 * the top of the document), and nowhere new otherwise: a failed send leaves focus on the button
 * that was pressed, which stays focusable while sending (`aria-disabled`, never `disabled`). */
export function focusAfter(state: FeedbackState, focusInside: boolean): "status" | "page" | "none" {
  if (state === "done") return "status";
  if (state === "gone" && focusInside) return "page";
  return "none";
}

export interface VoteView {
  state: FeedbackState;
  message: string;
  fieldOpen: boolean;
}

export interface VoteFlowDeps {
  page: string;
  post: (body: FeedbackBody) => Promise<PostResult>;
  store: () => KeyValueStore | undefined;
  onChange?: (view: VoteView) => void;
}

/**
 * The control's behaviour without React, so it can be tested: what each press sends, and the
 * rules that keep it to one vote per page per session. A send already in flight, or a page
 * already voted on (here, in another tab, or before the browser restored this page from its
 * back-forward cache), sends nothing.
 */
export class VoteFlow {
  view: VoteView;
  private inFlight = false;

  constructor(private readonly deps: VoteFlowDeps) {
    const store = deps.store();
    this.view = { state: initialState(feedbackOff(store), hasVoted(store, deps.page)), message: "", fieldOpen: false };
  }

  private set(next: Partial<VoteView>): void {
    this.view = { ...this.view, ...next };
    this.deps.onChange?.(this.view);
  }

  /** Re-reads the session's memory: the page came back from the back-forward cache, or another
   * tab voted on it. */
  refresh(): void {
    if (this.inFlight) return;
    const store = this.deps.store();
    if (feedbackOff(store)) this.set({ state: "gone", fieldOpen: false, message: "" });
    else if (hasVoted(store, this.deps.page) && this.view.state !== "done") this.set({ state: "voted-before", fieldOpen: false, message: "" });
  }

  /** No: opens the optional field. Sends nothing by itself. */
  pressNo(): void {
    if (this.inFlight || !this.canVote()) return;
    this.set({ state: "asking", fieldOpen: true, message: "" });
  }

  pressYes(): Promise<void> {
    return this.send({ kind: "helpful", page: this.deps.page });
  }

  /** Send: the not-helpful vote, with the comment when there is one. */
  submit(comment: string): Promise<void> {
    const text = comment.trim().slice(0, COMMENT_MAX);
    return this.send(text ? { kind: "not-helpful", page: this.deps.page, comment: text } : { kind: "not-helpful", page: this.deps.page });
  }

  private canVote(): boolean {
    const { state } = this.view;
    return state === "idle" || state === "asking";
  }

  private async send(body: FeedbackBody): Promise<void> {
    if (this.inFlight || !this.canVote()) return;
    if (hasVoted(this.deps.store(), this.deps.page)) {
      this.set({ state: "voted-before", fieldOpen: false, message: "" });
      return;
    }
    const asking = this.view.state === "asking";
    this.inFlight = true;
    this.set({ state: "sending", message: "" });
    let result: PostResult;
    try {
      result = await this.deps.post(body);
    } finally {
      this.inFlight = false;
    }
    const next = afterSend(result, asking);
    const store = this.deps.store();
    if (result === "stored") markVoted(store, this.deps.page);
    if (next.off) markFeedbackOff(store);
    this.set({ state: next.state, message: next.message, fieldOpen: next.state === "asking" });
  }
}

const BUTTON =
  "inline-flex min-h-9 items-center justify-center rounded-[var(--brand-radius)] border border-fd-border bg-fd-card px-4 py-1.5 text-sm font-medium text-fd-foreground shadow-xs transition hover:border-fd-primary/40 hover:text-fd-primary-text aria-disabled:opacity-60 aria-expanded:border-fd-primary/60 motion-reduce:transition-none";

export interface PageFeedbackViewProps {
  view: VoteView;
  comment: string;
  /** Prefix for the element ids (`useId()` in the live control). */
  idBase: string;
  onYes?: () => void;
  onNo?: () => void;
  onComment?: (text: string) => void;
  onSubmit?: (event: FormEvent) => void;
  refs?: {
    section?: Ref<HTMLElement>;
    field?: Ref<HTMLInputElement>;
    status?: Ref<HTMLParagraphElement>;
  };
}

/** The markup for one state. While sending, controls are `aria-disabled` (and the field
 * read-only), not `disabled`: disabling the focused control would drop focus to the document. */
export function PageFeedbackView({ view, comment, idBase, onYes, onNo, onComment, onSubmit, refs }: PageFeedbackViewProps) {
  const { state, message, fieldOpen } = view;
  if (state === "gone") return null;
  const headingId = `${idBase}-heading`;
  const formId = `${idBase}-form`;
  const fieldId = `${idBase}-field`;
  const hintId = `${idBase}-hint`;
  const finished = state === "done" || state === "voted-before";
  const sending = state === "sending";
  const showField = fieldOpen && (state === "asking" || sending);

  return (
    <section
      ref={refs?.section}
      aria-labelledby={headingId}
      data-aida-feedback=""
      className="not-prose mt-12 border-t border-fd-border pt-6 print:hidden"
    >
      <h2 id={headingId} className="text-base font-semibold text-fd-foreground">
        Was this helpful?
      </h2>
      {finished ? null : (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={BUTTON} aria-disabled={sending || undefined} onClick={onYes}>
            Yes
          </button>
          <button
            type="button"
            className={BUTTON}
            aria-disabled={sending || undefined}
            aria-expanded={showField}
            // Only while the form is in the DOM: an id that points at nothing is an error.
            aria-controls={showField ? formId : undefined}
            onClick={onNo}
          >
            No
          </button>
        </div>
      )}
      {showField ? (
        <form id={formId} onSubmit={onSubmit} className="mt-4 flex max-w-xl flex-col gap-2">
          <label htmlFor={fieldId} className="text-sm font-medium text-fd-foreground">
            What were you looking for? <span className="font-normal text-fd-muted-foreground">(optional)</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              ref={refs?.field}
              id={fieldId}
              type="text"
              value={comment}
              maxLength={COMMENT_MAX}
              autoComplete="off"
              readOnly={sending}
              aria-describedby={hintId}
              onChange={(e) => onComment?.(e.target.value)}
              // 3:1 boundary against the page (WCAG 1.4.11): the muted text colour, not the
              // hairline border colour, which is lighter than that.
              className="min-h-9 min-w-0 flex-1 rounded-[var(--brand-radius)] border border-fd-muted-foreground bg-fd-background px-3 py-1.5 text-sm text-fd-foreground"
            />
            <button type="submit" className={BUTTON} aria-disabled={sending || undefined}>
              Send
            </button>
          </div>
          <p id={hintId} className="text-xs text-fd-muted-foreground">
            Please don&apos;t include personal details.
          </p>
        </form>
      ) : null}
      {state === "voted-before" ? <p className="mt-2 text-sm text-fd-foreground">{THANKS}</p> : null}
      {/* Always in the DOM so screen readers announce what goes into it. */}
      <p ref={refs?.status} role="status" tabIndex={-1} className={message ? "mt-2 text-sm text-fd-foreground" : "sr-only"}>
        {message}
      </p>
    </section>
  );
}

/** Moves focus to the guide itself (fumadocs' `#nd-page`, else `main`), for when the control
 * removes itself while it holds focus. */
function focusPage(): void {
  const target = document.getElementById("nd-page") ?? document.querySelector("main");
  if (!(target instanceof HTMLElement)) return;
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus();
}

/** `enabled`: the owner's switch as the guide page read it (`readFeedbackConfig`); false renders
 * nothing. */
export function PageFeedback({ page, enabled = true }: { page: string; enabled?: boolean }) {
  const [view, setView] = useState<VoteView>({ state: "idle", message: "", fieldOpen: false });
  const [comment, setComment] = useState("");
  const flowRef = useRef<VoteFlow | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const focusField = useRef(false);
  const idBase = useId();

  useEffect(() => {
    const flow = new VoteFlow({ page, post: (body) => postFeedback(body), store: sessionStore, onChange: setView });
    flowRef.current = flow;
    setView(flow.view);
    // Back from the back-forward cache: this page's state is as it was left, but the session
    // may have voted on it since (another tab).
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) flow.refresh();
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, [page]);

  useEffect(() => {
    if (view.state === "asking" && focusField.current) {
      focusField.current = false;
      fieldRef.current?.focus();
    }
  }, [view.state]);

  async function act(run: (flow: VoteFlow) => Promise<void>) {
    const flow = flowRef.current;
    if (!flow) return;
    await run(flow);
    const where = focusAfter(flow.view.state, Boolean(sectionRef.current?.contains(document.activeElement)));
    if (where === "status") statusRef.current?.focus();
    // Before React removes the section, while the focused button is still in it.
    if (where === "page") focusPage();
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void act((flow) => flow.submit(comment));
  }

  if (!enabled || FEEDBACK_UNAVAILABLE) return null;

  return (
    <PageFeedbackView
      view={view}
      comment={comment}
      idBase={idBase}
      onYes={() => void act((flow) => flow.pressYes())}
      onNo={() => {
        focusField.current = true;
        flowRef.current?.pressNo();
      }}
      onComment={setComment}
      onSubmit={onSubmit}
      refs={{ section: sectionRef, field: fieldRef, status: statusRef }}
    />
  );
}
