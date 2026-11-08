// Help chat UI (scope.md "Help chat": "On the site and as a drop-in widget inside the app").
// Talks to this app's own /api/chat route — all retrieval/model logic lives in the engine
// package; this component only renders the NDJSON event stream the route forwards
// (packages/engine/src/chat/handler.ts `ChatStreamEvent`). Exported for two uses: inline on the
// site (see app/(site)/layout.tsx) and from a consuming app via a React import (documented in
// this package's README) — `public/widget.js` is the no-build drop-in alternative for apps that
// aren't React.
"use client";

import { useEffect, useRef, useState } from "react";
import { ChatMarkdown, citedNumbers } from "./markdown";

interface Citation {
  n: number;
  url: string;
  title: string;
}

interface ProcedureMeta {
  id: string;
  title: string;
  url: string;
  stepCount: number;
  firstScreenshot?: string;
  firstVideoTimeSec?: number;
}

interface Turn {
  role: "user" | "assistant";
  text: string;
  citations?: Citation[];
  procedures?: ProcedureMeta[];
  error?: string;
  /** The answer has finished streaming (sources are only shown, and saved, once it has). */
  done?: boolean;
}

export interface ChatWidgetProps {
  /** Overrides where the widget posts questions — default "/api/chat" (same-origin: the help
   * site itself). The in-app widget (public/widget.js) sets this to the help site's full
   * origin, since it runs on the user's own app's pages. */
  apiBase?: string;
  /** The in-app page the reader is currently on, so retrieval can boost matching walkthroughs
   * (scope.md "Help chat": "Inside the app it knows which screen the user is on"). Defaults to
   * `location.pathname` when running in the browser. */
  currentPath?: string;
  /** Panel heading, e.g. "Acme Events help". */
  title?: string;
}

/**
 * Resolves the help site's own origin from `apiBase` (review finding ChatWidget.tsx:146,139):
 * citation `url`s and a procedure's `firstScreenshot` come back as root-relative paths on the
 * help site (e.g. "/add-competitor", "/screenshots/add-competitor/step-01.png"). Rendered inline
 * on the help site itself that's correct, but the in-app widget (`public/widget.js`) embeds this
 * component on a *different* origin — the host app's own pages — where a root-relative `href`/
 * `src` resolves against the host app instead of the help site and 404s. `apiBase` already
 * carries the help site's full origin in that case (see `ChatWidgetProps.apiBase`), so derive it
 * from there instead of adding a second prop. Returns `undefined` outside the browser (SSR) or
 * for an unparseable `apiBase` — callers then leave the path unprefixed rather than throw.
 */
export function helpSiteOrigin(apiBase: string): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return new URL(apiBase, window.location.href).origin;
  } catch {
    return undefined;
  }
}

/** Prefixes a root-relative help-site path with `origin` (a no-op when `path` is already an
 * absolute URL, or when `origin` couldn't be resolved). */
export function withOrigin(path: string, origin: string | undefined): string {
  if (!origin || /^[a-z][a-z0-9+.-]*:/i.test(path)) return path;
  return `${origin}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Where a Tab keydown on the dialog should redirect focus, so it loops inside the dialog
 * instead of escaping to the page behind it (WCAG 2.2 AA focus trap) — the pure decision, kept
 * apart from the DOM lookups (`querySelectorAll`, `document.activeElement`) so it's testable
 * without a browser. `isFirstFocused`/`isLastFocused` say whether the dialog's first/last
 * focusable element currently has focus. */
export type FocusRedirect = "first" | "last" | "none";
export function focusTrapRedirect(key: string, shiftKey: boolean, isFirstFocused: boolean, isLastFocused: boolean): FocusRedirect {
  if (key !== "Tab") return "none";
  if (shiftKey && isFirstFocused) return "last";
  if (!shiftKey && isLastFocused) return "first";
  return "none";
}

/** Focusable elements inside `root`, in DOM (tab) order — the dialog's own close/new-chat
 * buttons, citation/guide links, and the question input and send button. */
const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

async function* parseNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) yield JSON.parse(line) as Record<string, unknown>;
    }
  }
}

// `aida publish --to static` sets this at build time (engine's publish/hosts/static.ts) —
// a static export has no server to run /api/chat on, so the widget hides itself instead of
// showing a button that always 501s on click.
const CHAT_UNAVAILABLE = process.env.NEXT_PUBLIC_AIDA_STATIC_EXPORT === "1";

// The conversation is kept in sessionStorage so it survives moving between pages — full page
// loads included (guide links, the host app's own navigation) — and clears when the tab closes.
const STORAGE_KEY = "aida-help-chat";

interface SavedChat {
  open: boolean;
  turns: Turn[];
}

function loadChat(): SavedChat | undefined {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const saved = JSON.parse(raw) as SavedChat;
    // Drop an answer that was still streaming when the page changed.
    const turns = (saved.turns ?? []).filter((t) => t.role === "user" || t.done);
    while (turns.length > 0 && turns[turns.length - 1].role === "user") turns.pop();
    return { open: Boolean(saved.open), turns };
  } catch {
    return undefined;
  }
}

function saveChat(chat: SavedChat) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(chat));
  } catch {
    // Storage full or blocked (private mode): the chat still works, it just won't persist.
  }
}

/** The model-facing history: completed question/answer pairs only, so it always alternates. */
function historyFrom(turns: Turn[]): { role: "user" | "assistant"; content: string }[] {
  const history: { role: "user" | "assistant"; content: string }[] = [];
  for (let i = 0; i + 1 < turns.length; i++) {
    const q = turns[i];
    const a = turns[i + 1];
    if (q.role === "user" && a.role === "assistant" && a.done && a.text && !a.error) {
      history.push({ role: "user", content: q.text }, { role: "assistant", content: a.text });
      i++;
    }
  }
  return history;
}

function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function ChatWidget({ apiBase = "/api/chat", currentPath, title = "Help chat" }: ChatWidgetProps) {
  if (CHAT_UNAVAILABLE) return null;
  /* eslint-disable react-hooks/rules-of-hooks -- CHAT_UNAVAILABLE is a build-time constant
   * (inlined by Next from NEXT_PUBLIC_AIDA_STATIC_EXPORT), never toggles at runtime. */
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const wasOpen = useRef(false);
  const wasBusy = useRef(false);
  const origin = helpSiteOrigin(apiBase);

  // Restore after mount (not during render) so server and client markup match.
  useEffect(() => {
    const saved = loadChat();
    if (saved) {
      setTurns(saved.turns);
      setOpen(saved.open);
    }
    setRestored(true);
  }, []);

  useEffect(() => {
    if (restored && !busy) saveChat({ open, turns });
  }, [restored, busy, open, turns]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, open]);

  // Return focus to the toggle button whenever the dialog closes (Escape, the close button, or
  // programmatically) — WCAG 2.2 AA focus management, so closing the dialog doesn't drop focus
  // back to the top of the page.
  useEffect(() => {
    if (wasOpen.current && !open) toggleRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  // Escape closes the dialog even when focus isn't inside it — review finding: the question
  // input used to go `disabled` while busy, which drops focus to `<body>` (outside the dialog's
  // own onKeyDown), so Escape silently stopped working mid-answer. A document-level listener
  // (scoped to `open`) doesn't depend on where focus currently is.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Refocus the question input once an answer finishes — defensive, in case focus moved away
  // while `readOnly` (below) blocked typing; the input itself never loses focus just by going
  // `readOnly` (unlike `disabled`, which this used to be).
  useEffect(() => {
    if (wasBusy.current && !busy) inputRef.current?.focus();
    wasBusy.current = busy;
  }, [busy]);
  /* eslint-enable react-hooks/rules-of-hooks */

  async function ask(q: string) {
    if (!q.trim() || busy) return;
    const history = historyFrom(turns);
    setBusy(true);
    setTurns((t) => [...t, { role: "user", text: q }, { role: "assistant", text: "" }]);

    try {
      const res = await fetch(apiBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: q,
          currentPath: currentPath ?? (typeof location !== "undefined" ? location.pathname : undefined),
          history,
        }),
      });

      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({ error: `request failed (${res.status})` }));
        setTurns((t) => replaceLastAssistant(t, { role: "assistant", text: "", error: body.error ?? "something went wrong", done: true }));
        return;
      }

      let answer = "";
      for await (const event of parseNdjson(res.body)) {
        if (event.type === "meta") {
          setTurns((t) =>
            replaceLastAssistant(t, { role: "assistant", text: answer, citations: event.citations as Citation[], procedures: event.procedures as ProcedureMeta[] | undefined }),
          );
        } else if (event.type === "delta") {
          answer += event.text as string;
          setTurns((t) => replaceLastAssistant(t, { ...lastAssistant(t), text: answer }));
        } else if (event.type === "error") {
          setTurns((t) => replaceLastAssistant(t, { ...lastAssistant(t), error: event.message as string }));
        }
      }
      setTurns((t) => replaceLastAssistant(t, { ...lastAssistant(t), done: true }));
    } catch {
      setTurns((t) => replaceLastAssistant(t, { role: "assistant", text: "", error: "couldn't reach help chat", done: true }));
    } finally {
      setBusy(false);
    }
  }

  function lastAssistant(t: Turn[]): Turn {
    return t[t.length - 1] ?? { role: "assistant", text: "" };
  }
  function replaceLastAssistant(t: Turn[], next: Turn): Turn[] {
    return [...t.slice(0, -1), next];
  }

  const empty = turns.length === 0;
  const href = (url: string) => withOrigin(url, origin);
  // Announces once an answer finishes (not every streamed delta) — a polite live region, not
  // the full answer text (already readable in the bubble; errors get their own role="alert").
  const lastTurn = turns[turns.length - 1];
  const liveAnnouncement = lastTurn && lastTurn.role === "assistant" && lastTurn.done && !lastTurn.error ? "Answer ready." : "";
  const panelId = "aida-help-chat-panel";

  return (
    <div className="not-prose fixed bottom-4 right-4 z-50 text-sm print:hidden">
      {open ? (
        <div
          ref={dialogRef}
          id={panelId}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          onKeyDown={(e) => {
            // Escape is handled by the document-level listener above (it has to be: this handler
            // only ever sees the key when focus is still inside the dialog).
            if (e.key === "Tab" && dialogRef.current) {
              const focusables = focusableElements(dialogRef.current);
              const first = focusables[0];
              const last = focusables[focusables.length - 1];
              if (!first || !last) return;
              const redirect = focusTrapRedirect(e.key, e.shiftKey, document.activeElement === first, document.activeElement === last);
              if (redirect === "first") {
                e.preventDefault();
                first.focus();
              } else if (redirect === "last") {
                e.preventDefault();
                last.focus();
              }
            }
          }}
          className="flex h-[min(36rem,calc(100vh-2rem))] w-[min(26rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-[calc(var(--brand-radius,0.5rem)+6px)] border border-fd-border bg-fd-background shadow-2xl"
        >
          <div className="flex items-center gap-3 border-b border-fd-border bg-fd-card px-4 py-3">
            <span className="flex size-8 items-center justify-center rounded-full bg-fd-primary text-fd-primary-foreground">
              <ChatIcon />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">{title}</div>
              <div className="truncate text-xs text-fd-muted-foreground">Answers come from these help guides</div>
            </div>
            {!empty && !busy ? (
              <button
                type="button"
                onClick={() => {
                  // Review finding: this button disappears once `turns` is empty (the `!empty`
                  // guard above), which drops focus to the body if it was focused when clicked —
                  // move focus to the question input instead, same as closing it any other way.
                  setTurns([]);
                  inputRef.current?.focus();
                }}
                aria-label="Start a new chat"
                title="New chat"
                className="rounded-md p-1.5 text-fd-muted-foreground hover:bg-fd-accent hover:text-fd-foreground"
              >
                <NewChatIcon />
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close help chat"
              className="rounded-md p-1.5 text-fd-muted-foreground hover:bg-fd-accent hover:text-fd-foreground"
            >
              <CloseIcon />
            </button>
          </div>
          {/* Visually hidden; announces once an answer finishes, not every streamed token. */}
          <div aria-live="polite" aria-atomic="true" className="sr-only">
            {liveAnnouncement}
          </div>
          <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
            {empty ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-fd-muted-foreground">
                <span className="flex size-10 items-center justify-center rounded-full bg-fd-primary/10 text-fd-primary-text">
                  <ChatIcon />
                </span>
                <p className="font-medium text-fd-foreground">Ask a question</p>
                <p className="max-w-[16rem] text-xs">
                  For example, “How do I record a payment?” You&apos;ll get a short answer and a link to the guide.
                </p>
              </div>
            ) : null}
            {turns.map((turn, i) =>
              turn.role === "user" ? (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-fd-primary px-3 py-2 text-fd-primary-foreground">
                    {turn.text}
                  </div>
                </div>
              ) : (
                <AssistantTurn key={i} turn={turn} thinking={busy && i === turns.length - 1} href={href} />
              ),
            )}
          </div>
          <form
            className="flex items-center gap-2 border-t border-fd-border bg-fd-card p-3"
            onSubmit={(e) => {
              e.preventDefault();
              const q = question;
              setQuestion("");
              void ask(q);
            }}
          >
            <input
              ref={inputRef}
              className="min-w-0 flex-1 rounded-full border border-fd-border bg-fd-background px-4 py-2 outline-none focus:border-fd-primary focus:ring-2 focus:ring-fd-primary/20"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask a question…"
              aria-label="Ask the help chat"
              // Not `disabled`: a disabled input is removed from the tab order and, if it had
              // focus (the common case — this is autoFocused), the browser drops focus to
              // `<body>` on submit. That broke Escape (the dialog's own onKeyDown never saw it
              // again) and let Tab walk straight out of the aria-modal dialog. `readOnly` blocks
              // editing while busy without any of that — the input stays focused and tabbable;
              // the send button (below) is still the thing that actually guards against a
              // double-submit.
              readOnly={busy}
              aria-disabled={busy}
              autoFocus
            />
            <button
              type="submit"
              aria-label="Send"
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-fd-primary text-fd-primary-foreground transition hover:opacity-90 disabled:opacity-50"
              disabled={busy || !question.trim()}
            >
              <SendIcon />
            </button>
          </form>
        </div>
      ) : (
        <button
          ref={toggleRef}
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Ask a question"
          aria-expanded={false}
          aria-controls={panelId}
          className="inline-flex items-center gap-2 rounded-full bg-fd-primary p-3 font-medium text-fd-primary-foreground shadow-lg transition hover:-translate-y-0.5 hover:shadow-xl motion-reduce:hover:translate-y-0 sm:py-2.5 sm:pe-4 sm:ps-3"
        >
          <ChatIcon />
          <span className="hidden sm:inline">{empty ? "Ask a question" : "Continue chat"}</span>
        </button>
      )}
    </div>
  );
}

/** One answer: the text, then — once it has finished — only the guides it actually cited, in
 * citation order. A walkthrough gets a card (first screenshot, step count, video); any other
 * page a link. */
function AssistantTurn({ turn, thinking, href }: { turn: Turn; thinking: boolean; href: (url: string) => string }) {
  const cited = citedNumbers(turn.text);
  const sources = turn.done ? (turn.citations ?? []).filter((c) => cited.has(c.n)) : [];
  const procedureFor = (c: Citation) => turn.procedures?.find((p) => p.url === c.url);
  const guides = sources.filter(procedureFor);
  const others = sources.filter((c) => !procedureFor(c));

  return (
    <div className="flex flex-col items-start gap-2">
      <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-fd-muted px-3 py-2 text-fd-foreground">
        {turn.text ? (
          <ChatMarkdown text={turn.text} citations={turn.citations} href={href} />
        ) : thinking ? (
          <span className="inline-flex gap-1 py-1" role="status" aria-label="Thinking">
            <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.3s] motion-reduce:animate-none" />
            <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.15s] motion-reduce:animate-none" />
            <span className="size-1.5 animate-bounce rounded-full bg-current motion-reduce:animate-none" />
          </span>
        ) : null}
        {turn.error ? (
          <div role="alert" className="text-red-600 dark:text-red-400">
            {turn.error}
          </div>
        ) : null}
      </div>
      {guides.map((c) => {
        const proc = procedureFor(c)!;
        return (
          <a
            key={c.n}
            href={href(c.url)}
            className="group flex w-[92%] items-center gap-3 rounded-xl border border-fd-border bg-fd-card p-2 transition hover:border-fd-primary/50"
          >
            {proc.firstScreenshot ? (
              <img src={href(proc.firstScreenshot)} alt="" className="h-14 w-20 shrink-0 rounded-md border border-fd-border object-cover object-top" />
            ) : null}
            <span className="min-w-0 flex-1">
              <span className="line-clamp-2 font-medium leading-snug group-hover:text-fd-primary-text">
                {guides.length > 1 ? <span className="me-1 text-fd-primary-text">{c.n}</span> : null}
                {c.title}
              </span>
              <span className="mt-0.5 block text-xs text-fd-muted-foreground">
                {proc.stepCount ? `${proc.stepCount} steps` : "Guide"}
                {proc.firstVideoTimeSec !== undefined ? " · with video" : ""}
                {" · "}
                <span className="whitespace-nowrap text-fd-primary-text">Open guide →</span>
              </span>
            </span>
          </a>
        );
      })}
      {others.length > 0 ? (
        <div className="flex max-w-[92%] flex-wrap items-center gap-1.5 text-xs text-fd-muted-foreground">
          <span>{guides.length > 0 ? "Also see" : "From"}</span>
          {others.map((c) => (
            <a
              key={c.n}
              href={href(c.url)}
              className="rounded-full border border-fd-border bg-fd-card px-2.5 py-1 text-fd-foreground hover:border-fd-primary/50 hover:text-fd-primary-text"
            >
              {c.title}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Inline icons, so this file stays copy-and-paste portable (no icon library needed).
function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function NewChatIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" />
    </svg>
  );
}
