// `aida validate` runs QA's text-only checks (build-plan.md M26): chapter titles and captions
// that QA's 42-character line limit would reject, found before any voice or render runs. Cues are
// built the way render builds them, so a long caption render wraps cleanly isn't flagged.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validatePath } from "../../src/commands/validate.js";
import { checkWalkthroughText } from "../../src/qa/walkthrough-text.js";
import { loadWalkthroughText } from "../../src/walkthrough/index.js";

const TITLE_43 = "Choose the session and confirm all the times"; // 44 chars
const TITLE_OK = "Choose the session";

function walkthrough(steps: string): string {
  return `walkthrough: add-session
title: Add a session
steps:
${steps}`;
}

describe("validate text checks", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "aida-validate-text-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("catches a 43-character chapter title with file, line, step id and the exact text", async () => {
    const title = "x".repeat(43);
    const file = path.join(dir, "add-session.yaml");
    await writeFile(
      file,
      walkthrough(`  - id: open
    title: ${TITLE_OK}
    do: click "Sessions" button
  - id: pick
    title: ${title}
    do: click "Add" button
`),
    );
    const [result] = validatePath(file);
    expect(result.ok).toBe(false);
    expect(result.file).toBe(file);
    expect(result.errors).toHaveLength(1);
    const [e] = result.errors!;
    expect(e).toMatchObject({ line: 8, path: "steps.1.title", step: "pick", text: title, check: "captions:line-length" });
    expect(e.message).toContain("43 characters");
    expect(e.message).toContain("42");
  });

  it("passes a 42-character title", () => {
    const wt = loadWalkthroughText(walkthrough(`  - id: a\n    title: ${"x".repeat(42)}\n    do: click "A" button\n`));
    expect(checkWalkthroughText(wt)).toEqual([]);
  });

  it("does not flag a long caption that render wraps onto lines that fit", () => {
    const say = "Pick the session from the list, check the start and finish times, then select Save to add it to the programme.";
    const wt = loadWalkthroughText(walkthrough(`  - id: a\n    title: ${TITLE_OK}\n    say: ${say}\n    do: click "A" button\n`));
    expect(say.length).toBeGreaterThan(84);
    expect(checkWalkthroughText(wt)).toEqual([]);
  });

  it("flags a caption render would still leave over-long, naming the line and field", async () => {
    const url = "example.com/sessions/" + "a".repeat(30); // one 51-char word: wrapping can't split it
    const file = path.join(dir, "add-session.yaml");
    await writeFile(
      file,
      walkthrough(`  - id: open
    title: ${TITLE_OK}
    say: Go to ${url} in your browser.
    caption: Open ${url} in your browser.
    do: click "A" button
`),
    );
    const [result] = validatePath(file);
    expect(result.ok).toBe(false);
    const [e] = result.errors!;
    // The caption field wins over say, as in render.
    expect(e).toMatchObject({ line: 7, path: "steps.0.caption", step: "open", check: "captions:line-length" });
    expect(e.message).toContain(url);
    expect(e.message).toContain("51 characters");
  });

  it("checks intro and outro captions too", () => {
    const long = "y".repeat(45);
    const wt = loadWalkthroughText(
      `walkthrough: a\ntitle: A\nintro:\n  say: ${long}\noutro:\n  caption: ok\nsteps:\n  - id: s\n    do: click "A" button\n`,
    );
    const problems = checkWalkthroughText(wt, `walkthrough: a\ntitle: A\nintro:\n  say: ${long}\noutro:\n  caption: ok\nsteps:\n  - id: s\n    do: click "A" button\n`);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ step: "intro", path: "intro.say", line: 4, track: "captions" });
  });

  it("still reports a 44-character title in the chapters track", () => {
    const wt = loadWalkthroughText(walkthrough(`  - id: a\n    title: ${TITLE_43}\n    do: click "A" button\n`));
    const [p] = checkWalkthroughText(wt);
    expect(p).toMatchObject({ track: "chapters", step: "a", text: TITLE_43 });
  });
});
