// A walkthrough target as Playwright locator code that finds what capture/locate.ts finds:
// role and name (with `text` as a has-text filter), label, placeholder, text or css, narrowed by
// `within`, `hasText`, visible matches only, then the first match, the `nth` or (`innermost`) the
// last. `padUnion` only grows a highlight box, so it has no part in finding the element.
import type { Target } from "../walkthrough/index.js";
import { CodeContext, regex, str } from "./code.js";
import { LABEL_HELPER } from "./helpers.js";

/** locate.ts's `textArg`: a `/source/` string is a regular expression (no flags), else literal. */
function textArg(text: string, ctx: CodeContext): string {
  return /^\/.*\/$/.test(text) ? regex(text.slice(1, -1), "", ctx) : str(text, ctx);
}

/** Every visible element `target` matches, before the first/nth/last narrowing (locateAll). */
function locateAllCode(t: Target, root: string, ctx: CodeContext): string {
  const base = t.within ? locatorCode(t.within, root, ctx) : root;
  let loc: string;
  if (t.role) {
    const opts = [t.name !== undefined && t.name !== "" ? `name: ${str(t.name, ctx)}` : "", t.exact === true ? "exact: true" : ""].filter(Boolean);
    loc = `${base}.getByRole(${str(t.role, ctx)}${opts.length > 0 ? `, { ${opts.join(", ")} }` : ""})`;
    if (t.text) loc += `.filter({ hasText: ${textArg(t.text, ctx)} })`;
  } else if (t.label) {
    if (t.exact === true) {
      loc = `${base}.getByLabel(${str(t.label, ctx)}, { exact: true })`;
    } else {
      // Capture looks at the page before it picks the hint fallback, which no single locator
      // can do: an `.or()` of the two would count first/nth/last over both sets together.
      ctx.helpers.add("label");
      loc = `(await ${LABEL_HELPER}(${base}, ${str(t.label, ctx)}))`;
    }
  } else if (t.placeholder) {
    loc = `${base}.getByPlaceholder(${str(t.placeholder, ctx)}, { exact: true })`;
  } else if (t.text) {
    loc = `${base}.getByText(${textArg(t.text, ctx)}${t.exact === true ? ", { exact: true }" : ""})`;
  } else if (t.css) {
    loc = `${base}.locator(${str(t.css, ctx)})`;
  } else {
    throw new Error(`target needs role/label/placeholder/text/css: ${JSON.stringify(t)}`);
  }
  if (t.hasText) loc += `.filter({ hasText: ${str(t.hasText, ctx)} })`;
  return `${loc}.filter({ visible: true })`;
}

/** The one element capture acts on (locate): `nth` wins over `innermost`, else the first. */
export function locatorCode(t: Target, root: string, ctx: CodeContext): string {
  const all = locateAllCode(t, root, ctx);
  if (typeof t.nth === "number") return `${all}.nth(${t.nth})`;
  return t.innermost ? `${all}.last()` : `${all}.first()`;
}
