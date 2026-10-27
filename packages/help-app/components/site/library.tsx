// Library views built from the shaped page tree (lib/tree.ts): the cards on a section page and
// the topics + guides on the home page. Server components — no client JS.
import type { Folder, Root } from "fumadocs-core/page-tree";
import type { ReactNode } from "react";
import { guidesUnder, pageData } from "@/lib/tree";
import { CardGrid, GuideCard, SectionCard } from "./cards";

function guideCards(folder: Root | Folder, limit?: number) {
  const guides = guidesUnder(folder).slice(0, limit);
  return guides.map(({ item, data }) => (
    <GuideCard
      key={item.url}
      url={item.url}
      title={item.name}
      description={data.description}
      poster={data.poster}
      steps={data.steps}
      video={Boolean(data.video)}
      lastChecked={data.lastChecked}
    />
  ));
}

function sectionCard(folder: Folder, fallbackIcon?: ReactNode) {
  const data = folder.index ? pageData(folder.index) : undefined;
  return (
    <SectionCard
      key={folder.$id ?? folder.index?.url}
      url={folder.index?.url}
      title={folder.name}
      description={data?.description}
      icon={folder.icon ?? fallbackIcon}
      guides={guidesUnder(folder).map(({ item }) => ({ url: item.url, title: item.name }))}
    />
  );
}

/** A section page's contents: its topics (sub-sections), then every guide inside it. */
export function SectionLibrary({ folder }: { folder: Folder }) {
  const subsections = folder.children.filter((c): c is Folder => c.type === "folder");
  const guides = guideCards(folder);
  return (
    <div className="mb-10 flex flex-col gap-10">
      {subsections.length > 0 ? (
        <section>
          <h2 className="mb-4 font-heading text-lg font-semibold">Topics</h2>
          <CardGrid>{subsections.map((f) => sectionCard(f, folder.icon))}</CardGrid>
        </section>
      ) : null}
      {guides.length > 0 ? (
        <section>
          <h2 className="mb-4 font-heading text-lg font-semibold">
            {subsections.length > 0 ? "All guides" : "Guides"}
          </h2>
          <CardGrid>{guides}</CardGrid>
        </section>
      ) : null}
      {subsections.length === 0 && guides.length === 0 ? (
        <p className="text-fd-muted-foreground">There are no guides here yet.</p>
      ) : null}
    </div>
  );
}

/** The home page's library: every topic (sections inside "How do I…" plus the other
 * categories that have pages), then the guides themselves. */
export function HomeLibrary({ tree }: { tree: Root }) {
  const topics: Folder[] = [];
  for (const node of tree.children) {
    if (node.type !== "folder") continue;
    const inner = node.children.filter((c): c is Folder => c.type === "folder");
    // "How do I…" is mostly a container: its feature sections are the useful topics.
    if (node.$ref?.folder === "how-do-i" && inner.length > 0) {
      topics.push(...inner.map((f) => ({ ...f, icon: f.icon ?? node.icon })));
      const loose = node.children.filter((c) => c.type === "page");
      if (loose.length > 0) topics.push({ ...node, children: loose });
    } else {
      topics.push(node);
    }
  }
  const total = guidesUnder(tree).length;
  return (
    <div className="flex flex-col gap-12">
      {topics.length > 0 ? (
        <section>
          <h2 className="mb-4 font-heading text-xl font-semibold tracking-tight">Browse by topic</h2>
          <CardGrid>{topics.map((t) => sectionCard(t))}</CardGrid>
        </section>
      ) : null}
      {total > 0 ? (
        <section>
          <div className="mb-4 flex items-baseline justify-between gap-4">
            <h2 className="font-heading text-xl font-semibold tracking-tight">Step-by-step guides</h2>
            <span className="text-sm text-fd-muted-foreground">{total} in total</span>
          </div>
          <CardGrid>{guideCards(tree, 9)}</CardGrid>
        </section>
      ) : (
        <p className="text-fd-muted-foreground">
          No guides yet. Run <code>aida build</code> to add pages from your walkthroughs.
        </p>
      )}
    </div>
  );
}
