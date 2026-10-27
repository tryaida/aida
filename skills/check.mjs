#!/usr/bin/env node
// Lints aida's agent skills. Run with: node skills/check.mjs
//
// Checks:
//   1. Every SKILL.md and agents/*.md with frontmatter parses (name + description present;
//      agents/*.md also need tools + model).
//   2. Descriptions are trigger-friendly: non-trivial length, read like "use when/for...".
//   3. Cross-references (relative paths and `skills/...` paths written in backticks or links)
//      resolve to real files.
//   4. Forbidden words ("IR", "journey", "workflow.json" — the internal names aida's own
//      AGENTS.md bans from user-facing text) don't appear outside the small set of files that
//      document the ban itself.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = here; // skills/
let failures = 0;
let checked = 0;

function fail(msg) {
  failures++;
  console.error(`FAIL  ${msg}`);
}
function ok(msg) {
  checked++;
  console.log(`ok    ${msg}`);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (entry.endsWith(".md")) out.push(p);
  }
  return out;
}

const allMd = walk(root);
const skillFiles = allMd.filter((p) => p.endsWith("SKILL.md"));
const agentFiles = allMd.filter((p) => p.includes(`${join("skills", "agents")}${/[\\/]/.source ? "" : ""}`) || p.includes("agents/"));

// --- 1 & 2: frontmatter + description quality ---------------------------------------------
function parseFrontmatter(text, file) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return null;
  const block = m[1];
  const data = {};
  for (const line of block.split("\n")) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (kv) data[kv[1]] = kv[2].trim();
  }
  return data;
}

for (const file of skillFiles) {
  const text = readFileSync(file, "utf8");
  const fm = parseFrontmatter(text, file);
  const rel = relative(root, file);
  if (!fm) {
    fail(`${rel}: no YAML frontmatter block`);
    continue;
  }
  if (!fm.name) fail(`${rel}: frontmatter missing "name"`);
  if (!fm.description) {
    fail(`${rel}: frontmatter missing "description"`);
  } else {
    const d = fm.description;
    if (d.length < 40) fail(`${rel}: description too short to be trigger-friendly (${d.length} chars)`);
    if (!/use\b|for\b/i.test(d)) fail(`${rel}: description doesn't read as trigger guidance (no "use"/"for")`);
    ok(`${rel}: frontmatter + trigger-friendly description`);
  }
  const bodyLines = text.split("\n").length;
  if (bodyLines > 130) fail(`${rel}: ${bodyLines} lines, target is under ~120`);
}

for (const file of allMd.filter((p) => p.includes(`${root}/agents/`))) {
  const text = readFileSync(file, "utf8");
  const fm = parseFrontmatter(text, file);
  const rel = relative(root, file);
  if (!fm) {
    // codex-note.md is deliberately plain prose, not a subagent definition.
    if (!file.endsWith("codex-note.md")) fail(`${rel}: agent file missing frontmatter`);
    continue;
  }
  for (const key of ["name", "description", "tools", "model"]) {
    if (!fm[key]) fail(`${rel}: agent frontmatter missing "${key}"`);
  }
  if (fm.model && !["haiku", "sonnet", "opus"].includes(fm.model)) {
    fail(`${rel}: model "${fm.model}" is not haiku|sonnet|opus`);
  }
  ok(`${rel}: agent frontmatter complete`);
}

// --- 3: cross-references resolve ------------------------------------------------------------
const refPattern = /`((?:skills\/|references\/|\.\.?\/)[A-Za-z0-9_\-./]+\.(?:md|mjs|ts|json|yaml|yml))`/g;
for (const file of allMd) {
  const text = readFileSync(file, "utf8");
  const rel = relative(root, file);
  for (const match of text.matchAll(refPattern)) {
    const refPath = match[1];
    // Resolve relative to the repo root (skills/ parent) when it starts with "skills/",
    // otherwise relative to the file's own directory.
    // "skills/..." is written root-relative to the repo; "references/..." is written
    // root-relative to skills/ (the shared reference dir is a sibling of every skill dir, not
    // nested inside it); anything else (./ or ../) is relative to the file's own directory.
    const resolved = refPath.startsWith("skills/")
      ? join(root, "..", refPath)
      : refPath.startsWith("references/")
        ? join(root, refPath)
        : join(dirname(file), refPath);
    try {
      statSync(resolved);
      ok(`${rel}: reference "${refPath}" resolves`);
    } catch {
      fail(`${rel}: reference "${refPath}" does not resolve (checked ${relative(root, resolved)})`);
    }
  }
}

// --- 4: forbidden words in user-facing text --------------------------------------------------
// These files document the ban itself and must be able to name the banned words.
const forbiddenWordsAllowlist = new Set(
  ["references/style.md", "references/walkthrough-cheatsheet.md", "aida-review/SKILL.md"].map((p) =>
    join(root, p),
  ),
);
const forbidden = [/\bIR\b/, /\bjourney\b/i, /workflow\.json/i];
for (const file of allMd) {
  if (forbiddenWordsAllowlist.has(file)) continue;
  const text = readFileSync(file, "utf8");
  const rel = relative(root, file);
  for (const re of forbidden) {
    const m = text.match(re);
    if (m) fail(`${rel}: forbidden word "${m[0]}" in user-facing-reachable text`);
  }
  ok(`${rel}: no forbidden words`);
}

console.log(`\n${checked} checks passed, ${failures} failed.`);
process.exit(failures > 0 ? 1 : 0);
