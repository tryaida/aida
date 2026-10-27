import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { convertPlaywrightFile } from "../walkthrough/convert-playwright.js";
import { WalkthroughDocSchema } from "../walkthrough/schema.js";
import * as YAML from "yaml";

export interface ImportPlaywrightFileResult {
  source: string;
  draft: string;
  walkthrough: string;
  mapped: number;
  unmapped: number;
  signInNotes: number;
}

export interface ImportPlaywrightResult {
  files: number;
  drafts: ImportPlaywrightFileResult[];
  error?: string;
}

/** Resolves a path or a simple glob (`*`, `**`, `?`) to the files it matches, sorted. */
export function resolveTestFiles(pattern: string): string[] {
  if (existsSync(pattern) && statSync(pattern).isFile()) return [pattern];
  if (!/[*?]/.test(pattern)) {
    if (existsSync(pattern) && statSync(pattern).isDirectory()) {
      return walkDir(pattern).filter((f) => /\.(spec|e2e|test)\.tsx?$/.test(f)).sort();
    }
    throw new Error(`no such file or glob match: "${pattern}"`);
  }

  const segments = pattern.split("/");
  const firstGlobIndex = segments.findIndex((s) => /[*?]/.test(s));
  const base = firstGlobIndex <= 0 ? "." : segments.slice(0, firstGlobIndex).join("/") || "/";
  if (!existsSync(base)) throw new Error(`no such file or glob match: "${pattern}"`);

  const regex = globToRegExp(pattern);
  const candidates = statSync(base).isDirectory() ? walkDir(base) : [base];
  const matches = candidates.filter((f) => regex.test(f));
  if (matches.length === 0) throw new Error(`no files matched glob: "${pattern}"`);
  return matches.sort();
}

function walkDir(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkDir(path));
    else out.push(path);
  }
  return out;
}

/** Turns a glob with `*`, `**` and `?` into a RegExp matched against a (relative or absolute) path. */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

function defaultOutPath(input: string, draftId: string, outDir: string | undefined): string {
  const dir = outDir ?? dirname(input);
  return join(dir, `${baseNameNoExt(input)}.${draftId}.yaml`);
}

function baseNameNoExt(file: string): string {
  return basename(file).replace(/\.(spec|e2e|test)\.tsx?$/, "").replace(/\.tsx?$/, "");
}

export async function runImportPlaywright(
  pattern: string,
  outDir: string | undefined,
  json: boolean,
  force = false,
): Promise<number> {
  try {
    const files = resolveTestFiles(pattern);
    if (outDir) mkdirSync(outDir, { recursive: true });

    const results: ImportPlaywrightFileResult[] = [];
    // Two different spec files often share a test title ("320px reflow has no horizontal
    // overflow" shows up per screen) — when writing many files into one directory, every
    // walkthrough id in that directory must stay unique (`aida validate` rejects duplicates).
    const usedIds = new Set<string>();
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const { drafts } = await convertPlaywrightFile(text, file, file);
      for (const draft of drafts) {
        let id = draft.id;
        let yaml = draft.yaml;
        if (usedIds.has(id)) {
          const prefixed = `${baseNameNoExt(file)}-${id}`;
          yaml = yaml.replace(`walkthrough: ${id}`, `walkthrough: ${prefixed}`);
          id = prefixed;
        }
        usedIds.add(id);

        const outFile = defaultOutPath(file, id, outDir);
        if (!force && existsSync(outFile)) {
          throw new Error(`"${outFile}" already exists — pass --force to overwrite it`);
        }
        // Fail loudly if a draft (even with TODOs left in) doesn't pass our own schema —
        // comments carry the TODOs, the data shape itself must always be valid.
        const parsed = YAML.parse(yaml);
        WalkthroughDocSchema.parse(parsed);

        writeFileSync(outFile, yaml, "utf8");
        results.push({
          source: file,
          draft: outFile,
          walkthrough: id,
          mapped: draft.mapped,
          unmapped: draft.unmapped,
          signInNotes: draft.signInNotes,
        });
      }
    }

    const result: ImportPlaywrightResult = { files: files.length, drafts: results };
    if (json) {
      console.log(JSON.stringify(result));
    } else {
      for (const r of results) {
        console.log(
          `imported ${r.walkthrough}: ${r.mapped} mapped, ${r.unmapped} TODO, ${r.signInNotes} sign-in -> ${r.draft}`,
        );
      }
      console.log(`${results.length} draft walkthrough(s) from ${files.length} file(s)`);
    }
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    if (json) {
      console.log(JSON.stringify({ files: 0, drafts: [], error: message }));
    } else {
      console.error(`error: ${message}`);
    }
    return 1;
  }
}
