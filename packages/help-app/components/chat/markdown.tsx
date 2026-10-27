// Renders the help chat's answers. The system prompt (engine chat/prompt.ts) asks for light
// Markdown only — paragraphs, short lists, **bold**, *italic*, `code` and [n] citations — so this
// handles exactly that, building React elements (never raw HTML) so model output can't inject
// markup. Kept dependency-free; public/widget.js has the same rules for the drop-in widget.
import type { ReactNode } from "react";

export interface MarkdownCitation {
  n: number;
  url: string;
  title: string;
}

type Block = { kind: "p"; lines: string[] } | { kind: "ol" | "ul"; items: string[] };

const ORDERED = /^\s*\d+[.)]\s+/;
const UNORDERED = /^\s*[-*•]\s+/;

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const last = blocks[blocks.length - 1];
    if (!line.trim()) {
      blocks.push({ kind: "p", lines: [] });
      continue;
    }
    const kind = ORDERED.test(line) ? "ol" : UNORDERED.test(line) ? "ul" : undefined;
    if (kind) {
      const item = line.replace(kind === "ol" ? ORDERED : UNORDERED, "");
      if (last && last.kind === kind) last.items.push(item);
      else blocks.push({ kind, items: [item] });
    } else if (last && last.kind !== "p" && /^\s{2,}/.test(raw)) {
      // An indented continuation line belongs to the list item above it.
      last.items[last.items.length - 1] += ` ${line.trim()}`;
    } else if (last && last.kind === "p") {
      last.lines.push(line);
    } else {
      blocks.push({ kind: "p", lines: [line] });
    }
  }
  return blocks.filter((b) => (b.kind === "p" ? b.lines.length > 0 : b.items.length > 0));
}

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|\[\d+\])/g;

function renderInline(text: string, cite: (n: number) => MarkdownCitation | undefined, href: (url: string) => string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (!part) return null;
    if (part.startsWith("`")) return <code key={i} className="rounded bg-fd-background/70 px-1 py-0.5 text-[0.9em]">{part.slice(1, -1)}</code>;
    if (part.startsWith("**") || part.startsWith("__")) return <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>;
    if (/^[*_]/.test(part)) return <em key={i}>{part.slice(1, -1)}</em>;
    const m = /^\[(\d+)\]$/.exec(part);
    if (m) {
      const c = cite(Number(m[1]));
      if (!c) return null;
      return (
        <a
          key={i}
          href={href(c.url)}
          title={c.title}
          className="ms-0.5 inline-flex size-4 -translate-y-1 items-center justify-center rounded-full bg-fd-primary/15 align-baseline text-[0.65rem] font-semibold text-fd-primary no-underline hover:bg-fd-primary hover:text-fd-primary-foreground"
        >
          {c.n}
        </a>
      );
    }
    return part;
  });
}

export function ChatMarkdown({
  text,
  citations = [],
  href = (url) => url,
}: {
  text: string;
  citations?: MarkdownCitation[];
  href?: (url: string) => string;
}) {
  const cite = (n: number) => citations.find((c) => c.n === n);
  return (
    <div className="space-y-2 leading-relaxed">
      {parseBlocks(text).map((block, i) => {
        if (block.kind === "p") {
          return (
            <p key={i}>
              {block.lines.map((line, j) => (
                <span key={j}>
                  {j > 0 ? <br /> : null}
                  {renderInline(line, cite, href)}
                </span>
              ))}
            </p>
          );
        }
        const List = block.kind;
        return (
          <List key={i} className={`${block.kind === "ol" ? "list-decimal" : "list-disc"} space-y-1 ps-5 marker:text-fd-muted-foreground`}>
            {block.items.map((item, j) => (
              <li key={j}>{renderInline(item, cite, href)}</li>
            ))}
          </List>
        );
      })}
    </div>
  );
}

/** The `[n]` numbers an answer actually cites, so only those sources are shown under it. */
export function citedNumbers(text: string): Set<number> {
  return new Set([...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
}
