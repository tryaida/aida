// Replays SQL migrations statically, in filename order: CREATE TABLE / ALTER TABLE (add, drop,
// rename and retype columns; add foreign keys and CHECK lists) / DROP TABLE, and CREATE TYPE ...
// AS ENUM / ALTER TYPE ... ADD VALUE. `DO $$ ... $$` blocks (drizzle-kit wraps enum and foreign
// key statements in them) are opened and replayed too; functions, policies and grants are skipped.
// Tables outside the public schema are left out of the model.
import { findMatching, parseCheckEnums, skipNonCode, splitTopLevel, stringLiterals } from "./text.js";
import type { RawColumn, RawSchema, RawTable } from "./types.js";

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`;
const QNAME = String.raw`(${IDENT}(?:\s*\.\s*${IDENT})?)`;
const COLUMN_STOP = /^(not|null|default|primary|references|unique|check|constraint|generated|collate|identity)$/i;
const TABLE_CONSTRAINT = /^(constraint|primary|unique|foreign|check|exclude|like)\b/i;

interface State {
  tables: Map<string, RawTable>;
  enums: Map<string, string[]>;
  /** `table.constraint` -> column whose enum values came from that CHECK constraint. */
  checks: Map<string, string>;
}

/** Splits SQL into statements on `;`, outside strings, dollar quotes and comments; comments
 * are dropped. */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current = "";
  for (let i = 0; i < sql.length; i++) {
    const skip = skipNonCode(sql, i, "sql");
    if (skip >= 0) {
      const isComment = sql[i] === "-" || sql[i] === "/";
      current += isComment ? " " : sql.slice(i, skip);
      i = skip - 1;
      continue;
    }
    if (sql[i] === ";") {
      if (current.trim()) out.push(current.trim());
      current = "";
    } else current += sql[i];
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** `"public"."Events"` -> { schema: "public", name: "Events" }. */
function qualified(raw: string): { schema?: string; name: string } {
  const parts = raw.split(".").map((p) => p.trim().replace(/^"|"$/g, ""));
  return parts.length > 1 ? { schema: parts[0], name: parts[1] } : { name: parts[0] };
}

function tableKey(raw: string): string | undefined {
  const { schema, name } = qualified(raw);
  if (schema && schema.toLowerCase() !== "public") return undefined;
  return name;
}

function refName(raw: string): string {
  const { schema, name } = qualified(raw);
  return schema && schema.toLowerCase() !== "public" ? `${schema}.${name}` : name;
}

function unquote(s: string): string {
  return s.trim().replace(/^"|"$/g, "");
}

export function parseSqlMigrations(files: { path: string; text: string }[]): RawSchema {
  const state: State = { tables: new Map(), enums: new Map(), checks: new Map() };
  for (const file of files) {
    for (const stmt of splitStatements(file.text)) applyStatement(stmt, state, 0);
  }
  // Enum-typed columns: the type may be schema-qualified or created after the table.
  for (const table of state.tables.values()) {
    for (const col of table.columns) {
      const typeName = col.type.replace(/^public\./, "").replace(/\[\]$/, "");
      if (!col.enum && state.enums.has(typeName)) {
        col.enum = typeName;
        col.type = typeName;
      }
    }
  }
  return { tables: [...state.tables.values()], enums: state.enums };
}

function applyStatement(stmt: string, state: State, depth: number): void {
  const s = stmt.replace(/^\s*(begin|commit|end)\b\s*/i, "").trim();
  if (!s) return;
  let m: RegExpExecArray | null;

  if ((m = /^do\b/i.exec(s)) && depth < 2) {
    const body = /\$([A-Za-z_]*)\$([\s\S]*)\$\1\$/.exec(s);
    if (body) for (const inner of splitStatements(body[2])) applyStatement(inner, state, depth + 1);
    return;
  }

  if ((m = new RegExp(String.raw`^create\s+type\s+${QNAME}\s+as\s+enum\s*\(([\s\S]*)\)`, "i").exec(s))) {
    state.enums.set(qualified(m[1]).name, stringLiterals(m[2]));
    return;
  }
  if ((m = new RegExp(String.raw`^alter\s+type\s+${QNAME}\s+add\s+value\s+(?:if\s+not\s+exists\s+)?'((?:[^']|'')*)'(?:\s+(before|after)\s+'((?:[^']|'')*)')?`, "i").exec(s))) {
    const values = state.enums.get(qualified(m[1]).name);
    if (values && !values.includes(m[2])) {
      const at = m[4] ? values.indexOf(m[4]) : -1;
      if (at >= 0) values.splice(m[3].toLowerCase() === "before" ? at : at + 1, 0, m[2]);
      else values.push(m[2]);
    }
    return;
  }
  if ((m = new RegExp(String.raw`^alter\s+type\s+${QNAME}\s+rename\s+value\s+'((?:[^']|'')*)'\s+to\s+'((?:[^']|'')*)'`, "i").exec(s))) {
    const values = state.enums.get(qualified(m[1]).name);
    const at = values?.indexOf(m[2]) ?? -1;
    if (values && at >= 0) values[at] = m[3];
    return;
  }
  if ((m = new RegExp(String.raw`^drop\s+type\s+(?:if\s+exists\s+)?${QNAME}`, "i").exec(s))) {
    state.enums.delete(qualified(m[1]).name);
    return;
  }

  if ((m = new RegExp(String.raw`^create\s+(?:(?:global\s+|local\s+)?(?:temp|temporary|unlogged)\s+)?table\s+(if\s+not\s+exists\s+)?${QNAME}\s*\(`, "i").exec(s))) {
    const key = tableKey(m[2]);
    const open = m.index + m[0].length - 1;
    const close = findMatching(s, open, "sql");
    if (!key || close < 0) return;
    // IF NOT EXISTS on a table that's already there does nothing in Postgres.
    if (m[1] && state.tables.has(key)) return;
    const table: RawTable = { name: key, columns: [] };
    state.tables.set(key, table);
    for (const def of splitTopLevel(s.slice(open + 1, close), ",", "sql")) {
      if (TABLE_CONSTRAINT.test(def)) applyConstraint(def, table, state);
      else addColumn(def, table, state);
    }
    return;
  }

  if ((m = new RegExp(String.raw`^drop\s+table\s+(?:if\s+exists\s+)?([\s\S]+?)(?:\s+(?:cascade|restrict))?$`, "i").exec(s))) {
    for (const name of splitTopLevel(m[1], ",", "sql")) {
      const key = tableKey(name);
      if (key) state.tables.delete(key);
    }
    return;
  }

  if ((m = new RegExp(String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${QNAME}\s+([\s\S]+)$`, "i").exec(s))) {
    const key = tableKey(m[1]);
    const table = key ? state.tables.get(key) : undefined;
    if (!key || !table) return;
    const rename = /^rename\s+to\s+(\S+)/i.exec(m[2]);
    if (rename) {
      renameTable(table, unquote(rename[1]), state);
      return;
    }
    for (const action of splitTopLevel(m[2], ",", "sql")) applyAlterAction(action, table, state);
  }
}

function applyAlterAction(action: string, table: RawTable, state: State): void {
  let m: RegExpExecArray | null;
  if ((m = /^add\s+(?=(?:constraint|primary|unique|foreign|check|exclude)\b)([\s\S]+)$/i.exec(action))) {
    applyConstraint(m[1], table, state);
  } else if ((m = /^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?([\s\S]+)$/i.exec(action))) {
    addColumn(m[1], table, state);
  } else if ((m = new RegExp(String.raw`^drop\s+(?:column\s+)?(?:if\s+exists\s+)?(${IDENT})`, "i").exec(action)) && !/^drop\s+constraint/i.test(action)) {
    dropColumn(table, unquote(m[1]), state);
  } else if ((m = new RegExp(String.raw`^drop\s+constraint\s+(?:if\s+exists\s+)?(${IDENT})`, "i").exec(action))) {
    const key = `${table.name}.${unquote(m[1])}`;
    const colName = state.checks.get(key);
    const col = table.columns.find((c) => c.name === colName);
    if (col && col.enum === `${table.name}.${col.name}`) {
      state.enums.delete(col.enum);
      delete col.enum;
    }
    state.checks.delete(key);
  } else if ((m = new RegExp(String.raw`^rename\s+(?:column\s+)?(${IDENT})\s+to\s+(${IDENT})`, "i").exec(action))) {
    renameColumn(table, unquote(m[1]), unquote(m[2]), state);
  } else if ((m = new RegExp(String.raw`^alter\s+(?:column\s+)?(${IDENT})\s+(?:set\s+data\s+)?type\s+([\s\S]+?)(?:\s+using\s[\s\S]*)?$`, "i").exec(action))) {
    const col = table.columns.find((c) => c.name === unquote(m![1]));
    if (col) {
      col.type = normalizeType(m[2]);
      if (col.enum && !col.enum.includes(".")) delete col.enum;
    }
  }
}

function normalizeType(raw: string): string {
  return raw
    .trim()
    .replace(/"/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*\(\s*/g, "(")
    .replace(/\s*\)/g, ")")
    .toLowerCase();
}

function addColumn(raw: string, table: RawTable, state: State): void {
  const def = raw.trim();
  const nameMatch = new RegExp(String.raw`^(${IDENT})\s+`).exec(def);
  if (!nameMatch) return;
  const name = unquote(nameMatch[1]);
  const rest = def.slice(nameMatch[0].length).replace(/\s+/g, " ");
  // The type runs until the first constraint keyword.
  const words = splitTopLevel(rest, " ", "sql");
  const typeWords: string[] = [];
  for (const w of words) {
    if (COLUMN_STOP.test(w)) break;
    typeWords.push(w);
  }
  const col: RawColumn = { name, type: normalizeType(typeWords.join(" ")) || "unknown" };
  if (/\bprimary\s+key\b/i.test(rest)) col.primaryKey = true;
  const ref = new RegExp(String.raw`\breferences\s+${QNAME}\s*(?:\(\s*(${IDENT})\s*\))?`, "i").exec(rest);
  if (ref) col.ref = { table: refName(ref[1]), column: ref[2] ? unquote(ref[2]) : "id" };
  const existing = table.columns.findIndex((c) => c.name === name);
  if (existing >= 0) table.columns[existing] = col;
  else table.columns.push(col);
  const check = /\bcheck\s*\(/i.exec(rest);
  if (check) applyCheck(rest.slice(check.index), undefined, table, state);
}

function applyConstraint(def: string, table: RawTable, state: State): void {
  const named = new RegExp(String.raw`^constraint\s+(${IDENT})\s+`, "i").exec(def);
  const constraint = named ? unquote(named[1]) : undefined;
  const body = named ? def.slice(named[0].length) : def;
  const fk = new RegExp(String.raw`^foreign\s+key\s*\(([^)]*)\)\s*references\s+${QNAME}\s*(?:\(([^)]*)\))?`, "i").exec(body);
  if (fk) {
    const cols = fk[1].split(",").map(unquote);
    const refs = (fk[3] ?? "id").split(",").map(unquote);
    cols.forEach((c, i) => {
      const col = table.columns.find((x) => x.name === c);
      if (col) col.ref = { table: refName(fk[2]), column: refs[i] ?? "id" };
    });
    return;
  }
  if (/^check\b/i.test(body)) applyCheck(body, constraint, table, state);
}

function applyCheck(text: string, constraint: string | undefined, table: RawTable, state: State): void {
  for (const { column, values } of parseCheckEnums(text)) {
    const col = table.columns.find((c) => c.name === column);
    if (!col || (col.enum && !col.enum.includes("."))) continue;
    col.enum = `${table.name}.${col.name}`;
    state.enums.set(col.enum, values);
    // Unnamed, Postgres calls it <table>_<column>_check: a later DROP CONSTRAINT uses that name.
    state.checks.set(`${table.name}.${constraint ?? `${table.name}_${col.name}_check`}`, col.name);
  }
}

/** Moves a CHECK-derived enum (keyed `table.column`) to a new key, on the column too. */
function rekeyEnum(state: State, col: RawColumn, next: string): void {
  if (!col.enum?.includes(".")) return;
  const values = state.enums.get(col.enum);
  state.enums.delete(col.enum);
  if (values) state.enums.set(next, values);
  col.enum = next;
}

function renameColumn(table: RawTable, from: string, to: string, state: State): void {
  const col = table.columns.find((c) => c.name === from);
  if (!col) return;
  col.name = to;
  if (col.enum === `${table.name}.${from}`) rekeyEnum(state, col, `${table.name}.${to}`);
  for (const [key, name] of state.checks) if (key.startsWith(`${table.name}.`) && name === from) state.checks.set(key, to);
  for (const t of state.tables.values()) for (const c of t.columns) if (c.ref?.table === table.name && c.ref.column === from) c.ref.column = to;
}

function dropColumn(table: RawTable, name: string, state: State): void {
  const col = table.columns.find((c) => c.name === name);
  if (!col) return;
  table.columns = table.columns.filter((c) => c !== col);
  if (col.enum === `${table.name}.${name}`) state.enums.delete(col.enum);
  for (const [key, colName] of state.checks) if (key.startsWith(`${table.name}.`) && colName === name) state.checks.delete(key);
  // DROP COLUMN ... CASCADE drops the foreign keys pointing at it, and without CASCADE it fails.
  for (const t of state.tables.values()) for (const c of t.columns) if (c.ref?.table === table.name && c.ref.column === name) delete c.ref;
}

function renameTable(table: RawTable, next: string, state: State): void {
  const prev = table.name;
  state.tables.delete(prev);
  table.name = next;
  state.tables.set(next, table);
  for (const c of table.columns) if (c.enum === `${prev}.${c.name}`) rekeyEnum(state, c, `${next}.${c.name}`);
  for (const [key, colName] of [...state.checks]) {
    if (!key.startsWith(`${prev}.`)) continue;
    state.checks.delete(key);
    state.checks.set(`${next}.${key.slice(prev.length + 1)}`, colName);
  }
  for (const t of state.tables.values()) for (const c of t.columns) if (c.ref?.table === prev) c.ref.table = next;
}
