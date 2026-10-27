import { describe, expect, it, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAidaMcpServer } from "../../src/mcp/server.js";
import type { AidaMcpSource } from "../../src/mcp/types.js";
import type { Procedure } from "../../src/procedures/index.js";

const procedures: Procedure[] = [
  {
    id: "add-competitor",
    title: "Add a competitor",
    for: "office staff",
    start: { page: "/competitors", role: "office-staff", roleName: "office staff" },
    steps: [
      { n: 1, title: "Open competitors", instruction: "Click Competitors in the menu.", screenshot: "/screenshots/add-competitor/step-01.png" },
      { n: 2, title: "Fill the form", instruction: "Enter their first name." },
    ],
  },
];

const source: AidaMcpSource = {
  searchIndexEntries: [
    { url: "/add-competitor", title: "Add a competitor", text: "Click Add competitor to create a new one." },
  ],
  procedures,
  getPageMarkdown: (url) => (url === "/add-competitor" ? "# Add a competitor\n\nClick Add competitor." : undefined),
};

async function connectedClient(src: AidaMcpSource = source): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createAidaMcpServer(src);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content.find((c) => c.type === "text");
  return block?.text ?? "";
}

describe("aida MCP server", () => {
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const connected = await connectedClient();
    client = connected.client;
    close = connected.close;
  });

  it("lists exactly the five read-only tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_app_overview", "get_page", "get_procedure", "list_walkthroughs", "search_docs"]);
    await close();
  });

  it("search_docs returns ranked hits for a matching query", async () => {
    const result = await client.callTool({ name: "search_docs", arguments: { query: "add competitor", limit: 5 } });
    const hits = JSON.parse(textOf(result as never));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].url).toBe("/add-competitor");
    await close();
  });

  it("get_page returns plain Markdown for a known page and errors for an unknown one", async () => {
    const ok = await client.callTool({ name: "get_page", arguments: { slug: "/add-competitor" } });
    expect(textOf(ok as never)).toContain("# Add a competitor");

    const missing = await client.callTool({ name: "get_page", arguments: { slug: "/nope" } });
    expect((missing as { isError?: boolean }).isError).toBe(true);
    await close();
  });

  it("list_walkthroughs returns every walkthrough's id, title, audience and start (role id plus roleName)", async () => {
    const result = await client.callTool({ name: "list_walkthroughs", arguments: {} });
    const list = JSON.parse(textOf(result as never));
    expect(list).toEqual([
      { id: "add-competitor", title: "Add a competitor", url: "/add-competitor", for: "office staff", start: { page: "/competitors", role: "office-staff", roleName: "office staff" } },
    ]);
    await close();
  });

  it("get_procedure returns the full ordered steps for a known id", async () => {
    const result = await client.callTool({ name: "get_procedure", arguments: { id: "add-competitor" } });
    const procedure = JSON.parse(textOf(result as never));
    expect(procedure.steps).toHaveLength(2);
    expect(procedure.steps[0].screenshot).toBe("/screenshots/add-competitor/step-01.png");
    await close();
  });

  it("get_app_overview says there's no overview yet, not an error, when the app has no brief", async () => {
    const result = await client.callTool({ name: "get_app_overview", arguments: {} });
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(textOf(result as never)).toMatch(/^No app overview yet/);
    await close();
  });

  it("get_app_overview returns the overview built from the app brief", async () => {
    await close();
    const overview = "# Acme Events\n\n## What it's for\n\nSell seats at community events.";
    const withBrief = await connectedClient({ ...source, appOverview: overview });
    const result = await withBrief.client.callTool({ name: "get_app_overview", arguments: {} });
    expect(textOf(result as never)).toBe(overview);
    await withBrief.close();
  });
});
