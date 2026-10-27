// Reads a Prisma schema statically: `model` blocks (scalar fields, `@relation(fields, references)`
// foreign keys, `@@map` table names are ignored in favour of the model name people see in code),
// and `enum` blocks.
import { findMatching, readableDefault, stripComments } from "./text.js";
import type { RawColumn, RawSchema, RawTable } from "./types.js";

export function parsePrisma(text: string): RawSchema {
  const src = stripComments(text, "ts");
  const blocks: { kind: "model" | "enum"; name: string; body: string }[] = [];
  for (const m of src.matchAll(/^\s*(model|enum|view)\s+(\w+)\s*\{/gm)) {
    const open = m.index! + m[0].length - 1;
    const close = findMatching(src, open, "ts");
    if (close < 0 || m[1] === "view") continue;
    blocks.push({ kind: m[1] as "model" | "enum", name: m[2], body: src.slice(open + 1, close) });
  }

  const enums = new Map<string, string[]>();
  for (const b of blocks.filter((b) => b.kind === "enum")) {
    const values = b.body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("@@"))
      .map((l) => l.split(/\s+/)[0]);
    enums.set(b.name, values);
  }

  const models = new Set(blocks.filter((b) => b.kind === "model").map((b) => b.name));
  const tables: RawTable[] = [];
  for (const b of blocks.filter((b) => b.kind === "model")) {
    const columns: RawColumn[] = [];
    const relations: { fields: string[]; target: string; references: string[] }[] = [];
    for (const raw of b.body.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("@@")) continue;
      const f = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(line);
      if (!f) continue;
      const [, name, type, list, , attrs] = f;
      if (models.has(type)) {
        // A relation field: the side with `fields:` owns the foreign key; the other side (a list,
        // or a bare back-reference) is the inverse and adds no column.
        const rel = /@relation\(([^)]*)\)/.exec(attrs);
        const fields = /fields\s*:\s*\[([^\]]*)\]/.exec(rel?.[1] ?? "")?.[1];
        const refs = /references\s*:\s*\[([^\]]*)\]/.exec(rel?.[1] ?? "")?.[1];
        if (fields && refs) relations.push({ fields: splitNames(fields), target: type, references: splitNames(refs) });
        continue;
      }
      const col: RawColumn = { name, type: type.toLowerCase() + (list ? "[]" : "") };
      if (enums.has(type)) {
        col.type = type;
        col.enum = type;
      }
      if (/@id\b/.test(attrs)) col.primaryKey = true;
      const dflt = /@default\(/.exec(attrs);
      if (dflt) {
        const open = dflt.index + dflt[0].length - 1;
        const close = findMatching(attrs, open, "ts");
        const value = close > 0 ? readableDefault(attrs.slice(open + 1, close)) : undefined;
        if (value !== undefined) col.default = value;
      }
      columns.push(col);
    }
    for (const rel of relations) {
      rel.fields.forEach((field, i) => {
        const col = columns.find((c) => c.name === field);
        if (col) col.ref = { table: rel.target, column: rel.references[i] ?? "id" };
      });
    }
    tables.push({ name: b.name, columns });
  }
  return { tables, enums };
}

function splitNames(list: string): string[] {
  return list
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
