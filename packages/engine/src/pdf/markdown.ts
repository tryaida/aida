// Minimal Markdown -> HTML renderer, scoped to exactly what the pages module generates
// (packages/engine/src/pages/content.ts): headings (#-####), paragraphs, **bold**, *italic*,
// `code`, [links](url), ![images](src), "- " bullet lists, "> " blockquotes, and a "---" rule.
// Deliberately not a general CommonMark implementation — the PDF module only ever renders
// aida's own generated page Markdown, never arbitrary user input, so a small renderer that
// matches that Markdown exactly is simpler and has no new dependency.
import path from "node:path";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface ResolveImageSrcOptions {
  /** Allow `http(s):`/`data:` image sources through. Default false — Chromium renders this HTML
   * from `file://`, so an unrestricted image src is a path to local-file disclosure (e.g.
   * `file:///home/u/.env`) or outbound network access from arbitrary page content (review
   * finding pdf/markdown.ts:17). */
  allowRemote?: boolean;
}

/** Resolves a Markdown-relative image path (e.g. `screenshots/step-01.png`) against `baseDir`
 * into a `file://` URL Chromium can load without a running server.
 *
 * Only a relative path that stays inside `baseDir` (the page's own directory) is accepted by
 * default — `file:`, other absolute paths, and (unless `opts.allowRemote`) `http(s):`/`data:`
 * are all rejected, since this HTML is loaded by Chromium from `file://` with no sandboxing of
 * its own: an unescaped/unchecked src is a path to reading arbitrary local files (e.g. an
 * `<iframe>`/`<img>` pointed at `file:///home/u/.env`) or to outbound network/data exfiltration.
 */
export function resolveImageSrc(relSrc: string, baseDir: string, opts: ResolveImageSrcOptions = {}): string {
  if (/^file:/i.test(relSrc)) {
    throw new Error(`pdf: image src "${relSrc}" is not allowed — file: URLs must resolve through the page's own directory`);
  }
  if (/^(https?|data):/i.test(relSrc)) {
    if (opts.allowRemote) return relSrc;
    throw new Error(`pdf: image src "${relSrc}" is not allowed — remote/data images are disabled`);
  }
  if (path.isAbsolute(relSrc)) {
    throw new Error(`pdf: image src "${relSrc}" is not allowed — absolute paths are disabled, only paths inside the page dir`);
  }
  const resolved = path.resolve(baseDir, relSrc);
  const rel = path.relative(baseDir, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`pdf: image src "${relSrc}" escapes the page directory`);
  }
  return `file://${encodeURI(resolved)}`;
}

/** Inline spans: images, links, bold, italic, code — in that order, so `**`/`` ` `` inside an
 * image alt or a link label never gets re-processed as emphasis/code. */
export function renderInline(text: string, baseDir: string, opts: ResolveImageSrcOptions = {}): string {
  let out = escapeHtml(text);
  out = out.replace(
    /!\[([^\]]*)\]\(([^)\s]+)\)/g,
    (_m, alt: string, src: string) => `<img alt="${alt}" src="${resolveImageSrc(src, baseDir, opts)}" />`,
  );
  // `href`/`src` are read off `out`, which is already fully `escapeHtml`'d above — so a literal
  // `"` in a link target has already become the `&quot;` entity by this point and can't break
  // out of the attribute; no separate escaping needed here (re-escaping would double-encode it).
  out = out.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => `<a href="${href}">${label}</a>`);
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => `<code>${code}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, b: string) => `<strong>${b}</strong>`);
  out = out.replace(/\*([^*]+)\*/g, (_m, i: string) => `<em>${i}</em>`);
  return out;
}

interface Block {
  type: "h1" | "h2" | "h3" | "h4" | "p" | "ul" | "hr" | "blockquote" | "img";
  lines?: string[];
  items?: string[];
  src?: string;
  alt?: string;
}

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (/^---+\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      blocks.push({ type: `h${Math.min(level, 4)}` as Block["type"], lines: [heading[2].trim()] });
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "blockquote", lines: quote });
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ""));
        i++;
      }
      blocks.push({ type: "ul", items });
      continue;
    }
    const soloImage = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(line);
    if (soloImage) {
      blocks.push({ type: "img", alt: soloImage[1], src: soloImage[2] });
      i++;
      continue;
    }
    // Paragraph: consume consecutive non-blank, non-special lines.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,4}\s|>|[-*]\s|---+\s*$)/.test(lines[i])) {
      if (/^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.test(lines[i]) && para.length === 0) break;
      para.push(lines[i]);
      i++;
    }
    if (para.length > 0) blocks.push({ type: "p", lines: para });
  }
  return blocks;
}

/** Renders aida's generated page Markdown into a plain HTML fragment (no `<html>`/`<body>` —
 * callers wrap it in the print document). `baseDir` resolves relative image paths; `opts`
 * controls whether a remote/data image src is permitted (default: rejected — see
 * `resolveImageSrc`). */
export function markdownToHtml(markdown: string, baseDir: string, opts: ResolveImageSrcOptions = {}): string {
  const blocks = parseBlocks(markdown);
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
        out.push(`<${b.type}>${renderInline(b.lines!.join(" "), baseDir, opts)}</${b.type}>`);
        break;
      case "p":
        out.push(`<p>${renderInline(b.lines!.join(" "), baseDir, opts)}</p>`);
        break;
      case "ul":
        out.push(`<ul>${b.items!.map((it) => `<li>${renderInline(it, baseDir, opts)}</li>`).join("")}</ul>`);
        break;
      case "blockquote":
        out.push(`<blockquote>${renderInline(b.lines!.join(" "), baseDir, opts)}</blockquote>`);
        break;
      case "hr":
        out.push("<hr />");
        break;
      case "img":
        out.push(`<img alt="${escapeHtml(b.alt ?? "")}" src="${resolveImageSrc(b.src!, baseDir, opts)}" />`);
        break;
    }
  }
  return out.join("\n");
}
