// `aida test`'s outputs: a short summary (agents read it, so it stays small) and JUnit XML for
// CI systems (one suite per walkthrough, one case per step, failures typed by category).
import { relative } from "node:path";
import type { StepOutcome, TestRunResult, TestStatus, WalkthroughTestResult } from "./types.js";

const LABEL: Record<TestStatus, string> = {
  passed: "passed",
  broken: "broken",
  app: "app problem",
  environment: "environment problem",
  undetermined: "can't tell",
  blocked: "blocked",
};

/** Failure `type` in the JUnit XML: who the failure probably belongs to. */
const JUNIT_TYPE: Record<Exclude<TestStatus, "passed">, string> = {
  broken: "walkthrough",
  app: "app",
  environment: "environment",
  undetermined: "undetermined",
  blocked: "blocked",
};

function shortPath(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") ? rel : path;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The default output: one line for the run, one per walkthrough, a few more per failure. */
export function formatSummary(result: TestRunResult, cwd = process.cwd()): string {
  const lines: string[] = [];
  const counts = (Object.keys(LABEL) as TestStatus[]).filter((s) => result.counts[s] > 0).map((s) => `${result.counts[s]} ${LABEL[s]}`);
  const head = result.walkthroughs.length === 0 ? "no walkthroughs to test" : `${plural(result.walkthroughs.length, "walkthrough")}: ${counts.join(", ")}`;
  const diff = result.affected ? ` (affected by ${result.affected.base}...${result.affected.head}${result.affected.all ? `: all${result.affected.reason ? `, ${result.affected.reason}` : ""}` : ""})` : "";
  lines.push(`aida test: ${head}${diff}`);
  const width = Math.max(...result.walkthroughs.map((r) => LABEL[r.status].length), 6);
  for (const r of result.walkthroughs) {
    const passed = r.steps.filter((s) => s.status === "passed").length;
    const dep = r.dependency ? " (needed by another)" : "";
    lines.push(`  ${LABEL[r.status].padEnd(width)}  ${r.walkthrough}${dep}  ${passed}/${r.steps.length} steps`);
    const f = r.failure;
    if (!f) continue;
    const pad = `  ${" ".repeat(width)}  `;
    lines.push(`${pad}${f.summary}`);
    if (f.reason) lines.push(`${pad}why: ${f.reason}`);
    if (f.evidence) lines.push(`${pad}evidence: ${f.evidence}`);
    if (f.screenshot) lines.push(`${pad}screenshot: ${shortPath(f.screenshot, cwd)}`);
    if (f.report) lines.push(`${pad}report: ${shortPath(f.report, cwd)}`);
  }
  if (result.notRun.length > 0) lines.push(`  not run (--bail): ${result.notRun.join(", ")}`);
  return lines.join("\n");
}

/** Text safe inside XML: characters XML can't hold become U+FFFD, then the five are escaped.
 * Newlines and tabs are kept as character references so an attribute keeps them too. */
export function xmlEscape(text: string): string {
  return text
    .replace(/[^\t\n\r -\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, "\uFFFD")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/\t/g, "&#9;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;");
}

function seconds(ms: number | undefined): string {
  return ((ms ?? 0) / 1000).toFixed(3);
}

function failureElement(r: WalkthroughTestResult, cwd: string): string {
  const f = r.failure!;
  const details = [
    f.reason ? `why: ${f.reason}` : "",
    f.evidence ? `evidence: ${f.evidence}` : "",
    f.blockedBy && f.blockedBy.length > 0 ? `blocked by: ${f.blockedBy.join(", ")}` : "",
    f.screenshot ? `screenshot: ${shortPath(f.screenshot, cwd)}` : "",
    f.report ? `report: ${shortPath(f.report, cwd)}` : "",
    f.repairCommand ? `repair: ${f.repairCommand}` : "",
  ].filter(Boolean);
  const type = JUNIT_TYPE[r.status as Exclude<TestStatus, "passed">];
  return `<failure type="${type}" message="${xmlEscape(f.summary)}">${xmlEscape(details.join("\n"))}</failure>`;
}

/** The step a failure belongs to: the failing step, else the one its report names (a 5xx during
 * a step that otherwise passed). */
function failingIndex(r: WalkthroughTestResult): number {
  const failed = r.steps.findIndex((s) => s.status === "failed");
  if (failed >= 0) return failed;
  const named = r.failure?.step;
  if (named === undefined || r.status === "blocked") return -1;
  return r.steps.findIndex((s) => s.id === named || s.title === named);
}

function caseName(s: StepOutcome, i: number): string {
  return `${i + 1}. ${s.title}`;
}

/** JUnit XML: one `<testsuite>` per walkthrough and one `<testcase>` per step. A failure outside
 * any step (sign-in, setup, a blocked walkthrough, an app error after the last step) is a case
 * of its own, so every failed walkthrough has a failed case. A walkthrough `--bail` never ran is
 * a suite with one skipped case, so a dashboard shows it wasn't checked rather than leaving it out. */
export function toJUnit(result: TestRunResult, cwd = process.cwd()): string {
  const suites: string[] = [];
  let tests = 0;
  let failures = 0;
  let skipped = 0;
  let totalMs = 0;
  for (const r of result.walkthroughs) {
    const cls = xmlEscape(`aida.${r.walkthrough}`);
    const at = r.status === "passed" ? -1 : failingIndex(r);
    const cases: string[] = [];
    let suiteSkipped = 0;
    let suiteMs = 0;
    r.steps.forEach((s, i) => {
      suiteMs += s.ms ?? 0;
      const open = `<testcase classname="${cls}" name="${xmlEscape(caseName(s, i))}" time="${seconds(s.ms)}"`;
      if (i === at) cases.push(`${open}>${failureElement(r, cwd)}</testcase>`);
      else if (s.status === "skipped") {
        suiteSkipped += 1;
        cases.push(`${open}><skipped message="${r.status === "blocked" ? "blocked" : "not run: an earlier step failed"}"/></testcase>`);
      } else cases.push(`${open}/>`);
    });
    if (r.status !== "passed" && at < 0) {
      const name = r.status === "blocked" ? "not run: blocked" : "whole replay";
      cases.unshift(`<testcase classname="${cls}" name="${xmlEscape(name)}" time="0.000">${failureElement(r, cwd)}</testcase>`);
    }
    const suiteFailures = r.status === "passed" ? 0 : 1;
    tests += cases.length;
    failures += suiteFailures;
    skipped += suiteSkipped;
    totalMs += suiteMs;
    const props = r.dependency ? `\n    <properties><property name="dependency" value="true"/></properties>` : "";
    suites.push(
      `  <testsuite name="${xmlEscape(r.walkthrough)}" tests="${cases.length}" failures="${suiteFailures}" errors="0" skipped="${suiteSkipped}" time="${seconds(suiteMs)}">${props}\n${cases.map((c) => `    ${c}`).join("\n")}\n  </testsuite>`,
    );
  }
  for (const id of result.notRun) {
    const open = `<testcase classname="${xmlEscape(`aida.${id}`)}" name="not run" time="0.000">`;
    suites.push(
      `  <testsuite name="${xmlEscape(id)}" tests="1" failures="0" errors="0" skipped="1" time="0.000">\n    ${open}<skipped message="not run: --bail stopped the run at an earlier failure"/></testcase>\n  </testsuite>`,
    );
    tests += 1;
    skipped += 1;
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="aida test" tests="${tests}" failures="${failures}" errors="0" skipped="${skipped}" time="${seconds(totalMs)}">`,
    ...suites,
    "</testsuites>",
    "",
  ].join("\n");
}

/** JUnit XML for a run that stopped before any walkthrough replayed (the safety gate refused,
 * the config didn't load), so CI shows why instead of an empty report. */
export function runErrorJUnit(message: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuites name="aida test" tests="1" failures="1" errors="0" skipped="0" time="0.000">',
    '  <testsuite name="aida test" tests="1" failures="1" errors="0" skipped="0" time="0.000">',
    `    <testcase classname="aida" name="run" time="0.000"><failure type="environment" message="${xmlEscape(message.split("\n")[0])}">${xmlEscape(message)}</failure></testcase>`,
    "  </testsuite>",
    "</testsuites>",
    "",
  ].join("\n");
}
