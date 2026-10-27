// Finds an app's schema, in order of preference: Drizzle schema files (the `schema` field of a
// drizzle.config.*, else `schema*.ts` files declaring tables), a Prisma schema, then SQL
// migrations (Supabase, plain `migrations/`, drizzle-kit's output folder, Prisma's migration
// folders). Paths only; the readers parse the text.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { isDrizzleSchema } from "./drizzle.js";
import { stringLiterals } from "./text.js";
import type { DomainSourceKind } from "./types.js";
import { naturalCompare, walkFiles } from "./walk.js";

export interface FoundSource {
  kind: DomainSourceKind;
  /** Repo-relative paths, in the order they're read (SQL: the order they'd be applied). */
  files: string[];
}

const CODE_FILE = /\.(ts|mts|cts|js|mjs|cjs)$/;

function readText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

interface DrizzleConfig {
  /** Repo-relative dir of the config file. */
  dir: string;
  schema: string[];
  out?: string;
}

function readDrizzleConfigs(repo: string): DrizzleConfig[] {
  const configs = walkFiles(repo, (rel) => /(^|\/)drizzle\.config\.(ts|mts|js|mjs|cjs|json)$/.test(rel), { maxDepth: 3, limit: 10 });
  return configs.map((rel) => {
    const text = readText(join(repo, rel));
    const schemaMatch = /["']?schema["']?\s*:\s*(\[[^\]]*\]|["'`][^"'`]+["'`])/.exec(text);
    const outMatch = /["']?out["']?\s*:\s*["'`]([^"'`]+)["'`]/.exec(text);
    return { dir: posix.dirname(rel), schema: schemaMatch ? stringLiterals(schemaMatch[1]) : [], out: outMatch?.[1] };
  });
}

// A glob such as `src/db/**` + `/*.ts` -> a RegExp over repo-relative paths.
function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if ("\\^$+?.()|{}[]".includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

/** Expands one `schema` entry (a file, a folder, or a glob) relative to `base`. */
function expandSchemaPath(repo: string, base: string, entry: string): string[] {
  const rel = posix.normalize(posix.join(base, entry)).replace(/^\.\//, "");
  if (rel.includes("*")) {
    const staticPrefix = rel.split("*")[0].replace(/[^/]*$/, "");
    const pattern = globToRegex(rel);
    return walkFiles(join(repo, staticPrefix), () => true, { maxDepth: 5, limit: 200 })
      .map((f) => posix.join(staticPrefix, f))
      .filter((f) => pattern.test(f) && CODE_FILE.test(f));
  }
  const full = join(repo, rel);
  if (isDir(full)) return walkFiles(full, (f) => CODE_FILE.test(f), { maxDepth: 3, limit: 200 }).map((f) => posix.join(rel, f));
  if (existsSync(full)) return [rel];
  for (const ext of [".ts", ".js"]) if (existsSync(full + ext)) return [rel + ext];
  return [];
}

function findDrizzle(repo: string, configs: DrizzleConfig[]): string[] {
  const fromConfig = configs.flatMap((c) => c.schema.flatMap((s) => expandSchemaPath(repo, c.dir, s)));
  const candidates = fromConfig.length > 0
    ? fromConfig
    : walkFiles(repo, (rel) => CODE_FILE.test(rel) && !/\.(test|spec|d)\.[a-z]+$/.test(rel) && (/(^|\/)schema[^/]*$/.test(rel) || /(^|\/)(db|database|drizzle|schema)\//.test(rel)), { maxDepth: 6, limit: 400 });
  return [...new Set(candidates)].filter((rel) => isDrizzleSchema(readText(join(repo, rel))));
}

function findPrisma(repo: string): string[] {
  const files = walkFiles(repo, (rel) => rel.endsWith(".prisma"), { maxDepth: 4, limit: 50 });
  if (files.length === 0) return [];
  // One schema: `schema.prisma` and, for a multi-file schema, the other files in its folder.
  const main = files.find((f) => f.endsWith("schema.prisma")) ?? files[0];
  const dir = posix.dirname(main);
  return files.filter((f) => posix.dirname(f) === dir || posix.dirname(f).startsWith(`${dir === "." ? "" : `${dir}/`}schema`));
}

function findSqlMigrations(repo: string, configs: DrizzleConfig[]): string[] {
  const dirs = new Set<string>();
  for (const c of configs) if (c.out) dirs.add(posix.normalize(posix.join(c.dir, c.out)).replace(/^\.\//, ""));
  const migrationDirs = walkFiles(repo, (rel) => rel.endsWith(".sql") && /(^|\/)(migrations|drizzle)\/(?:[^/]+\/)?[^/]+\.sql$/.test(rel), { maxDepth: 6, limit: 2000 });
  for (const f of migrationDirs) {
    const m = /^(.*?(?:^|\/)(?:migrations|drizzle))\//.exec(f);
    if (m) dirs.add(m[1]);
  }
  const files: { rel: string; order: string }[] = [];
  for (const dir of dirs) {
    const full = join(repo, dir);
    if (!isDir(full)) continue;
    // Flat files (Supabase, drizzle-kit, plain) or one folder per migration (Prisma).
    for (const f of walkFiles(full, (rel) => rel.endsWith(".sql") && rel.split("/").length <= 2, { maxDepth: 1 })) {
      files.push({ rel: posix.join(dir, f), order: f });
    }
  }
  files.sort((a, b) => naturalCompare(a.order, b.order) || naturalCompare(a.rel, b.rel));
  return [...new Set(files.map((f) => f.rel))];
}

/** Every schema source found, in order of preference. */
export function findSchemaSources(repo: string): FoundSource[] {
  const configs = readDrizzleConfigs(repo);
  const found: FoundSource[] = [];
  const drizzle = findDrizzle(repo, configs);
  if (drizzle.length > 0) found.push({ kind: "drizzle", files: drizzle });
  const prisma = findPrisma(repo);
  if (prisma.length > 0) found.push({ kind: "prisma", files: prisma });
  const sql = findSqlMigrations(repo, configs);
  if (sql.length > 0) found.push({ kind: "sql", files: sql });
  return found;
}

