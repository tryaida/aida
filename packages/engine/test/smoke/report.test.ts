// `aida test`'s report shapes without a browser: XML escaping of anything an app can put in an
// error, and where a failure outside any step goes in the JUnit XML.
import { describe, expect, it } from "vitest";
import { formatSummary, toJUnit, xmlEscape } from "../../src/smoke/report.js";
import { countStatuses } from "../../src/smoke/run.js";
import type { TestRunResult, WalkthroughTestResult } from "../../src/smoke/types.js";

function run(walkthroughs: WalkthroughTestResult[]): TestRunResult {
  return { ok: walkthroughs.every((w) => w.status === "passed"), counts: countStatuses(walkthroughs), walkthroughs, notRun: [], captures: "/p/.build/<walkthrough>/ci" };
}

describe("xmlEscape", () => {
  it("escapes markup and replaces characters XML can't hold", () => {
    expect(xmlEscape(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;");
    expect(xmlEscape("a\u0000b\u0008c\uD800d￾e")).toBe("a�b�c�d�e");
    expect(xmlEscape("tab\tline\nret\r")).toBe("tab&#9;line&#10;ret&#13;");
    expect(xmlEscape("emoji \u{1F600} ok")).toBe("emoji \u{1F600} ok");
  });
});

describe("toJUnit", () => {
  it("gives a failure outside any step a case of its own, and marks a dependency", () => {
    const xml = toJUnit(
      run([
        {
          walkthrough: "signed-out",
          status: "environment",
          steps: [{ title: "Open", status: "skipped" }],
          failure: { category: "environment", summary: "sign-in failed (HTTP 401)", reason: "signing in failed, so no step ran" },
        },
        { walkthrough: "provider", status: "passed", dependency: true, steps: [{ title: "Make it", status: "passed", ms: 1500 }] },
      ]),
      "/p",
    );
    expect(xml).toContain('<testsuites name="aida test" tests="3" failures="1" errors="0" skipped="1" time="1.500">');
    expect(xml).toContain('<testcase classname="aida.signed-out" name="whole replay" time="0.000"><failure type="environment" message="sign-in failed (HTTP 401)">why: signing in failed, so no step ran</failure></testcase>');
    expect(xml).toContain('<testcase classname="aida.signed-out" name="1. Open" time="0.000"><skipped message="not run: an earlier step failed"/></testcase>');
    expect(xml).toContain('<property name="dependency" value="true"/>');
  });

  it("puts an app problem on the step whose report names it, even though the step passed", () => {
    const xml = toJUnit(
      run([
        {
          walkthrough: "pay",
          status: "app",
          steps: [
            { title: "Open", id: "open", status: "passed" },
            { title: "Pay", id: "pay", status: "passed" },
          ],
          failure: { step: "pay", category: "app", summary: "every step passed, but the app had 1 server error (5xx)" },
        },
      ]),
    );
    expect(xml).toContain('name="1. Open" time="0.000"/>');
    expect(xml).toContain('name="2. Pay" time="0.000"><failure type="app"');
  });
});

describe("toJUnit after --bail", () => {
  it("gives each walkthrough the run never reached a suite with one skipped case, counted in the totals", () => {
    const result = run([
      { walkthrough: "first", status: "passed", steps: [{ title: "Open", status: "passed", ms: 500 }] },
      { walkthrough: "second", status: "broken", steps: [{ title: "Save", status: "failed", ms: 250 }], failure: { summary: 'step "Save": no button "Save"' } },
    ]);
    result.notRun = ["third", "fourth"];
    const xml = toJUnit(result);
    expect(xml).toContain('<testsuites name="aida test" tests="4" failures="1" errors="0" skipped="2" time="0.750">');
    for (const id of ["third", "fourth"]) {
      expect(xml).toContain(
        `  <testsuite name="${id}" tests="1" failures="0" errors="0" skipped="1" time="0.000">\n    <testcase classname="aida.${id}" name="not run" time="0.000"><skipped message="not run: --bail stopped the run at an earlier failure"/></testcase>\n  </testsuite>`,
      );
    }
    expect(xml.indexOf('name="third"')).toBeLessThan(xml.indexOf('name="fourth"'));
  });
});

describe("formatSummary", () => {
  it("is one line per walkthrough, plus the failure's lines, with paths relative to the working directory", () => {
    const text = formatSummary(
      run([
        { walkthrough: "a", status: "passed", steps: [{ title: "x", status: "passed" }] },
        {
          walkthrough: "b",
          status: "blocked",
          steps: [{ title: "y", status: "skipped" }],
          failure: { summary: "skipped: needs s, which p didn't leave", blockedBy: ["p"], reason: "blocked by a possible app bug in p" },
        },
        {
          walkthrough: "c",
          status: "undetermined",
          steps: [{ title: "z", status: "failed" }],
          failure: { summary: 'step "z": timeout', screenshot: "/p/.build/c/ci/capture/frames/f.png", report: "/p/.build/c/ci/capture/failure.json" },
        },
      ]),
      "/p",
    );
    expect(text).toBe(
      [
        "aida test: 3 walkthroughs: 1 passed, 1 can't tell, 1 blocked",
        "  passed      a  1/1 steps",
        "  blocked     b  0/1 steps",
        "              skipped: needs s, which p didn't leave",
        "              why: blocked by a possible app bug in p",
        "  can't tell  c  0/1 steps",
        '              step "z": timeout',
        "              screenshot: .build/c/ci/capture/frames/f.png",
        "              report: .build/c/ci/capture/failure.json",
      ].join("\n"),
    );
  });
});
