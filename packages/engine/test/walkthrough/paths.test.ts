// M33: walkthrough `paths` (decision 34) — schema, cross-checks and the path expansion capture uses.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWalkthroughText, pathWalkthrough, WalkthroughValidationError } from "../../src/walkthrough/index.js";
import { validatePath } from "../../src/commands/validate.js";

const base = (paths: string, start = "  signed_in_as: office_staff\n  page: /bookings/1\n") => `
walkthrough: record-a-payment
title: Record a payment
start:
${start}steps:
  - id: open-booking-payment
    title: Open the payment form
    do: click "Record payment" button
  - id: fill-amount
    title: Enter the amount
    do: fill "Amount" with "50"
  - id: save
    title: Save the payment
    do: click "Save" button
    check: text "Payment saved" is visible
${paths}`;

const attendeePath = `paths:
  - id: from-attendee
    title: From the attendee's page
    when: Use this when the attendee is paying for several bookings at once.
    start: { page: /attendees/7 }
    steps:
      - id: open-attendee-payment
        title: Open the payment form
        do: click "Pay" button
    joins: fill-amount
`;

function errorsOf(text: string): string[] {
  try {
    loadWalkthroughText(text, "fixture.yaml");
  } catch (err) {
    if (err instanceof WalkthroughValidationError) return err.errors.map((e) => e.message);
    throw err;
  }
  return [];
}

describe("walkthrough paths: schema", () => {
  it("loads a path with its own start and opening steps", () => {
    const wt = loadWalkthroughText(base(attendeePath), "fixture.yaml");
    expect(wt.paths).toHaveLength(1);
    const p = wt.paths![0];
    expect(p).toMatchObject({ id: "from-attendee", title: "From the attendee's page", joins: "fill-amount", start: { page: "/attendees/7" } });
    expect(p.steps[0].actions).toEqual([{ do: "click", target: { role: "button", name: "Pay" } }]);
  });

  it("rejects a path that joins a step that isn't a main step", () => {
    const errors = errorsOf(base(attendeePath.replace("joins: fill-amount", "joins: nowhere")));
    expect(errors.join("\n")).toMatch(/joins "nowhere", which isn't a main step id/);
  });

  it("rejects two paths with the same id", () => {
    const twice = attendeePath + attendeePath.replace("paths:\n", "").replace("open-attendee-payment", "open-attendee-payment-2");
    expect(errorsOf(base(twice)).join("\n")).toMatch(/path id "from-attendee" is used twice/);
  });

  it("rejects needs/leaves on a path, saying where they belong", () => {
    const errors = errorsOf(base(attendeePath.replace("    joins: fill-amount", "    joins: fill-amount\n    leaves: [paid]")));
    expect(errors.join("\n")).toMatch(/can't have `leaves`; put it on the walkthrough itself/);
  });

  it("rejects a path signing in as someone else", () => {
    const errors = errorsOf(base(attendeePath.replace("start: { page: /attendees/7 }", "start: { page: /attendees/7, signed_in_as: admin }")));
    expect(errors.join("\n")).toMatch(/signs in as "admin" but the walkthrough signs in as "office_staff"/);
  });

  it("accepts a path repeating the walkthrough's persona", () => {
    const wt = loadWalkthroughText(base(attendeePath.replace("start: { page: /attendees/7 }", "start: { page: /attendees/7, signed_in_as: office_staff }")), "f.yaml");
    expect(wt.paths![0].start.signed_in_as).toBe("office_staff");
  });

  it("rejects a persona on a path's start: the walkthrough's persona is the only one", () => {
    const errors = errorsOf(base(attendeePath.replace("start: { page: /attendees/7 }", "start: { page: /attendees/7, persona: { role: office_staff, name: Someone Else } }")));
    expect(errors.join("\n")).toMatch(/persona/);
  });

  it("rejects a path step id that is also a main step id", () => {
    const errors = errorsOf(base(attendeePath.replace("id: open-attendee-payment", "id: save")));
    expect(errors.join("\n")).toMatch(/step id "save" is also a main step id/);
  });

  it("rejects a path with no opening steps or no when", () => {
    expect(errorsOf(base(attendeePath.replace(/    steps:\n      - id: open-attendee-payment\n        title: Open the payment form\n        do: click "Pay" button\n/, "    steps: []\n"))).join("\n")).toMatch(/at least one step of its own/);
    expect(errorsOf(base(attendeePath.replace(/    when: .*\n/, ""))).length).toBeGreaterThan(0);
  });

  // Decision 37: a path may run to its own end with its own steps and its own final check.
  const listPath = (lastStep: string) => `paths:
  - id: from-list
    title: From the list
    when: Use this when you're on the list.
    start: { page: /payments }
    steps:
      - id: list-amount
        title: Enter the amount
        do: fill "Amount" with "50"
${lastStep}`;

  it("loads a path with no joins whose last step ends in a check", () => {
    for (const last of [
      `      - id: list-save
        title: Save
        do: click "Record" button
        check: text "Payment recorded" is visible
`,
      `      - id: list-save
        title: Save
        actions:
          - { do: click, target: { role: button, name: Record } }
          - { do: waitForUrl, pattern: /payments }
`,
    ]) {
      const wt = loadWalkthroughText(base(listPath(last)), "fixture.yaml");
      expect(wt.paths![0].joins).toBeUndefined();
    }
  });

  it("rejects a path with no joins whose last step doesn't end in a check, saying how to fix it", () => {
    const errors = errorsOf(base(listPath(`      - id: list-save
        title: Save
        do: click "Record" button
`)));
    expect(errors.join("\n")).toMatch(/path "from-list" has no `joins`, so it runs to its own end: its last step needs a check/);
  });
});

describe("pathWalkthrough", () => {
  it("runs the path's opening steps then the main steps from joins on, from the path's page as the same persona", () => {
    const wt = loadWalkthroughText(base(attendeePath), "fixture.yaml");
    const run = pathWalkthrough(wt, wt.paths![0]);
    expect(run.walkthrough.steps.map((s) => s.id)).toEqual(["open-attendee-payment", "fill-amount", "save"]);
    expect(run.walkthrough.start).toMatchObject({ page: "/attendees/7", signed_in_as: "office_staff", persona: { role: "office_staff" } });
    expect(run.walkthrough.paths).toBeUndefined();
    expect(run.openingSteps).toBe(1);
    expect(run.joinIndex).toBe(1);
    expect(run.walkthrough.walkthrough).toBe("record-a-payment");
    expect(run.alone).toBe(false);
  });

  it("runs only a path's own steps when it has no joins", () => {
    const wt = loadWalkthroughText(
      base(attendeePath.replace("    joins: fill-amount\n", "").replace('do: click "Pay" button', 'do: click "Pay" button\n        check: text "Paid" is visible')),
      "fixture.yaml",
    );
    const run = pathWalkthrough(wt, wt.paths![0]);
    expect(run.walkthrough.steps.map((s) => s.id)).toEqual(["open-attendee-payment"]);
    expect(run).toMatchObject({ alone: true, joinIndex: -1, openingSteps: 1 });
    // Its end checks are the walkthrough's: validate.database is kept.
    expect(run.walkthrough.start?.page).toBe("/attendees/7");
  });
});

describe("aida validate: paths", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("reports an unresolved template in a path step and a bad joins with its line", () => {
    const dir = mkdtempSync(join(tmpdir(), "aida-paths-validate-"));
    dirs.push(dir);
    writeFileSync(join(dir, "a.yaml"), base(attendeePath.replace('do: click "Pay" button', 'do: fill "Payer" with "{{payer.name}}"')));
    writeFileSync(join(dir, "b.yaml"), base(attendeePath.replace("joins: fill-amount", "joins: nope")).replace("record-a-payment", "record-b"));
    const [a, b] = validatePath(dir);
    expect(a.ok).toBe(false);
    expect(a.errors?.[0].message).toMatch(/\{\{payer\.name\}\}/);
    expect(b.ok).toBe(false);
    expect(b.errors?.[0]).toMatchObject({ path: "paths.0.joins" });
    expect(b.errors?.[0].line).toBeGreaterThan(0);
  });
});

describe("capture plan: paths want a reset", () => {
  it("resets before a walkthrough with paths at the start of its chain, never inside one", async () => {
    const { planCaptureRun } = await import("../../src/states/order.js");
    const all = [
      { walkthrough: "add-booking", leaves: ["booking-exists"] },
      { walkthrough: "record-payment", needs: ["booking-exists"], paths: [{}] },
      { walkthrough: "lone-payment", paths: [{}] },
    ];
    const plan = planCaptureRun(all, all, {}, { reset: "database-checks" });
    const byId = Object.fromEntries(plan.walkthroughs.map((w) => [w.id, w]));
    expect(byId["lone-payment"].resetBefore).toBe(true);
    expect(byId["add-booking"].resetBefore).toBe(true); // the reset moved to the chain's start
    expect(byId["record-payment"].resetBefore).toBe(false); // its paths will be marked not captured
  });
});
