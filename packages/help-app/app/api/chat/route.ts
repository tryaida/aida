// Help chat (scope.md "The help app" / "What it produces": "Answers cite the page, show the
// step's screenshot and jump to the right moment in the video"). All judgment logic lives in
// the engine (`aida` package's `chat/` module) — this route only: reads the pre-resolved chat
// config + the site's own search-index.json/procedures.json off disk, adapts the engine's NDJSON
// event stream to a `Response`, and applies CORS for the in-app widget (build-plan.md M15 steps
// 4 and 6).
//
// Deep imports (not the "aida-docs" package barrel): the barrel's index.ts re-exports the capture/
// voice/config modules too, and config/load.ts does a non-literal dynamic `import()` (via tsx,
// to read an arbitrary aida.config.ts) that Turbopack/webpack can't trace statically, which
// breaks bundling this route — same fix Studio's app/studio/_lib/server.ts already applies.
// That's also why this route never calls `loadConfig` itself: `config.chat`/`config.models` are
// resolved once at build time (build/index-stage.ts, from `aida build`) into
// `public/chat-config.json`, which this route reads the same plain way it reads search-index.json
// and procedures.json — no engine config loader needed at request time at all.
import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  handleChatRequest,
  resolveCorsOrigin,
  CORS_HEADERS_FOR,
  DEFAULT_CHAT_CONFIG,
  type ChatRequest,
  type ChatStreamEvent,
  type ResolvedChatConfig,
} from "aida-docs/dist/chat/index.js";
import { isUnknownVersionError, resolveVersionSource } from "aida-docs/dist/versions/index.js";
import { brand } from "@/lib/brand";

// Node runtime (not edge): reads public/*.json off disk, and the Anthropic SDK's streaming
// client needs Node's fetch/stream primitives, not the edge runtime's restricted subset.
export const runtime = "nodejs";

// `aida publish --to static` sets this before `next build` (static export can't serve a
// dynamic POST route at all — scope.md "Swappable providers": chat/MCP work on every host
// "except" a static export). Checked first so a static site never even attempts retrieval.
const STATIC_EXPORT = process.env.AIDA_STATIC_EXPORT === "1";

async function readJson<T>(relPath: string): Promise<T | undefined> {
  try {
    const raw = await readFile(join(process.cwd(), "public", relPath), "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

async function getChatConfig(): Promise<ResolvedChatConfig> {
  const config = (await readJson<ResolvedChatConfig>("chat-config.json")) ?? DEFAULT_CHAT_CONFIG;
  // The assistant introduces itself by the product's name — config first, else the brand.
  return { ...config, appName: config.appName ?? (brand.name === "Help" ? undefined : brand.name) };
}

// Headers a hosting platform sets itself (never the originating client) ahead of any proxy the
// request passes through on its way in — checked in this order before falling back to
// `X-Forwarded-For`. Review finding route.ts:56 + chat/rate-limit.ts:10: keying the rate limiter
// on the client-controlled *first* hop of `X-Forwarded-For` let any client claim any IP, so one
// attacker could dodge the per-IP limit (new "IP" per request) or weaponize it (frame another
// client's real IP and get it rate-limited).
const TRUSTED_PLATFORM_HEADERS = ["x-vercel-forwarded-for", "x-real-ip", "x-nf-client-connection-ip", "cf-connecting-ip"];

/**
 * The client IP to key chat's rate limiter on. Prefers, in order: `chatConfig.trustProxyHeader`
 * (set only when the deployment's own reverse proxy is known to set it — never trust this for an
 * arbitrary unconfigured header), then the first present platform header in
 * `TRUSTED_PLATFORM_HEADERS`, then the *last* hop of `X-Forwarded-For` — the hop the nearest
 * proxy appended, not the client-supplied first one. "unknown" when none of the above is present
 * (e.g. local dev with no proxy in front at all).
 */
function clientIdFor(request: Request, trustProxyHeader: string | undefined): string {
  if (trustProxyHeader) {
    const trusted = request.headers.get(trustProxyHeader);
    if (trusted) return trusted.split(",")[0]!.trim();
  }
  for (const header of TRUSTED_PLATFORM_HEADERS) {
    const value = request.headers.get(header);
    if (value) return value.trim();
  }
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",").map((h) => h.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return "unknown";
}

function corsHeaders(request: Request, allowedOrigins: string[]): HeadersInit {
  const origin = resolveCorsOrigin(request.headers.get("origin"), allowedOrigins);
  return origin ? CORS_HEADERS_FOR(origin) : {};
}

function toNdjsonStream(events: AsyncIterable<ChatStreamEvent>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      try {
        for await (const event of events) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
      } catch (err) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: "error", message: (err as Error).message })}\n`));
      } finally {
        controller.close();
      }
    },
  });
}

export async function OPTIONS(request: Request): Promise<Response> {
  const chatConfig = STATIC_EXPORT ? DEFAULT_CHAT_CONFIG : await getChatConfig();
  const headers = corsHeaders(request, chatConfig.allowedOrigins);
  return new Response(null, { status: 204, headers });
}

export async function POST(request: Request): Promise<Response> {
  if (STATIC_EXPORT) {
    return NextResponse.json({ error: "help chat is not available on a static export" }, { status: 501 });
  }

  const chatConfig = await getChatConfig();
  const headers = corsHeaders(request, chatConfig.allowedOrigins);

  let body: ChatRequest;
  try {
    body = (await request.json()) as ChatRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400, headers });
  }

  // Versioned docs (build-plan.md M21 step 3): `body.version` names a frozen snapshot from
  // `versions.json`, or is omitted/"latest" for the current build. An unknown name is a clear
  // 400 listing every version that does exist, not a silent fall-back to latest.
  const versionSource = resolveVersionSource(join(process.cwd(), "public"), body.version);
  if (isUnknownVersionError(versionSource)) {
    return NextResponse.json({ error: versionSource.error, availableVersions: versionSource.availableVersions }, { status: 400, headers });
  }

  const result = await handleChatRequest({
    request: body,
    config: chatConfig,
    searchIndexEntries: versionSource.searchIndexEntries,
    procedures: versionSource.procedures,
    apiKey: process.env.ANTHROPIC_API_KEY,
    clientId: clientIdFor(request, chatConfig.trustProxyHeader),
    onUsage: (usage) => {
      // "log token usage per request (input/output/cache read) to server log in a compact line"
      // eslint-disable-next-line no-console
      console.log(`[aida:chat] ${JSON.stringify(usage)}`);
    },
  });

  if (result.status !== 200) {
    return NextResponse.json(result.body, { status: result.status, headers });
  }

  return new Response(toNdjsonStream(result.stream), {
    status: 200,
    headers: { ...headers, "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function GET(): Promise<Response> {
  return NextResponse.json({ error: "use POST {question, currentPath?, history?, version?}" }, { status: 405 });
}
