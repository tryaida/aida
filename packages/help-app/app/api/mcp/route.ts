// Agent connector / MCP server (scope.md "What it produces": "Hosted with the site and
// versioned with it"; "Safety and trust": "The MCP server is read-only"). The tool
// implementations live in the engine (`aida`'s `mcp/` module) — this route only mounts them
// over the official MCP SDK's Streamable HTTP transport (build-plan.md M15 step 3).
// Deep import (not the "aida-docs" package barrel) — see app/api/chat/route.ts for why: the
// barrel's index.ts reaches config/load.ts's non-literal dynamic `import()`, which breaks
// bundling a route handler that pulls it in, even transitively.
import { createAidaMcpServer, getPageFromLlmsTxt, type AidaMcpSource } from "aida-docs/dist/mcp/index.js";
import { isUnknownVersionError, resolveVersionSource } from "aida-docs/dist/versions/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const runtime = "nodejs";

// See app/api/chat/route.ts for why this flag exists — static export can't serve this route at
// all (no persistent process to hold MCP session state), so it answers a clear 501 instead of
// whatever Next would otherwise do with a dynamic route in a static build.
const STATIC_EXPORT = process.env.AIDA_STATIC_EXPORT === "1";

/** `public/app-overview.md`: the app brief, trimmed by `aida build` (no brief yet: absent). One per
 * site, not per frozen version. */
function readAppOverview(): string | undefined {
  try {
    return readFileSync(join(process.cwd(), "public", "app-overview.md"), "utf8");
  } catch {
    return undefined;
  }
}

function buildSource(searchIndexEntries: import("aida-docs/dist/index-search/index.js").SearchIndexEntry[], procedures: import("aida-docs/dist/procedures/index.js").Procedure[], llmsTxt: string | undefined): AidaMcpSource {
  return {
    searchIndexEntries,
    procedures,
    getPageMarkdown: (slug) => (llmsTxt ? getPageFromLlmsTxt(llmsTxt, slug) : undefined),
    appOverview: readAppOverview(),
  };
}

function methodNotSupported(): Response {
  return new Response(JSON.stringify({ error: "the MCP server is not available on a static export" }), {
    status: 501,
    headers: { "Content-Type": "application/json" },
  });
}

function unknownVersionResponse(message: string, availableVersions: string[]): Response {
  return new Response(JSON.stringify({ error: message, availableVersions }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Stateless mode (no `sessionIdGenerator`): each request gets a fresh transport + server
 * connected for the duration of that one request. Simpler and sufficient for aida's five
 * read-only, side-effect-free tools — no session state needs to outlive a single call.
 *
 * Versioned docs (build-plan.md M21 step 3): a `?version=<name>` query param picks a frozen
 * snapshot from `versions.json`; omitted/"latest" means the current build. An unknown name
 * gets a clear 400 listing every version that does exist, before a server is even built.
 */
async function handle(request: Request): Promise<Response> {
  if (STATIC_EXPORT) return methodNotSupported();

  const version = new URL(request.url).searchParams.get("version") ?? undefined;
  const versionSource = resolveVersionSource(join(process.cwd(), "public"), version);
  if (isUnknownVersionError(versionSource)) {
    return unknownVersionResponse(versionSource.error, versionSource.availableVersions);
  }

  const source = buildSource(versionSource.searchIndexEntries, versionSource.procedures, versionSource.llmsTxt);
  const server = createAidaMcpServer(source);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return handle(request);
}
