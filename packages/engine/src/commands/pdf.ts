// `aida pdf [walkthrough...] --config <cfg> [--json]`: renders each walkthrough's PDFs
// (<id>.pdf, <id>.card.pdf) from its already-built page, plus the combined manual.pdf over
// every publishable page on disk. See docs/scope.md "Printable guides", build-plan.md M12.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/index.js";
import { loadWalkthroughFile, type Walkthrough } from "../walkthrough/index.js";
import type { BuildPageResult } from "../pages/index.js";
import {
  buildManualPdf,
  buildWalkthroughPdf,
  launchBrowser,
  pdfInputFromPage,
  pdfPublicLinks,
  resolvePdfBrand,
  setPdfFrontmatter,
  type PdfBuildResult,
} from "../pdf/index.js";

export interface RunPdfOptions {
  configPath: string;
  walkthroughIds: string[];
  force?: boolean;
}

function findWalkthroughFiles(dir: string, ids: string[]): string[] {
  const all = readdirSync(dir)
    .filter((f) => /\.(ya?ml)$/i.test(f))
    .map((f) => join(dir, f))
    .sort();
  if (ids.length === 0) return all;
  return ids.map((id) => {
    if (existsSync(id)) return id;
    const match = all.find((f) => f.endsWith(`/${id}.yaml`) || f.endsWith(`/${id}.yml`));
    if (!match) throw new Error(`no walkthrough found for "${id}" in ${dir}`);
    return match;
  });
}

function readPageCache(buildDir: string, id: string): BuildPageResult | undefined {
  const cacheFile = join(buildDir, id, "pages-cache.json");
  if (!existsSync(cacheFile)) return undefined;
  try {
    const cache = JSON.parse(readFileSync(cacheFile, "utf8")) as { result: BuildPageResult };
    return cache.result;
  } catch {
    return undefined;
  }
}

export interface RunPdfResult {
  ok: boolean;
  walkthroughs: Array<PdfBuildResult & { error?: string }>;
  manual: { file: string; skipped: boolean; pageCount?: number; included: string[] };
}

export async function runPdfCommand(opts: RunPdfOptions, json: boolean): Promise<number> {
  const config = await loadConfig(opts.configPath);
  const files = findWalkthroughFiles(config.walkthroughsDir, opts.walkthroughIds);
  const pdfDir = join(config.outDir, "pdf");
  const brand = resolvePdfBrand(config);
  const paper = config.pdf?.paper ?? "A4";

  const browser = await launchBrowser();
  const results: Array<PdfBuildResult & { error?: string }> = [];
  try {
    for (const file of files) {
      const wf: Walkthrough = loadWalkthroughFile(file);
      const page = readPageCache(config.buildDir, wf.walkthrough);
      if (!page) {
        results.push({
          id: wf.walkthrough,
          file: join(pdfDir, `${wf.walkthrough}.pdf`),
          cardFile: join(pdfDir, `${wf.walkthrough}.card.pdf`),
          skipped: false,
          excluded: true,
          error: `no page built for "${wf.walkthrough}" — run \`aida pages ${wf.walkthrough} --config ${opts.configPath}\` (or \`aida build --only pages\`) first`,
        });
        continue;
      }
      try {
        const input = pdfInputFromPage(wf, page);
        const result = await buildWalkthroughPdf(input, { pdfDir, paper, brand, force: opts.force }, browser);
        if (!result.excluded) {
          setPdfFrontmatter(page.indexFile, pdfPublicLinks(wf.walkthrough));
        }
        results.push(result);
      } catch (err) {
        results.push({
          id: wf.walkthrough,
          file: join(pdfDir, `${wf.walkthrough}.pdf`),
          cardFile: join(pdfDir, `${wf.walkthrough}.card.pdf`),
          skipped: false,
          excluded: false,
          error: (err as Error).message,
        });
      }
    }

    // manual.pdf always covers every publishable page currently on disk, not just the
    // walkthroughs this invocation named (mirrors the index stage's llms.txt/search-index
    // behaviour — see build/index-stage.ts).
    const allFiles = findWalkthroughFiles(config.walkthroughsDir, []);
    const allInputs = allFiles
      .map((f) => {
        const wf = loadWalkthroughFile(f);
        const page = readPageCache(config.buildDir, wf.walkthrough);
        return page ? pdfInputFromPage(wf, page) : undefined;
      })
      .filter((i): i is NonNullable<typeof i> => Boolean(i));
    const manual = await buildManualPdf(allInputs, { pdfDir, paper, brand, force: opts.force }, browser);

    const ok = results.every((r) => !r.error);
    const output: RunPdfResult = { ok, walkthroughs: results, manual };

    if (json) {
      console.log(JSON.stringify(output));
    } else {
      for (const r of results) {
        if (r.error) console.log(`${r.id}: FAILED — ${r.error}`);
        else if (r.excluded) console.log(`${r.id}: excluded (not publishable)`);
        else if (r.skipped) console.log(`${r.id}: unchanged -> ${r.file}`);
        else console.log(`${r.id}: ${r.file} (${r.bytes ?? 0}B), card ${r.cardFile} (${r.cardBytes ?? 0}B)`);
      }
      console.log(manual.skipped ? `manual: unchanged -> ${manual.file}` : `manual: ${manual.file} (${manual.pageCount} pages, ${manual.included.length} guide(s))`);
    }
    return ok ? 0 : 1;
  } finally {
    await browser.close();
  }
}
