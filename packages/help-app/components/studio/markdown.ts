// A small Markdown/MDX reader for the Studio's page preview. Pure functions (no React) so it's
// unit-testable; PagePreview.tsx turns the result into elements styled with the help site's own
// `prose` classes. Deliberately not the full MDX pipeline: the preview only needs what aida's
// page builder writes (pages/content.ts) plus the Markdown a person typically adds by hand —
// headings, paragraphs, lists, quotes, code, tables, images, links and inline HTML like <kbd>.
// Anything it doesn't understand (a JSX component) shows as a labelled placeholder, never as
// raw source, and nothing here ever produces HTML strings: every node becomes a React element.

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong" | "em" | "del" | "kbd" | "mark" | "sub" | "sup" | "u" | "small"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "image"; src: string; alt: string }
  | { type: "br" };

export type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "image"; src: string; alt: string }
  | { type: "list"; ordered: boolean; start: number; items: Block[][] }
  | { type: "quote"; children: Block[] }
  | { type: "code"; lang?: string; text: string }
  | { type: "table"; head: Inline[][]; rows: Inline[][][] }
  | { type: "hr" }
  | { type: "component"; name: string };

/** A run of blocks from one aida marker section (`{/* aida:begin key *\/}`), or from text
 * outside any marker (`key` undefined). Step sections are keyed `step-<step id>`. */
export interface Section {
  key?: string;
  blocks: Block[];
}

export interface ParsedPage {
  frontmatter: Record<string, string>;
  sections: Section[];
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const BEGIN_RE = /^\s*\{\/\*\s*aida:begin\s+([A-Za-z0-9_.:-]+)\s*\*\/\}\s*$/;
const END_RE = /^\s*\{\/\*\s*aida:end\s+([A-Za-z0-9_.:-]+)\s*\*\/\}\s*$/;

/** Splits off a `---` frontmatter fence and reads its flat `key: value` lines (enough for the
 * preview's title/lastChecked; nested YAML is ignored rather than mis-parsed). */
export function splitFrontmatter(text: string): { frontmatter: Record<string, string>; body: string } {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return { frontmatter: {}, body: text };
  const frontmatter: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    frontmatter[kv[1]] = value;
  }
  return { frontmatter, body: text.slice(m[0].length) };
}

/** Removes MDX `{/* comment *\/}` expressions (aida's own markers included). */
export function stripMdxComments(text: string): string {
  return text.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

export function parsePage(text: string): ParsedPage {
  const { frontmatter, body } = splitFrontmatter(text.replace(/\r\n/g, "\n"));
  const sections: Section[] = [];
  let current: { key?: string; lines: string[] } = { lines: [] };
  const stack: string[] = [];
  const flush = () => {
    const blocks = parseBlocks(stripMdxComments(current.lines.join("\n")).split("\n"));
    if (blocks.length > 0) sections.push({ key: current.key, blocks });
  };
  for (const line of body.split("\n")) {
    const begin = BEGIN_RE.exec(line);
    const end = begin ? null : END_RE.exec(line);
    if (begin || end) {
      flush();
      if (begin) stack.push(begin[1]);
      else stack.pop();
      current = { key: stack[stack.length - 1], lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  flush();
  return { frontmatter, sections };
}

const LIST_ITEM_RE = /^(\s*)([-*+]|(\d{1,9})[.)])\s+(.*)$/;
const FENCE_RE = /^\s*(```+|~~~+)\s*([\w-]*)/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const IMAGE_ONLY_RE = /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/;
const COMPONENT_RE = /^\s*<([A-Z][\w.]*)\b[^>]*\/?>\s*$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function indentOf(line: string): number {
  return /^\s*/.exec(line)![0].replace(/\t/g, "    ").length;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim());
}

export function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const closer = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(closer)) body.push(lines[i++]);
      i++;
      blocks.push({ type: "code", lang: fence[2] || undefined, text: body.join("\n") });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length as 1, children: parseInline(heading[2]) });
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) inner.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push({ type: "quote", children: parseBlocks(inner) });
      continue;
    }

    const item = LIST_ITEM_RE.exec(line);
    if (item) {
      const base = indentOf(line);
      const ordered = item[3] !== undefined;
      const start = ordered ? Number(item[3]) : 1;
      const items: string[][] = [];
      while (i < lines.length) {
        const l = lines[i];
        const m = LIST_ITEM_RE.exec(l);
        if (m && indentOf(l) === base && (m[3] !== undefined) === ordered) {
          items.push([m[4]]);
          i++;
          continue;
        }
        if (!l.trim()) {
          // A blank line ends the list unless the next line continues it (indented, or another item).
          const next = lines[i + 1];
          if (next !== undefined && (indentOf(next) > base || LIST_ITEM_RE.exec(next)?.[1].length === base)) {
            items[items.length - 1].push("");
            i++;
            continue;
          }
          break;
        }
        if (indentOf(l) > base || (!m && !HEADING_RE.test(l) && !FENCE_RE.test(l))) {
          items[items.length - 1].push(l.slice(Math.min(indentOf(l), base + 2)));
          i++;
          continue;
        }
        break;
      }
      blocks.push({ type: "list", ordered, start, items: items.map((it) => parseBlocks(it)) });
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const head = splitRow(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(splitRow(lines[i++]).map(parseInline));
      blocks.push({ type: "table", head, rows });
      continue;
    }

    const image = IMAGE_ONLY_RE.exec(line);
    if (image) {
      blocks.push({ type: "image", alt: unescapeText(image[1]), src: image[2] });
      i++;
      continue;
    }

    const component = COMPONENT_RE.exec(line);
    if (component) {
      blocks.push({ type: "component", name: component[1] });
      i++;
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !HEADING_RE.test(lines[i]) &&
      !FENCE_RE.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !(para.length > 0 && LIST_ITEM_RE.test(lines[i])) &&
      !(para.length > 0 && HR_RE.test(lines[i]))
    ) {
      para.push(lines[i++]);
    }
    // Two trailing spaces (or a backslash) end a hard line break; otherwise lines join with a space.
    const joined = para.map((l, idx) => (idx < para.length - 1 && /( {2,}|\\)$/.test(l) ? `${l.replace(/( {2,}|\\)$/, "")}<br>` : l.trim())).join(" ");
    blocks.push({ type: "paragraph", children: parseInline(joined) });
  }
  return blocks;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", mdash: "—", ndash: "–", hellip: "…" };

function unescapeText(s: string): string {
  return s
    .replace(/\\([\\`*_{}[\]()#+\-.!<>|~"'])/g, "$1")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e.startsWith("#x") || e.startsWith("#X")) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (e.startsWith("#") && e !== "#39") return String.fromCodePoint(Number(e.slice(1)));
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

const INLINE_TAGS: Record<string, Exclude<Inline["type"], "text" | "code" | "link" | "image" | "br">> = {
  strong: "strong",
  b: "strong",
  em: "em",
  i: "em",
  kbd: "kbd",
  mark: "mark",
  sub: "sub",
  sup: "sup",
  u: "u",
  small: "small",
  s: "del",
  del: "del",
};

/** Only same-site paths, fragments, relative paths and http(s)/mailto links survive; anything
 * else (javascript:, data:...) renders as plain text. */
export function safeHref(href: string): string | undefined {
  const h = href.trim();
  if (/^(https?:|mailto:)/i.test(h)) return h;
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith("//")) return undefined;
  return h;
}

/** Index of the `close` that balances the `open` at `from` (for `[...]` / `(...)`), or -1. */
function matching(s: string, from: number, open: string, close: string): number {
  let depth = 0;
  for (let j = from; j < s.length; j++) {
    if (s[j] === "\\") {
      j++;
      continue;
    }
    if (s[j] === open) depth++;
    else if (s[j] === close && --depth === 0) return j;
  }
  return -1;
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const pushText = () => {
    if (buf) out.push({ type: "text", text: unescapeText(buf) });
    buf = "";
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const rest = src.slice(i);

    if (c === "\\" && i + 1 < src.length) {
      buf += src.slice(i, i + 2);
      i += 2;
      continue;
    }

    if (c === "{" && rest.startsWith("{/*")) {
      const end = src.indexOf("*/}", i);
      if (end !== -1) {
        i = end + 3;
        continue;
      }
    }

    if (c === "`") {
      const ticks = /^`+/.exec(rest)![0];
      const end = src.indexOf(ticks, i + ticks.length);
      if (end !== -1) {
        pushText();
        out.push({ type: "code", text: src.slice(i + ticks.length, end).trim() });
        i = end + ticks.length;
        continue;
      }
    }

    if ((c === "!" && src[i + 1] === "[") || c === "[") {
      const isImage = c === "!";
      const open = isImage ? i + 1 : i;
      const close = matching(src, open, "[", "]");
      if (close !== -1 && src[close + 1] === "(") {
        const parenEnd = matching(src, close + 1, "(", ")");
        if (parenEnd !== -1) {
          const label = src.slice(open + 1, close);
          const target = src.slice(close + 2, parenEnd).trim().split(/\s+/)[0] ?? "";
          pushText();
          if (isImage) {
            out.push({ type: "image", alt: unescapeText(label), src: target });
          } else {
            const href = safeHref(target);
            out.push(href ? { type: "link", href, children: parseInline(label) } : { type: "text", text: unescapeText(label) });
          }
          i = parenEnd + 1;
          continue;
        }
      }
    }

    if (c === "<") {
      const auto = /^<(https?:\/\/[^\s>]+)>/.exec(rest);
      if (auto) {
        pushText();
        out.push({ type: "link", href: auto[1], children: [{ type: "text", text: auto[1] }] });
        i += auto[0].length;
        continue;
      }
      const br = /^<br\s*\/?>/i.exec(rest);
      if (br) {
        pushText();
        out.push({ type: "br" });
        i += br[0].length;
        continue;
      }
      const tag = /^<([a-z]+)(\s[^>]*)?>/i.exec(rest);
      if (tag && INLINE_TAGS[tag[1].toLowerCase()]) {
        const name = tag[1].toLowerCase();
        const closeRe = new RegExp(`</${name}\\s*>`, "i");
        const after = src.slice(i + tag[0].length);
        const closeMatch = closeRe.exec(after);
        if (closeMatch) {
          pushText();
          out.push({ type: INLINE_TAGS[name], children: parseInline(after.slice(0, closeMatch.index)) });
          i += tag[0].length + closeMatch.index + closeMatch[0].length;
          continue;
        }
      }
      const a = /^<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/i.exec(rest);
      if (a) {
        pushText();
        const href = safeHref(a[1]);
        out.push(href ? { type: "link", href, children: parseInline(a[2]) } : { type: "text", text: a[2] });
        i += a[0].length;
        continue;
      }
      // Any other tag (an unknown element or a JSX component) is dropped; its text content stays.
      const other = /^<\/?[A-Za-z][\w.-]*(\s[^>]*)?\/?>/.exec(rest);
      if (other) {
        i += other[0].length;
        continue;
      }
    }

    if (c === "*" || c === "_" || c === "~") {
      const run = c === "~" ? (rest.startsWith("~~") ? "~~" : "") : rest.startsWith(c + c) ? c + c : c;
      // `_` only counts at a word boundary, so snake_case_names stay as typed.
      const leftOk = c !== "_" || i === 0 || !/[A-Za-z0-9]/.test(src[i - 1]);
      if (run && leftOk && src[i + run.length] && !/\s/.test(src[i + run.length])) {
        let end = i + run.length;
        let found = -1;
        while ((end = src.indexOf(run, end)) !== -1) {
          const before = src[end - 1];
          const after = src[end + run.length];
          const rightOk = c !== "_" || after === undefined || !/[A-Za-z0-9]/.test(after);
          if (before !== "\\" && !/\s/.test(before) && rightOk && end > i + run.length && (run.length === 2 || src[end + 1] !== c)) {
            found = end;
            break;
          }
          end += run.length;
        }
        if (found !== -1) {
          pushText();
          const children = parseInline(src.slice(i + run.length, found));
          out.push({ type: run === "~~" ? "del" : run.length === 2 ? "strong" : "em", children });
          i = found + run.length;
          continue;
        }
      }
    }

    buf += c;
    i++;
  }
  pushText();
  return out;
}

/** Maps a page image `src` to where the Studio can load it from: `screenshots/x.png` (and
 * `./screenshots/x.png`) — the page builder's own output — go through the guarded
 * `/studio/api/page-asset` route; site-absolute and http(s) URLs load as they are; anything else
 * (another relative path) is unresolvable from the Studio and returns undefined. */
export function previewImageSource(walkthroughId: string, src: string): { kind: "guarded" | "direct"; url: string } | undefined {
  const s = src.trim();
  const local = /^(?:\.\/)?screenshots\/([^/?#]+)$/.exec(s);
  if (local) {
    return {
      kind: "guarded",
      url: `/studio/api/page-asset?id=${encodeURIComponent(walkthroughId)}&file=${encodeURIComponent(local[1])}`,
    };
  }
  if (/^https?:\/\//i.test(s) || (s.startsWith("/") && !s.startsWith("//"))) return { kind: "direct", url: s };
  return undefined;
}
