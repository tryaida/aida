// Small code-writing helpers for `aida export playwright`: string, template and regex literals
// that stay valid TypeScript whatever the walkthrough (or the app's own text in it) contains.

/** Stands in for `{{run.id}}` while a walkthrough's data is resolved, so it can become `${runId}`
 * in the spec instead of a fixed value. A NUL never occurs in YAML text, so it can't clash. */
export const RUN_ID_MARK = "\u0000aida-run-id\u0000";

const DYNAMIC = /\u0000aida-run-id\u0000|\{\{\s*inbox\.(\w+)\s*\}\}/g;

/** What a spec's code used, so the test body declares only what it needs. */
export class CodeContext {
  usesRunId = false;
  readonly inboxKeys = new Set<string>();
  usesExpect = false;
  /** The spec helpers (helpers.ts) its code calls. */
  readonly helpers = new Set<"label" | "select" | "text">();
}

function hasDynamic(value: string): boolean {
  DYNAMIC.lastIndex = 0;
  return DYNAMIC.test(value);
}

/** A JSON string literal, with the two line separators JSON leaves bare written as escapes. */
export function jsString(value: string): string {
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** Escapes text for the inside of a template literal. */
function templateText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${").replace(/\r/g, "\\r").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/**
 * A string as code: a JSON string literal, or a template literal when it holds `{{run.id}}` or an
 * `{{inbox.<key>}}` value (filled in at run time, so they can't be fixed in the file).
 */
export function str(value: string, ctx: CodeContext): string {
  if (!hasDynamic(value)) return jsString(value);
  let out = "`";
  let last = 0;
  DYNAMIC.lastIndex = 0;
  for (const m of value.matchAll(DYNAMIC)) {
    out += templateText(value.slice(last, m.index));
    if (m[1] !== undefined) {
      ctx.inboxKeys.add(m[1]);
      out += `\${inbox[${jsString(m[1])}]}`;
    } else {
      ctx.usesRunId = true;
      out += "${runId}";
    }
    last = m.index + m[0].length;
  }
  return `${out}${templateText(value.slice(last))}\``;
}

/**
 * A regular expression as code: a `/source/flags` literal when the source can be written as one,
 * else `new RegExp(...)` (an empty source, which would read as a comment, a dynamic value, or a
 * source JavaScript wouldn't compile as a literal).
 */
export function regex(source: string, flags: string, ctx: CodeContext): string {
  if (hasDynamic(source)) return `new RegExp(${str(source, ctx)}${flags ? `, ${jsString(flags)}` : ""})`;
  let valid = true;
  try {
    new RegExp(source, flags);
  } catch {
    valid = false;
  }
  if (!valid || source === "") return `new RegExp(${jsString(source)}${flags ? `, ${jsString(flags)}` : ""})`;
  let body = "";
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      const next = source[i + 1];
      if (next === undefined) return `new RegExp(${jsString(source)}${flags ? `, ${jsString(flags)}` : ""})`;
      body += lineSafe(c + next);
      i++;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    if (c === "/" && !inClass) body += "\\/";
    else body += lineSafe(c);
  }
  return `/${body}/${flags}`;
}

/** A line terminator can't sit inside a regex literal: written as its escape instead. */
function lineSafe(text: string): string {
  return text.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** Text for a `//` comment: one line, whatever it held. */
export function commentText(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/g, " ").trim();
}

/** Control characters and the two Unicode line separators JavaScript ends a comment at. */
export const CONTROL_CHAR = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
