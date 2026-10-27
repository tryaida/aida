// Versioned docs route (docs/scope.md "Help site": "a version per release"; build-plan.md M21
// step 2): serves a page out of a frozen snapshot (`aida version freeze`, public/versions/
// <version>/) instead of the live `content/docs` tree the unversioned `/[[...slug]]` route
// renders. The unversioned route — and its URL — never changes; this is purely an additional
// path sideways into an old version.
//
// Trade-off, documented rather than hidden: `aida version freeze` only snapshots
// search-index.json, procedures.json and llms.txt (versions/freeze.ts) — not full MDX/React
// pages, screenshots or video. So an old version renders here as plain Markdown text (llms.txt's
// per-page section, via the same `getPageFromLlmsTxt` the MCP server's `get_page` tool uses),
// not the richer Fumadocs-rendered page with annotated screenshots and an embedded video that
// `/[[...slug]]` gets. Good enough to answer "what did this page say as of v1.0" cheaply and
// statically; not a byte-for-byte historical replay of the whole page.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { notFound } from "next/navigation";
import { getPageFromLlmsTxt } from "aida-docs/dist/mcp/index.js";
import type { Procedure } from "aida-docs/dist/procedures/index.js";

// A version can be frozen any time after `next build` runs (`aida version freeze` is a
// separate step) — static params generated at build time would go stale the moment a new
// version appears, so this route is rendered per-request instead. Not pre-generated under a
// static export either way (see `generateStaticParams` below): a static export has no server to
// render an unknown version at request time, matching the same limitation the chat/MCP routes
// already document for `output: export`.
export const dynamicParams = true;

async function readVersionFile(version: string, name: string): Promise<string | undefined> {
  try {
    return await readFile(join(process.cwd(), "public", "versions", version, name), "utf8");
  } catch {
    return undefined;
  }
}

export default async function VersionedPage(props: { params: Promise<{ version: string; slug?: string[] }> }) {
  const { version, slug = [] } = await props.params;

  const llmsTxt = await readVersionFile(version, "llms.txt");
  if (llmsTxt === undefined) notFound();

  const currentPath = `/${slug.join("/")}`;

  if (slug.length === 0) {
    const proceduresRaw = await readVersionFile(version, "procedures.json");
    const procedures: Procedure[] = proceduresRaw ? (JSON.parse(proceduresRaw) as Procedure[]) : [];
    return (
      <div className="prose mx-auto w-full max-w-fd-container px-4 py-8">
        <p className="text-sm text-fd-muted-foreground">
          Frozen version <strong>{version}</strong> — page content only (see note above for what
          isn&apos;t snapshotted).
        </p>
        <h1>Pages in {version}</h1>
        <ul>
          {procedures.map((p) => (
            <li key={p.id}>
              <a href={`/v/${version}/${p.id}`}>{p.title}</a>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const content = getPageFromLlmsTxt(llmsTxt, currentPath);
  if (content === undefined) notFound();

  return (
    <div className="prose mx-auto w-full max-w-fd-container px-4 py-8">
      <p className="text-sm text-fd-muted-foreground">
        Frozen version <strong>{version}</strong> — <a href={currentPath}>view the latest version of this page</a>.
      </p>
      <pre className="whitespace-pre-wrap text-sm">{content}</pre>
    </div>
  );
}

export async function generateStaticParams(): Promise<{ version: string; slug?: string[] }[]> {
  // See the module comment: versions frozen after `next build` must not need a rebuild to
  // become reachable, so nothing is pre-generated — `dynamicParams` (default true) lets Next
  // render any `version`/`slug` combination on demand instead.
  return [];
}
