// Fumadocs source loader. Content and frontmatter come entirely from the aida
// engine's page builder (packages/engine/src/pages) — this file only wires
// Fumadocs up to read it. Keep it thin: no app logic here.
import { loader } from "fumadocs-core/source";
import { defineDocs } from "fumadocs-mdx/macro";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { z } from "zod";

// Extends Fumadocs' page schema with the frontmatter aida's page builder
// writes (packages/engine/src/pages/content.ts: title/for/walkthrough/
// lastChecked/passed/video/srt/vtt). Pages with `passed: false` are filtered
// out of the production build in app/(site)/[[...slug]]/page.tsx.
export const aidaPageSchema = pageSchema.extend({
  for: z.string().optional(),
  walkthrough: z.string().optional(),
  lastChecked: z.string().optional(),
  passed: z.boolean().optional(),
  video: z.string().optional(),
  srt: z.string().optional(),
  vtt: z.string().optional(),
  // Printable guides (packages/engine/src/pdf): paths to the page's own PDF and one-page
  // quick-reference card, written by the pdf build stage (pdf/frontmatter.ts). Optional — unset
  // until `aida build`/`aida pdf` has run at least once.
  pdf: z.string().optional(),
  pdfCard: z.string().optional(),
  // Library hierarchy (engine index stage): what the page is, where it sits, and what its cards
  // show. `placeholder` marks a template page aida may replace; the site hides a placeholder
  // section that has no pages yet (lib/tree.ts).
  kind: z.enum(["home", "section", "walkthrough"]).optional(),
  section: z.string().optional(),
  steps: z.number().optional(),
  poster: z.string().optional(),
  chapters: z.string().optional(),
  placeholder: z.boolean().optional(),
  generated: z.boolean().optional(),
});

const docs = defineDocs({
  dir: "content/docs",
  docs: { schema: aidaPageSchema },
  meta: { schema: metaSchema },
});

// See https://fumadocs.dev/docs/headless/source-api
export const source = loader({
  baseUrl: "/",
  source: docs.toFumadocsSource(),
});
