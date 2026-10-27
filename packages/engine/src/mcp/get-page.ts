// Backs the MCP server's `get_page` tool (and could back a future help-app route) by reading
// one page's plain Markdown straight out of `public/llms.txt` — the same file already built by
// the index stage (`buildLlmsTxt` in build/index-stage.ts), sectioned `# <id>` per page with
// aida's generated-block markers already stripped. No separate per-page file needs shipping.
//
// Sections are split on `LLMS_TXT_SECTION_DELIMITER`, not a bare `---` line: a page's own
// frontmatter is also `---`-delimited, and a bare `---` is valid Markdown (a horizontal rule)
// that can appear in page body text, so splitting on it broke pages apart at the wrong points
// and `get_page` returned empty for every page (review finding get-page.ts:10).
import { LLMS_TXT_SECTION_DELIMITER } from "../build/index-stage.js";

const SECTION_RE = /^# (.+)$/;

/** Splits `llms.txt`'s contents into `{ id: content }`, trimming the leading `# <id>` header off
 * each section (matches `buildLlmsTxt`'s `# ${id}\n\n${content}`, sections joined by
 * `LLMS_TXT_SECTION_DELIMITER`). */
export function parseLlmsTxt(llmsTxt: string): Map<string, string> {
  const sections = llmsTxt.split(LLMS_TXT_SECTION_DELIMITER);
  const byId = new Map<string, string>();
  for (const section of sections) {
    const lines = section.trimStart().split("\n");
    const match = SECTION_RE.exec(lines[0] ?? "");
    if (!match) continue;
    byId.set(match[1].trim(), lines.slice(1).join("\n").trim());
  }
  return byId;
}

/** `slug` is a page URL (e.g. "/how-do-i/payments/record-a-payment", the legacy flat
 * "/record-a-payment", or a bare "record-a-payment") — matched against the walkthrough id
 * llms.txt sections are keyed by. A walkthrough page's folder is always its id
 * (walkthrough/placement.ts), so a nested URL resolves by its last segment. Returns `undefined`
 * (so the tool reports "not found") for both a missing page and one whose section body is empty. */
export function getPageFromLlmsTxt(llmsTxt: string, slug: string): string | undefined {
  const path = slug.split("#")[0].split("?")[0].replace(/^\/+|\/+$/g, "");
  const sections = parseLlmsTxt(llmsTxt);
  const content = sections.get(path) ?? sections.get(path.split("/").pop() ?? path);
  return content ? content : undefined;
}
