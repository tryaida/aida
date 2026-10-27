// The proof sheet's help-site panel when the site isn't running (M36): a faithful static render
// of the guide's built page as the help app lays it out — the brand's own `app/brand.css`
// variables, the top bar, the library sidebar, the guide header (title, description, checked
// badge, step count, reader, PDF buttons), the video, then the page's Markdown with numbered
// step badges and its screenshots, and the "On this page" list. Only the opening steps are
// shown, ended by a "more steps" line, so the panel is a whole page excerpt that fits the sheet
// without being cut off mid-step.
import { markdownToHtml, escapeHtml } from "../pdf/markdown.js";
import type { PdfBrand, PdfPageInput } from "../pdf/types.js";
import { pdfTheme } from "../pdf/html.js";

export interface SitePageOptions {
  /** `app/brand.css` text (theme/write.ts `renderBrandCss`): the site's own colour variables. */
  brandCss: string;
  /** Video poster (an image path or URL) — the video's first card. */
  poster?: string;
  /** Guides listed in the sidebar's section beside this one (titles). */
  siblings?: string[];
  /** Steps shown before the "more steps" line. Default 2. */
  maxSteps?: number;
  /** Page frontmatter facts the header shows. */
  facts: { steps: number; for?: string; lastChecked?: string; passed: boolean; pdf: boolean };
}

/** Width the panel is rendered at (a laptop window). */
export const SITE_PAGE_WIDTH = 1280;

function humanDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** The page body as the site shows it: no repeated title/intro (globals.css hides them), no
 * single "Part 1" heading, step headings as badged rows, and only the first `maxSteps` steps. */
export function sitePageBody(markdown: string, baseDir: string, maxSteps: number): { html: string; toc: string[]; more: number } {
  let html = markdownToHtml(markdown, baseDir);
  // Title and intro are in the header.
  html = html.replace(/^\s*<h1>[\s\S]*?<\/h1>\s*(<p>[\s\S]*?<\/p>)?/, "");
  if ((html.match(/<h3>Part \d+:/g) ?? []).length === 1) html = html.replace(/<h3>Part \d+:[\s\S]*?<\/h3>\s*/, "");
  // "Other ways to do this" and the footer aren't part of the excerpt.
  html = html.replace(/<h2>Other ways to do this<\/h2>[\s\S]*$/, "");
  const parts = html.split(/(?=<h4>)/);
  const head = parts[0];
  const steps = parts.slice(1);
  const shown = steps.slice(0, maxSteps).map((p) => {
    // A step block runs to the next heading; anything after it (a following h2/h3) is dropped.
    const block = p.split(/(?=<h2>|<h3>)/)[0];
    return block.replace(/^<h4>(\d+)\.\s*([\s\S]*?)<\/h4>/, (_m, n: string, title: string) => `<h4 class="step"><span class="badge">${n}</span><span>${title}</span></h4>`);
  });
  const toc = [...head.matchAll(/<h2>([\s\S]*?)<\/h2>/g)].map((m) => m[1].replace(/<[^>]+>/g, ""));
  const stepTitles = steps.map((p) => /^<h4>([\s\S]*?)<\/h4>/.exec(p)?.[1].replace(/<[^>]+>/g, "") ?? "");
  return { html: head + shown.join(""), toc: [...toc, ...stepTitles], more: Math.max(0, steps.length - shown.length) };
}

export function sitePageHtml(input: PdfPageInput, brand: PdfBrand | undefined, opts: SitePageOptions): string {
  const t = pdfTheme(brand);
  const name = t.name ?? input.product ?? "Help";
  const { html, toc, more } = sitePageBody(input.markdown, input.baseDir, opts.maxSteps ?? 2);
  const section = (input.section ?? "").split("/").map((s) => s.trim()).filter(Boolean);
  const checked = humanDate(opts.facts.lastChecked);
  const logo = t.logo ? `<img class="logo" src="${t.logo}" alt="" />` : `<span class="logo-mark">${escapeHtml(name.slice(0, 1))}</span>`;
  const siblings = (opts.siblings ?? []).filter((s) => s !== input.title).slice(0, 6);
  const nav = [
    ...siblings.slice(0, 2).map((s) => `<a>${escapeHtml(s)}</a>`),
    `<a class="active">${escapeHtml(input.title)}</a>`,
    ...siblings.slice(2).map((s) => `<a>${escapeHtml(s)}</a>`),
  ].join("");
  const fontLink = t.fontUrl ? `<link rel="stylesheet" href="${escapeHtml(t.fontUrl)}">` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(input.title)}</title>${fontLink}<style>
${opts.brandCss}
${t.fontFaceCss ?? ""}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--color-fd-background); color: var(--color-fd-foreground); }
body { width: ${SITE_PAGE_WIDTH}px; font-family: var(--font-sans); font-size: 15px; line-height: 1.65; -webkit-font-smoothing: antialiased; }
h1, h2, h3, h4 { font-family: var(--font-heading); }
.top { height: 56px; display: flex; align-items: center; gap: 14px; padding: 0 22px; border-bottom: 1px solid var(--color-fd-border); background: var(--color-fd-background); }
.top .name { font-weight: 650; font-size: 15px; }
.logo { height: 26px; width: auto; max-width: 140px; object-fit: contain; }
.logo-mark { width: 26px; height: 26px; border-radius: 7px; display: inline-flex; align-items: center; justify-content: center; background: var(--color-fd-primary); color: var(--color-fd-primary-foreground); font-weight: 700; }
.search { margin-left: 30px; width: 300px; height: 34px; border-radius: 9px; border: 1px solid var(--color-fd-border); background: var(--color-fd-card); color: var(--color-fd-muted-foreground); font-size: 13px; display: flex; align-items: center; padding: 0 12px; }
.search kbd { margin-left: auto; font: inherit; font-size: 11px; border: 1px solid var(--color-fd-border); border-radius: 5px; padding: 0 5px; }
.shell { display: grid; grid-template-columns: 250px minmax(0, 1fr) 210px; }
aside.side { border-right: 1px solid var(--color-fd-border); padding: 20px 14px; min-height: 100%; font-size: 13.5px; }
aside.side .group { font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--color-fd-muted-foreground); margin: 6px 10px 6px; }
aside.side a { display: block; padding: 6px 10px; border-radius: 7px; color: var(--color-fd-muted-foreground); }
aside.side a.active { background: color-mix(in oklab, var(--color-fd-primary) 10%, transparent); color: var(--color-fd-primary); font-weight: 500; }
main { padding: 26px 44px 40px; min-width: 0; }
.crumbs { font-size: 13px; color: var(--color-fd-muted-foreground); margin-bottom: 10px; }
header.guide { border-bottom: 1px solid var(--color-fd-border); padding-bottom: 20px; margin-bottom: 22px; display: flex; flex-direction: column; gap: 12px; }
header.guide h1 { font-size: 30px; line-height: 1.2; letter-spacing: -0.02em; font-weight: 650; margin: 0; }
header.guide .desc { font-size: 17px; color: var(--color-fd-muted-foreground); margin: 0; }
.facts { display: flex; flex-wrap: wrap; gap: 8px 16px; font-size: 13.5px; color: var(--color-fd-muted-foreground); align-items: center; }
.ok { display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px; border-radius: 999px; font-size: 12.5px; font-weight: 500;
  background: color-mix(in oklab, #16a34a 12%, transparent); color: #15803d; }
.ok.no { background: color-mix(in oklab, #d97706 14%, transparent); color: #b45309; }
.actions { display: flex; gap: 8px; }
.btn { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border-radius: var(--brand-radius, 8px); border: 1px solid var(--color-fd-border); background: var(--color-fd-card); font-size: 13px; font-weight: 500; }
.video { position: relative; border-radius: calc(var(--brand-radius, 8px) + 4px); overflow: hidden; border: 1px solid var(--color-fd-border); aspect-ratio: 16 / 9; background: #0b1020; margin-bottom: 26px; }
.video img { width: 100%; height: 100%; object-fit: cover; display: block; }
.video .play { position: absolute; left: 14px; bottom: 14px; width: 44px; height: 44px; border-radius: 50%; background: var(--color-fd-primary); box-shadow: 0 6px 18px rgb(0 0 0 / .35); }
.video .play::after { content: ""; position: absolute; left: 17px; top: 13px; border-left: 14px solid var(--color-fd-primary-foreground); border-top: 9px solid transparent; border-bottom: 9px solid transparent; }
.body h2 { font-size: 22px; letter-spacing: -0.01em; margin: 30px 0 10px; }
.body h3 { margin-top: 2.2rem; padding-bottom: .5rem; border-bottom: 1px solid var(--color-fd-border); font-size: 1.05rem; }
.body h4.step { display: flex; align-items: center; gap: .75rem; margin: 2rem 0 .4rem; font-size: 1.05rem; }
.body h4.step .badge { flex: none; width: 1.75rem; height: 1.75rem; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center;
  background: var(--color-fd-primary); color: var(--color-fd-primary-foreground); font-size: .85rem; font-weight: 700; }
.body p, .body ul { margin: .5rem 0; }
.body ul { padding-left: 1.3rem; }
.body img { display: block; max-width: 100%; height: auto; margin: 14px 0 6px; border-radius: var(--brand-radius, 8px); border: 1px solid var(--color-fd-border); box-shadow: 0 6px 20px -12px rgb(15 23 42 / .35); }
.body strong { font-weight: 600; }
.body blockquote { margin: 1rem 0; padding: .7rem 1rem; border-left: 3px solid var(--color-fd-primary); background: var(--color-fd-card); border-radius: 6px; }
.more { margin-top: 26px; padding: 14px 16px; border: 1px dashed var(--color-fd-border); border-radius: var(--brand-radius, 8px); color: var(--color-fd-muted-foreground); font-size: 14px; }
aside.toc { padding: 30px 18px; font-size: 12.5px; }
aside.toc .label { font-weight: 600; margin-bottom: 8px; }
aside.toc a { display: block; padding: 3px 0 3px 10px; border-left: 1px solid var(--color-fd-border); color: var(--color-fd-muted-foreground); }
aside.toc a:first-of-type { border-left-color: var(--color-fd-primary); color: var(--color-fd-foreground); }
</style></head><body>
<div class="top">${logo}<span class="name">${escapeHtml(name)}</span><div class="search">Search guides…<kbd>⌘K</kbd></div></div>
<div class="shell">
<aside class="side">${section.length > 0 ? `<div class="group">${escapeHtml(section[section.length - 1])}</div>` : ""}${nav}</aside>
<main>
${section.length > 0 ? `<div class="crumbs">${section.map(escapeHtml).join(" › ")}</div>` : ""}
<header class="guide"><h1>${escapeHtml(input.title)}</h1>${input.summary ? `<p class="desc">${escapeHtml(input.summary)}</p>` : ""}
<div class="facts"><span class="ok${opts.facts.passed ? "" : " no"}">${opts.facts.passed ? "✓ Checked" : "Not verified"}${checked ? ` ${escapeHtml(checked)}` : ""}</span><span>${opts.facts.steps} step${opts.facts.steps === 1 ? "" : "s"}</span>${opts.facts.for ? `<span>For ${escapeHtml(opts.facts.for.charAt(0).toLowerCase() + opts.facts.for.slice(1))}</span>` : ""}${opts.poster ? "<span>Watch the video</span>" : ""}</div>
${opts.facts.pdf ? `<div class="actions"><span class="btn">Download PDF</span><span class="btn">Quick reference card</span></div>` : ""}
</header>
${opts.poster ? `<div class="video"><img src="${escapeHtml(opts.poster)}" alt="" /><span class="play"></span></div>` : ""}
<div class="body">${html}${more > 0 ? `<div class="more">… and ${more} more step${more === 1 ? "" : "s"} on the page.</div>` : ""}</div>
</main>
<aside class="toc"><div class="label">On this page</div>${toc.slice(0, 12).map((s) => `<a>${s}</a>`).join("")}</aside>
</div></body></html>`;
}
