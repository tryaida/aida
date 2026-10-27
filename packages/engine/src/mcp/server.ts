// Builds the aida agent connector: a read-only MCP server with `get_app_overview`, `search_docs`,
// `get_page`, `list_walkthroughs` and `get_procedure` (docs/scope.md "Agent connector (MCP server)";
// "Safety and trust": "The MCP server is read-only"; build-plan.md M15 step 3). The help app's
// `app/api/mcp/route.ts` mounts this over the SDK's Streamable HTTP transport — this module has
// no HTTP/Next.js knowledge, so it's also usable in-process from tests (test/mcp/**).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LexicalSearchProvider } from "../index-search/index.js";
import type { AidaMcpSource } from "./types.js";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Creates an `McpServer` wired to `source`. No tool here ever writes — every handler only
 * reads `source` and returns data, matching "Access: the MCP server is read-only" exactly.
 */
export function createAidaMcpServer(source: AidaMcpSource): McpServer {
  const server = new McpServer({ name: "aida", version: "0.0.1" });

  server.registerTool(
    "get_app_overview",
    {
      title: "Get app overview",
      description:
        "What the app is for, who uses it and the job they're doing, the things it keeps track of, the words it uses, the rules that matter, its rhythm, and tasks that can start from more than one screen. Read this first to understand the app before searching its guides.",
      inputSchema: {},
    },
    async () => {
      // No brief yet is a normal state for a new site, not a failure.
      const overview = source.appOverview?.trim();
      return textResult(overview || "No app overview yet. Use search_docs and list_walkthroughs to find guides.");
    },
  );

  server.registerTool(
    "search_docs",
    {
      title: "Search docs",
      description: "Lexical search over the help site's pages. Returns ranked page/section hits with URLs.",
      inputSchema: {
        query: z.string().describe("Search query, in plain words"),
        limit: z.number().int().positive().max(20).optional().describe("Max results (default 5)"),
      },
    },
    async ({ query, limit }) => {
      const provider = new LexicalSearchProvider(source.searchIndexEntries);
      const hits = provider.search(query, { limit: limit ?? 5 });
      return textResult(JSON.stringify(hits, null, 2));
    },
  );

  server.registerTool(
    "get_page",
    {
      title: "Get page",
      description: "Returns one help page's content as plain Markdown, given its URL (e.g. \"/how-do-i/competitors/add-competitor\") or walkthrough id.",
      inputSchema: { slug: z.string().describe('Page URL, e.g. "/how-do-i/competitors/add-competitor", or a walkthrough id') },
    },
    async ({ slug }) => {
      const markdown = await source.getPageMarkdown(slug);
      if (markdown === undefined) {
        return { ...textResult(`no page at "${slug}"`), isError: true };
      }
      return textResult(markdown);
    },
  );

  server.registerTool(
    "list_walkthroughs",
    {
      title: "List walkthroughs",
      description:
        "Lists every published walkthrough: id, title, page URL, who it's for, and where it starts (start.page; start.role is the sign-in role id, start.roleName what to call that role to a person).",
      inputSchema: {},
    },
    async () => {
      // `start` as procedures.json has it: `role` (id) and, since M26, `roleName`.
      const list = source.procedures.map((p) => ({ id: p.id, title: p.title, url: p.url ?? `/${p.id}`, for: p.for, start: p.start }));
      return textResult(JSON.stringify(list, null, 2));
    },
  );

  server.registerTool(
    "get_procedure",
    {
      title: "Get procedure",
      description: "Returns one walkthrough's structured, ordered steps an agent can follow (title, instruction, screenshot, video moment).",
      inputSchema: { id: z.string().describe("Walkthrough id, e.g. \"add-competitor\"") },
    },
    async ({ id }) => {
      const procedure = source.procedures.find((p) => p.id === id);
      if (!procedure) {
        return { ...textResult(`no procedure with id "${id}"`), isError: true };
      }
      return textResult(JSON.stringify(procedure, null, 2));
    },
  );

  return server;
}
