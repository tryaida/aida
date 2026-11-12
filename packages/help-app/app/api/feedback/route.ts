// Reader feedback (M47): "Was this helpful?" votes from guide pages, and searches that found
// nothing from the site search and the in-app widget. Works without a chat key. All the logic
// (validation, redaction, rate limits, origin allowlist, storage) is in the engine's feedback
// module; this route only reads the two settings files `aida build` writes into public/ and
// hands the request over. Rate limits are feedback's own (lower than the chat's). Deep imports, not the package barrel, for the same bundling reason as
// app/api/chat/route.ts.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CHAT_CONFIG, type ResolvedChatConfig } from "aida-docs/dist/chat/index.js";
import { handleFeedbackOptions, handleFeedbackPost, readFeedbackConfig } from "aida-docs/dist/feedback/index.js";

export const runtime = "nodejs";

const PUBLIC_DIR = join(process.cwd(), "public");

/** The origin allowlist and trusted proxy header are the chat's (chat-config.json), so an owner
 * sets the widget's app origin once for both. */
async function chatConfig(): Promise<ResolvedChatConfig> {
  try {
    return { ...DEFAULT_CHAT_CONFIG, ...(JSON.parse(await readFile(join(PUBLIC_DIR, "chat-config.json"), "utf8")) as Partial<ResolvedChatConfig>) };
  } catch {
    return DEFAULT_CHAT_CONFIG;
  }
}

export async function POST(request: Request): Promise<Response> {
  const chat = await chatConfig();
  const feedback = readFeedbackConfig(PUBLIC_DIR);
  return handleFeedbackPost(request, {
    enabled: feedback.enabled,
    siteOrigin: feedback.siteOrigin,
    allowedOrigins: chat.allowedOrigins,
    trustProxyHeader: chat.trustProxyHeader,
  });
}

export async function OPTIONS(request: Request): Promise<Response> {
  const chat = await chatConfig();
  return handleFeedbackOptions(request, { enabled: readFeedbackConfig(PUBLIC_DIR).enabled, allowedOrigins: chat.allowedOrigins });
}
