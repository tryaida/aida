// Shapes Fumadocs' file-based page tree into the help library the reader sees. Keeps the
// engine's folder layout (content/docs/<category>/<section>/<walkthrough>/index.mdx) but:
//   - a walkthrough folder (an index page plus screenshots, no child pages) shows as a plain page,
//     not an empty expandable folder;
//   - a template placeholder section with no pages yet is hidden, so a new site never shows
//     "nothing here" sections;
//   - pages that failed their last check are hidden in production builds (they 404 there too —
//     app/(site)/[[...slug]]/page.tsx).
import type { Folder, Item, Node, Root } from "fumadocs-core/page-tree";
import { categoryIcon, sectionIcons } from "./icons";
import { source } from "./source";

type PageData = ReturnType<typeof source.getPages>[number]["data"];

function pageData(node: Item): PageData | undefined {
  return source.getNodePage(node)?.data;
}

function hidden(data: PageData | undefined): boolean {
  return process.env.NODE_ENV === "production" && data?.passed === false;
}

function shapeNode(node: Node): Node | undefined {
  if (node.type === "separator") return node;
  if (node.type === "page") {
    const data = pageData(node);
    return hidden(data) || data?.placeholder ? undefined : node;
  }

  const children = node.children
    .map(shapeNode)
    // A meta.json that lists "index" puts the folder's own page among its children too.
    .filter((n): n is Node => n !== undefined && !(n.type === "page" && n.url === node.index?.url));
  const indexData = node.index ? pageData(node.index) : undefined;
  const index = node.index && !hidden(indexData) ? node.index : undefined;
  const hasPages = children.some((c) => c.type !== "separator");

  if (!hasPages) {
    if (!index || indexData?.placeholder) return undefined;
    // A folder that only holds its own page (a walkthrough and its screenshots): show the page.
    if (indexData?.kind !== "section" && indexData?.kind !== "home") return index;
  }
  const icon = node.icon ?? categoryIcon(node.$ref?.folder);
  return { ...node, index, children: withSectionIcons(children), icon } satisfies Folder;
}

/** Gives sub-sections without an icon of their own one matched from their title, distinct among siblings. */
function withSectionIcons(children: Node[]): Node[] {
  const bare = children.filter((c): c is Folder => c.type === "folder" && !c.icon);
  if (bare.length === 0) return children;
  const icons = sectionIcons(
    bare.map((f) => ({ title: typeof f.name === "string" ? f.name : "", slug: f.$ref?.folder?.split("/").pop() })),
  );
  return children.map((c) => {
    const i = bare.indexOf(c as Folder);
    return i < 0 ? c : { ...c, icon: icons[i] };
  });
}

/** The sidebar/breadcrumb tree for the help site. */
export function libraryTree(): Root {
  const tree = source.getPageTree();
  return { ...tree, children: tree.children.map(shapeNode).filter((n): n is Node => n !== undefined) };
}

/** Finds the folder whose index page is `url` in `tree`. */
export function findFolder(tree: Root | Folder, url: string): Folder | undefined {
  for (const node of tree.children) {
    if (node.type !== "folder") continue;
    if (node.index?.url === url) return node;
    const found = findFolder(node, url);
    if (found) return found;
  }
  return undefined;
}

/** Every page item under `node`, depth first (folder index pages included). */
export function pagesUnder(node: Root | Folder): Item[] {
  const out: Item[] = [];
  for (const child of node.children) {
    if (child.type === "page") out.push(child);
    else if (child.type === "folder") {
      if (child.index) out.push(child.index);
      out.push(...pagesUnder(child));
    }
  }
  return out;
}

/** Walkthrough pages under `node` (sections excluded), with their frontmatter. */
export function guidesUnder(node: Root | Folder): { item: Item; data: PageData }[] {
  return pagesUnder(node)
    .map((item) => ({ item, data: pageData(item) }))
    .filter((g): g is { item: Item; data: PageData } => g.data?.kind === "walkthrough" || Boolean(g.data?.walkthrough));
}

/** Pages written from the app brief (glossary, rules, what the app is for) under `node`. */
export function articlesUnder(node: Root | Folder): { item: Item; data: PageData }[] {
  return pagesUnder(node)
    .map((item) => ({ item, data: pageData(item) }))
    .filter((g): g is { item: Item; data: PageData } => g.data?.brief === true);
}

/** Every page a reader would open under `node`, guides and brief pages, in sidebar order. */
export function readablePagesUnder(node: Root | Folder): { item: Item; data: PageData }[] {
  return pagesUnder(node)
    .map((item) => ({ item, data: pageData(item) }))
    .filter((g): g is { item: Item; data: PageData } => g.data?.brief === true || g.data?.kind === "walkthrough" || Boolean(g.data?.walkthrough));
}

export { pageData };
