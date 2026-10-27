// Light lexing shared by the schema readers (domain/drizzle.ts, prisma.ts, sql.ts): bracket
// matching and top-level splitting that skip strings and comments, and the plain-words names
// the summary uses ("payment_links" -> "Payment link"). Static text only: nothing here runs the
// app's code or talks to a database.

export type LexMode = "ts" | "sql";

const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const CLOSE = new Set([")", "]", "}"]);

/** When `i` starts a string or comment, the index just past it; otherwise -1. */
export function skipNonCode(text: string, i: number, mode: LexMode): number {
  const c = text[i];
  const next = text[i + 1];
  if (c === "/" && next === "*") {
    const end = text.indexOf("*/", i + 2);
    return end < 0 ? text.length : end + 2;
  }
  if (mode === "ts" && c === "/" && next === "/") {
    const end = text.indexOf("\n", i);
    return end < 0 ? text.length : end;
  }
  if (mode === "sql" && c === "-" && next === "-") {
    const end = text.indexOf("\n", i);
    return end < 0 ? text.length : end;
  }
  if (c === "'" || c === '"') {
    let j = i + 1;
    while (j < text.length) {
      if (mode === "ts" && text[j] === "\\") {
        j += 2;
        continue;
      }
      if (text[j] === c) {
        // SQL doubles a quote to escape it: 'it''s'.
        if (mode === "sql" && text[j + 1] === c) {
          j += 2;
          continue;
        }
        return j + 1;
      }
      j++;
    }
    return text.length;
  }
  if (mode === "ts" && c === "`") {
    let j = i + 1;
    while (j < text.length) {
      if (text[j] === "\\") {
        j += 2;
        continue;
      }
      if (text[j] === "`") return j + 1;
      if (text[j] === "$" && text[j + 1] === "{") {
        const end = findMatching(text, j + 1, mode);
        j = end < 0 ? text.length : end + 1;
        continue;
      }
      j++;
    }
    return text.length;
  }
  if (mode === "sql" && c === "$") {
    const tag = /^\$[A-Za-z_]*\$/.exec(text.slice(i, i + 64));
    if (tag) {
      const end = text.indexOf(tag[0], i + tag[0].length);
      return end < 0 ? text.length : end + tag[0].length;
    }
  }
  return -1;
}

/** Index of the bracket closing the one at `open`, or -1 when it never closes. */
export function findMatching(text: string, open: number, mode: LexMode): number {
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const skip = skipNonCode(text, i, mode);
    if (skip >= 0) {
      i = skip - 1;
      continue;
    }
    const c = text[i];
    if (OPEN[c]) stack.push(OPEN[c]);
    else if (CLOSE.has(c)) {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** Splits on `sep` at bracket depth 0, outside strings and comments. Parts are trimmed; empty
 * parts dropped. */
export function splitTopLevel(text: string, sep: string, mode: LexMode): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const skip = skipNonCode(text, i, mode);
    if (skip >= 0) {
      i = skip - 1;
      continue;
    }
    const c = text[i];
    if (OPEN[c]) depth++;
    else if (CLOSE.has(c)) depth--;
    else if (depth === 0 && text.startsWith(sep, i)) {
      parts.push(text.slice(start, i));
      start = i + sep.length;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Removes comments (keeping strings intact). */
export function stripComments(text: string, mode: LexMode): string {
  let out = "";
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const skip = skipNonCode(text, i, mode);
    if (skip < 0) continue;
    const isComment = text[i] === "/" || (mode === "sql" && text[i] === "-");
    if (isComment) {
      out += text.slice(last, i);
      last = skip;
    }
    i = skip - 1;
  }
  return out + text.slice(last);
}

/** Every single- or double-quoted (or backtick) literal in `text`, unquoted. */
export function stringLiterals(text: string): string[] {
  return [...text.matchAll(/'((?:[^'\\]|\\.|'')*)'|"((?:[^"\\]|\\.)*)"|`([^`$]*)`/g)].map((m) =>
    (m[1] ?? m[2] ?? m[3] ?? "").replace(/''/g, "'"),
  );
}

/**
 * Enum-like values from a CHECK constraint's SQL: `status = ANY (ARRAY['a'::text, 'b'::text])`
 * (Postgres' own form, as drizzle-kit introspection writes it) or `status IN ('a', 'b')`.
 * Range checks (`fee >= 0`) give nothing.
 */
export function parseCheckEnums(sql: string): { column: string; values: string[] }[] {
  const out: { column: string; values: string[] }[] = [];
  const col = String.raw`\(*\s*"?([A-Za-z_][\w]*)"?\s*\)*(?:\s*::\s*[\w ]+?(?:\[\])?)?`;
  const anyRe = new RegExp(`${col}\\s*=\\s*ANY\\s*\\(\\s*\\(?\\s*ARRAY\\s*\\[([^\\]]*)\\]`, "gi");
  const inRe = new RegExp(`${col}\\s+IN\\s*\\(([^)]*)\\)`, "gi");
  for (const re of [anyRe, inRe]) {
    for (const m of sql.matchAll(re)) {
      const values = [...m[2].matchAll(/'((?:[^']|'')*)'/g)].map((v) => v[1].replace(/''/g, "'"));
      if (values.length > 0) out.push({ column: m[1], values });
    }
  }
  return out;
}

const IRREGULAR: Record<string, string> = { people: "person", children: "child", men: "man", women: "woman", data: "data", media: "media", criteria: "criterion", series: "series", news: "news" };

/** A word's singular, by simple English rules ("entries" -> "entry", "classes" -> "class"). */
export function singular(word: string): string {
  const lower = word.toLowerCase();
  if (IRREGULAR[lower]) return matchCase(word, IRREGULAR[lower]);
  if (/[^aeiou]ies$/i.test(word)) return word.slice(0, -3) + "y";
  if (/(sses|xes|ches|shes|zzes|tuses)$/i.test(word)) return word.slice(0, -2);
  if (/[^su]s$/i.test(word) && !/(is|ss|us)$/i.test(word)) return word.slice(0, -1);
  return word;
}

/** A word's plural ("entry" -> "entries", "class" -> "classes"). */
export function plural(word: string): string {
  const lower = word.toLowerCase();
  const irregular = Object.entries(IRREGULAR).find(([, s]) => s === lower);
  if (irregular && irregular[0] !== lower) return matchCase(word, irregular[0]);
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + "ies";
  if (/(s|x|ch|sh|z)$/i.test(word)) return word + "es";
  return word + "s";
}

function matchCase(original: string, replacement: string): string {
  return original[0] === original[0].toUpperCase() ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
}

/** Words of an identifier: "payment_links" / "paymentLinks" / "PaymentLink" -> ["payment", "links"]. */
export function identifierWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.\s]+/g, " ")
    .trim()
    .toLowerCase()
    .split(" ")
    .filter(Boolean);
}

/** The plain-words, singular name of a table or model: "payment_links" -> "Payment link". */
export function entityLabel(name: string): string {
  const words = identifierWords(name);
  if (words.length === 0) return name;
  words[words.length - 1] = singular(words[words.length - 1]);
  const text = words.join(" ");
  return text[0].toUpperCase() + text.slice(1);
}

/** A column's plain-words name: "starts_at" -> "starts at". */
export function columnLabel(name: string): string {
  return identifierWords(name).join(" ");
}

/** A column default as a reader would say it, from Drizzle `.default(...)`, Prisma `@default(...)`
 * or SQL `DEFAULT ...`: a quoted value unquoted (`'pending'::payment_status` -> `pending`), a
 * number, boolean or enum member as written (`Status.PENDING` -> `PENDING`), a function call kept
 * (`now()`); `NULL`, empty and long expressions give undefined. */
export function readableDefault(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let text = raw.trim().replace(/\s+as\s+const$/, "").trim();
  // Drizzle's sql`now()` and a SQL expression in parentheses.
  const tagged = /^sql\s*`([^`]*)`$/.exec(text);
  if (tagged) text = tagged[1].trim();
  while (/^\(.*\)$/.test(text) && findMatching(text, 0, "sql") === text.length - 1) text = text.slice(1, -1).trim();
  text = text.replace(/::[\w\s."\[\]]+$/, "").trim();
  if (!text || /^null$/i.test(text)) return undefined;
  const quoted = /^(['"`])([\s\S]*)\1$/.exec(text);
  if (quoted) return quoted[2].replace(/''/g, "'");
  const member = /^[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)$/.exec(text);
  if (member) return member[1];
  if (text.length > 40) return undefined;
  return text.replace(/^current_timestamp$/i, "now()");
}
