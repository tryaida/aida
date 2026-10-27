// Reads Drizzle schema files statically: `pgTable`/`mysqlTable`/`sqliteTable` (and tables made by
// `pgTableCreator` or `pgSchema(...).table`), their columns, `.references(() => other.id)`,
// `foreignKey({...})` and `check(...)` in the extra-config callback, `pgEnum`/`mysqlEnum`/
// `{ enum: [...] }` values, and `relations(... one(...))` for links with no foreign key. Never
// imports or runs the schema module.
import { findMatching, parseCheckEnums, splitTopLevel, stringLiterals, stripComments } from "./text.js";
import type { RawColumn, RawSchema, RawTable } from "./types.js";

export interface SourceFile {
  path: string;
  text: string;
}

/** True when the file looks like a Drizzle schema (declares at least one table). */
export function isDrizzleSchema(text: string): boolean {
  return /\b(pgTable|mysqlTable|sqliteTable|pgTableCreator|mysqlTableCreator|sqliteTableCreator)\s*\(/.test(text);
}

interface ParsedTable {
  varName: string;
  table: RawTable;
  /** TS property key -> column (keys can differ from database names). */
  byKey: Map<string, RawColumn>;
  /** Unresolved `.references(() => other.col)`: column key -> [table var, property]. */
  pendingRefs: Map<string, [string, string]>;
  extra?: string;
}

export function parseDrizzle(files: SourceFile[]): RawSchema {
  const texts = files.map((f) => stripComments(f.text, "ts"));
  const all = texts.join("\n");

  // Enum variables -> enum name + values. `pgEnum("status", STATUSES)` reads a const array.
  const constArrays = new Map<string, string[]>();
  for (const m of all.matchAll(/\bconst\s+(\w+)\s*=\s*\[/g)) {
    const open = m.index! + m[0].length - 1;
    const close = findMatching(all, open, "ts");
    if (close > 0) constArrays.set(m[1], stringLiterals(all.slice(open + 1, close)));
  }
  const enumVars = new Map<string, string>();
  const enums = new Map<string, string[]>();
  for (const m of all.matchAll(/\bconst\s+(\w+)\s*=\s*(?:\w+\.)?(?:pgEnum)\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const close = findMatching(all, open, "ts");
    if (close < 0) continue;
    const args = splitTopLevel(all.slice(open + 1, close), ",", "ts");
    const name = stringLiterals(args[0] ?? "")[0] ?? m[1];
    const valuesArg = (args[1] ?? "").replace(/\s+as\s+const$/, "").trim();
    const values = valuesArg.startsWith("[") ? stringLiterals(valuesArg) : (constArrays.get(valuesArg) ?? []);
    enumVars.set(m[1], name);
    enums.set(name, values);
  }

  // Table-making functions: the built-ins, plus `const createTable = pgTableCreator(...)` and
  // `const app = pgSchema("app")` (used as `app.table(...)`).
  const tableFns = ["pgTable", "mysqlTable", "sqliteTable"];
  for (const m of all.matchAll(/\bconst\s+(\w+)\s*=\s*(?:pgTableCreator|mysqlTableCreator|sqliteTableCreator)\s*\(/g)) tableFns.push(m[1]);
  for (const m of all.matchAll(/\bconst\s+(\w+)\s*=\s*(?:pgSchema|mysqlSchema)\s*\(/g)) tableFns.push(`${m[1]}\\.table`);

  // Spread column groups: `const timestamps = { createdAt: ..., updatedAt: ... }`.
  const constObjects = new Map<string, string>();
  for (const m of all.matchAll(/\bconst\s+(\w+)\s*=\s*\{/g)) {
    const open = m.index! + m[0].length - 1;
    const close = findMatching(all, open, "ts");
    if (close > 0) constObjects.set(m[1], all.slice(open + 1, close));
  }

  const tableRe = new RegExp(String.raw`\bconst\s+(\w+)\s*=\s*(?:\w+\.)?(${tableFns.join("|")})\s*\(`, "g");
  const parsed: ParsedTable[] = [];
  for (const m of all.matchAll(tableRe)) {
    const open = m.index! + m[0].length - 1;
    const close = findMatching(all, open, "ts");
    if (close < 0) continue;
    const args = splitTopLevel(all.slice(open + 1, close), ",", "ts");
    const name = stringLiterals(args[0] ?? "")[0];
    if (!name || !args[1]) continue;
    const body = objectBody(args[1]);
    if (body === undefined) continue;
    const table: ParsedTable = { varName: m[1], table: { name, columns: [] }, byKey: new Map(), pendingRefs: new Map(), extra: args.slice(2).join(",") };
    readColumns(body, table, enumVars, enums, constObjects);
    parsed.push(table);
  }

  const byVar = new Map(parsed.map((t) => [t.varName, t]));
  const resolve = (varName: string, prop: string): { table: string; column: string } | undefined => {
    const target = byVar.get(varName);
    if (!target) return undefined;
    return { table: target.table.name, column: target.byKey.get(prop)?.name ?? prop };
  };

  for (const t of parsed) {
    for (const [key, [varName, prop]] of t.pendingRefs) {
      const col = t.byKey.get(key);
      const ref = resolve(varName, prop);
      if (col && ref) col.ref = ref;
    }
    if (t.extra) readExtraConfig(t, resolve, enums);
  }

  // relations(table, ({ one }) => ({ x: one(other, { fields: [table.a], references: [other.id] }) }))
  for (const m of all.matchAll(/\brelations\s*\(\s*(\w+)\s*,/g)) {
    const owner = byVar.get(m[1]);
    if (!owner) continue;
    const open = all.indexOf("(", m.index!);
    const close = findMatching(all, open, "ts");
    if (close < 0) continue;
    const block = all.slice(open, close);
    for (const one of block.matchAll(/\bone\s*\(\s*(\w+)\s*,\s*\{[^}]*?fields\s*:\s*\[([^\]]*)\][^}]*?references\s*:\s*\[([^\]]*)\]/g)) {
      const fields = propsOf(one[2]);
      const refs = propsOf(one[3]);
      fields.forEach(([, key], i) => {
        const col = owner.byKey.get(key);
        const ref = refs[i] ? resolve(refs[i][0], refs[i][1]) : undefined;
        if (col && ref && !col.ref) col.ref = ref;
      });
    }
  }

  return { tables: parsed.map((t) => t.table), enums };
}

/** The `{ ... }` of a columns argument: an object literal, or an arrow function returning one
 * (`(t) => ({ ... })`). */
function objectBody(arg: string): string | undefined {
  let text = arg.trim();
  const arrow = /^(?:\([^)]*\)|\w+)\s*=>\s*/.exec(text);
  if (arrow) text = text.slice(arrow[0].length).trim();
  if (text.startsWith("(")) text = text.slice(1).trim();
  if (!text.startsWith("{")) return undefined;
  const close = findMatching(text, 0, "ts");
  return close > 0 ? text.slice(1, close) : undefined;
}

function readColumns(body: string, t: ParsedTable, enumVars: Map<string, string>, enums: Map<string, string[]>, constObjects: Map<string, string>, depth = 0): void {
  for (const entry of splitTopLevel(body, ",", "ts")) {
    const spread = /^\.\.\.\s*(\w+)$/.exec(entry);
    if (spread) {
      const group = constObjects.get(spread[1]);
      if (group && depth < 3) readColumns(group, t, enumVars, enums, constObjects, depth + 1);
      continue;
    }
    const kv = /^(?:(\w+)|['"]([^'"]+)['"])\s*:\s*([\s\S]+)$/.exec(entry);
    if (!kv) continue;
    const key = kv[1] ?? kv[2];
    const expr = kv[3].trim();
    const call = /^(?:\w+\.)?(\w+)\s*\(/.exec(expr);
    if (!call) continue;
    const fn = call[1];
    const argsOpen = call[0].length - 1;
    const argsClose = findMatching(expr, argsOpen, "ts");
    const argsText = argsClose > 0 ? expr.slice(argsOpen + 1, argsClose) : "";
    const args = splitTopLevel(argsText, ",", "ts");
    const firstIsName = args[0] !== undefined && /^['"`]/.test(args[0]);
    const name = firstIsName ? stringLiterals(args[0])[0] : key;
    const rest = argsClose > 0 ? expr.slice(argsClose + 1) : "";

    const col: RawColumn = { name, type: fn.toLowerCase() };
    const enumName = enumVars.get(fn);
    if (enumName) {
      col.type = enumName;
      col.enum = enumName;
    } else {
      // mysqlEnum("status", [...]) and text("status", { enum: [...] }) carry their values inline.
      const inline = fn === "mysqlEnum" ? args[1] : /\benum\s*:\s*(\[[^\]]*\])/.exec(argsText)?.[1];
      const values = inline ? stringLiterals(inline) : [];
      if (values.length > 0) {
        col.enum = `${t.table.name}.${name}`;
        enums.set(col.enum, values);
      }
    }
    if (/\.array\s*\(/.test(rest)) col.type += "[]";
    if (/\.primaryKey\s*\(/.test(rest)) col.primaryKey = true;
    const ref = /\.references\s*\(\s*(?:\([^)]*\))?\s*(?::\s*[\w<>]+\s*)?=>\s*(?:\{\s*return\s+)?(\w+)\.(\w+)/.exec(rest);
    if (ref) t.pendingRefs.set(key, [ref[1], ref[2]]);
    t.table.columns.push(col);
    t.byKey.set(key, col);
  }
}

/** `[table.a, other.b]` -> [["table", "a"], ["other", "b"]]. */
function propsOf(list: string): [string, string][] {
  return [...list.matchAll(/(\w+)\.(\w+)/g)].map((m) => [m[1], m[2]]);
}

function readExtraConfig(t: ParsedTable, resolve: (v: string, p: string) => { table: string; column: string } | undefined, enums: Map<string, string[]>): void {
  const extra = t.extra!;
  for (const m of extra.matchAll(/\bforeignKey\s*\(\s*\{/g)) {
    const open = m.index! + m[0].length - 1;
    const close = findMatching(extra, open, "ts");
    if (close < 0) continue;
    const obj = extra.slice(open, close);
    const cols = propsOf(/\bcolumns\s*:\s*\[([^\]]*)\]/.exec(obj)?.[1] ?? "");
    const foreign = propsOf(/\bforeignColumns\s*:\s*\[([^\]]*)\]/.exec(obj)?.[1] ?? "");
    cols.forEach(([, key], i) => {
      const col = t.byKey.get(key);
      const ref = foreign[i] ? resolve(foreign[i][0], foreign[i][1]) : undefined;
      if (col && ref) col.ref = ref;
    });
  }
  for (const m of extra.matchAll(/\bcheck\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const close = findMatching(extra, open, "ts");
    if (close < 0) continue;
    // `sql\`${table.status} IN (...)\`` names the column through its property.
    const checkSql = extra.slice(open, close).replace(/\$\{\s*\w+\.(\w+)\s*\}/g, "$1");
    for (const { column, values } of parseCheckEnums(checkSql)) {
      const col = t.table.columns.find((c) => c.name === column) ?? t.byKey.get(column);
      if (!col || col.enum) continue;
      col.enum = `${t.table.name}.${col.name}`;
      enums.set(col.enum, values);
    }
  }
}
