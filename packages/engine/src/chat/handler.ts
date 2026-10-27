// The chat handler itself: retrieval -> prompt assembly -> streamed answer -> usage/unanswered
// logging. Framework-agnostic (docs/scope.md "Help app (Next.js scaffold)": "Keep the app thin:
// the logic lives in the engine package") — the help app's route just adapts this to a
// `Response`. See build-plan.md M15 step 4.
import { RealAnthropicChatClient, type AnthropicChatClient } from "./anthropic-client.js";
import { assembleRequest, buildCitations, validateChatInput } from "./prompt.js";
import { retrieve } from "./retrieve.js";
import { RateLimiter } from "./rate-limit.js";
import { defaultUnansweredStore } from "./unanswered.js";
import type { ChatHandlerOptions, ChatStreamEvent, ResolvedChatConfig } from "./types.js";
import type { ChatConfig, ModelTiers } from "../config/index.js";

export const DEFAULT_CHAT_CONFIG: ResolvedChatConfig = {
  model: "claude-haiku-4-5",
  allowedOrigins: [],
  retrievalLimit: 4,
  maxInputTokens: 8000,
  maxOutputTokens: 1024,
  unansweredScoreThreshold: 0.01,
  rateLimitPerMinute: 20,
  globalRateLimitPerMinute: 300,
};

/** Fills in defaults for any `config.chat` field left unset. Chat's own default model is
 * `models.fast` (Haiku 4.5) when set, else the fast-tier default — scope.md "Token efficiency":
 * "help chat answers from retrieved pages" is a fast-tier job. `brief` is the app brief's chat
 * prefix (brief/consumers.ts `briefForChat`), when there is one. */
export function resolveChatConfig(chat: ChatConfig | undefined, models: ModelTiers | undefined, brief?: string): ResolvedChatConfig {
  return {
    model: chat?.model ?? models?.fast ?? DEFAULT_CHAT_CONFIG.model,
    supportContact: chat?.supportContact,
    appName: chat?.appName,
    ...(brief ? { brief } : {}),
    allowedOrigins: chat?.allowedOrigins ?? DEFAULT_CHAT_CONFIG.allowedOrigins,
    retrievalLimit: chat?.retrievalLimit ?? DEFAULT_CHAT_CONFIG.retrievalLimit,
    maxInputTokens: chat?.maxInputTokens ?? DEFAULT_CHAT_CONFIG.maxInputTokens,
    maxOutputTokens: chat?.maxOutputTokens ?? DEFAULT_CHAT_CONFIG.maxOutputTokens,
    unansweredScoreThreshold: chat?.unansweredScoreThreshold ?? DEFAULT_CHAT_CONFIG.unansweredScoreThreshold,
    rateLimitPerMinute: chat?.rateLimitPerMinute ?? DEFAULT_CHAT_CONFIG.rateLimitPerMinute,
    globalRateLimitPerMinute: chat?.globalRateLimitPerMinute ?? DEFAULT_CHAT_CONFIG.globalRateLimitPerMinute,
    trustProxyHeader: chat?.trustProxyHeader,
  };
}

export type ChatHandlerResult =
  | { status: 503; body: { error: string } }
  | { status: 429; body: { error: string } }
  | { status: 400; body: { error: string } }
  | { status: 200; stream: AsyncIterable<ChatStreamEvent> };

const DONT_KNOW_PHRASES = [
  "i don't know",
  "i do not know",
  "i'm not sure",
  "not covered in",
  "don't cover",
  "doesn't cover",
  "don't have information",
];

/** Greetings and thanks ("hi", "thanks!", "good morning") — answered without sources and never
 * logged as unanswered, since there's nothing for the docs to cover. */
const SMALL_TALK = /^(hi|hello|hey|hiya|g'?day|yo|thanks|thank you|thx|cheers|ok|okay|great|good (morning|afternoon|evening))( there| so much| very much| heaps)?[\s!.,:)]*$/i;

export function isSmallTalk(question: string): boolean {
  return SMALL_TALK.test(question.trim());
}

// One limiter per process per configured rate (build-plan.md M15 step 4: "per-IP simple rate
// limit in memory") — reused across requests so each client's bucket actually persists, but
// keyed by `perMinute:globalPerMinute` so a config change (or a test using a different limit)
// doesn't inherit bucket/global-counter state sized for a different budget.
const sharedRateLimiters = new Map<string, RateLimiter>();
function rateLimiterFor(perMinute: number, globalPerMinute: number): RateLimiter {
  const key = `${perMinute}:${globalPerMinute}`;
  let limiter = sharedRateLimiters.get(key);
  if (!limiter) {
    limiter = new RateLimiter(perMinute, Date.now, globalPerMinute);
    sharedRateLimiters.set(key, limiter);
  }
  return limiter;
}

/**
 * Handles one chat request. Returns a non-200 result immediately for: no API key configured
 * (503 — "the site still works" without chat, per decisions.md #40), rate limit exceeded (429),
 * or a missing/oversized/malformed question or history (400 — see `validateChatInput`).
 * Otherwise returns a 200 with an async-iterable NDJSON event stream the caller can forward to
 * the client.
 */
export async function handleChatRequest(opts: ChatHandlerOptions): Promise<ChatHandlerResult> {
  const validationError = validateChatInput(opts.request.question, opts.request.history);
  if (validationError) {
    return { status: 400, body: { error: validationError } };
  }

  if (!opts.apiKey) {
    // scope.md "Swappable providers" chat key default: "Owner's key when self-hosting" — no key
    // configured means chat is simply off; search and the rest of the site are unaffected.
    return { status: 503, body: { error: "help chat is not configured — set ANTHROPIC_API_KEY to enable it" } };
  }

  const limiter = rateLimiterFor(opts.config.rateLimitPerMinute, opts.config.globalRateLimitPerMinute);
  if (!limiter.allow(opts.clientId)) {
    return { status: 429, body: { error: "too many requests — try again in a minute" } };
  }

  const smallTalk = isSmallTalk(opts.request.question);
  const context = smallTalk
    ? { pages: [], topScore: 0 }
    : retrieve(opts.request.question, opts.searchIndexEntries, opts.procedures, {
        currentPath: opts.request.currentPath,
        limit: opts.config.retrievalLimit,
      });
  const citations = buildCitations(context);
  const assembled = assembleRequest(
    opts.config.supportContact,
    context,
    citations,
    opts.request.question,
    opts.request.history,
    opts.config.maxInputTokens,
    opts.config.appName,
    opts.config.brief,
  );

  const client: AnthropicChatClient = (opts.anthropicClient as AnthropicChatClient | undefined) ?? new RealAnthropicChatClient(opts.apiKey);
  const { textChunks, usage } = client.streamMessage(assembled, opts.config.model, opts.config.maxOutputTokens);

  const unansweredStore = opts.unansweredStore ?? defaultUnansweredStore();
  const onUsage = opts.onUsage;
  const belowThreshold = !smallTalk && context.topScore < opts.config.unansweredScoreThreshold;

  async function* events(): AsyncIterable<ChatStreamEvent> {
    yield {
      type: "meta",
      citations,
      procedures: context.pages.flatMap((page) =>
        page.procedure
          ? [
              {
                id: page.procedure.id,
                title: page.procedure.title,
                url: page.url,
                stepCount: page.procedure.steps.length,
                firstScreenshot: page.procedure.steps[0]?.screenshot,
                firstVideoTimeSec: page.procedure.steps[0]?.videoTimeSec,
              },
            ]
          : [],
      ),
    };

    let answer = "";
    try {
      for await (const chunk of textChunks) {
        answer += chunk;
        yield { type: "delta", text: chunk };
      }
    } catch (err) {
      yield { type: "error", message: (err as Error).message ?? "chat model request failed" };
      return;
    }

    const saidDontKnow = !smallTalk && DONT_KNOW_PHRASES.some((p) => answer.toLowerCase().includes(p));
    const unanswered = belowThreshold || saidDontKnow;
    if (unanswered) {
      await unansweredStore.record({ question: opts.request.question, path: opts.request.currentPath, at: new Date().toISOString() });
    }

    try {
      const tokenUsage = await usage;
      onUsage?.(tokenUsage);
      // "log token usage per request (input/output/cache read) to server log in a compact line" —
      // the route handler may also log this itself; logging here too keeps the engine usable
      // standalone (CLI, tests) without a route wrapper.
      // eslint-disable-next-line no-console
      console.log(
        `[aida:chat] model=${tokenUsage.model} input=${tokenUsage.input} output=${tokenUsage.output} cacheRead=${tokenUsage.cacheRead}`,
      );
    } catch {
      // usage promise rejecting (e.g. mock client never resolves it) shouldn't break the stream.
    }

    yield { type: "done", unanswered };
  }

  return { status: 200, stream: events() };
}
