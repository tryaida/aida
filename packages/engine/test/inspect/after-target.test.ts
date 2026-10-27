// M35: which steps `inspect --after <ref>` replays, for a main step and for `<pathId>/<stepId>`.
import { describe, expect, it } from "vitest";
import { resolveAfterTarget } from "../../src/inspect/after.js";
import type { Walkthrough } from "../../src/walkthrough/index.js";

const step = (id: string) => ({ id, actions: [] });
const wt: Walkthrough = {
  walkthrough: "record-payment",
  title: "Record a payment",
  start: { signed_in_as: "office-staff", page: "/bookings/1" },
  data: { amount: "40.00" },
  setup: { steps: [step("make-booking")] },
  steps: [step("open-booking"), step("open-payments"), step("enter-amount"), step("save")],
  paths: [
    {
      id: "from-attendee",
      title: "From the attendee's page",
      when: "Use this when you start from the person.",
      start: { page: "/attendees/7" },
      steps: [step("open-attendee"), step("pick-booking")],
      joins: "open-payments",
    },
  ],
};

describe("resolveAfterTarget", () => {
  it("keeps a main step id as it was: the walkthrough itself, stopping there", () => {
    const t = resolveAfterTarget(wt, "enter-amount");
    expect(t).toEqual({ walkthrough: wt, stopAfterStep: "enter-amount" });
  });

  it("replays a path's opening step from the path's start page, with the walkthrough's setup and persona", () => {
    const t = resolveAfterTarget(wt, "from-attendee/pick-booking");
    if ("error" in t) throw new Error(t.error);
    expect(t.path).toBe("from-attendee");
    expect(t.stopAfterStep).toBe("pick-booking");
    expect(t.walkthrough.start).toEqual({ signed_in_as: "office-staff", page: "/attendees/7" });
    expect(t.walkthrough.steps.map((s) => s.id)).toEqual(["open-attendee", "pick-booking", "open-payments", "enter-amount", "save"]);
    expect(t.walkthrough.setup).toEqual(wt.setup);
    expect(t.walkthrough.data).toEqual(wt.data);
    expect(t.walkthrough.paths).toBeUndefined();
  });

  it("reaches a shared main step through the path", () => {
    const t = resolveAfterTarget(wt, "from-attendee/save");
    if ("error" in t) throw new Error(t.error);
    expect(t.stopAfterStep).toBe("save");
    expect(t.walkthrough.start?.page).toBe("/attendees/7");
  });

  it("explains a main step the path skips, an unknown path and an unknown step", () => {
    expect(resolveAfterTarget(wt, "from-attendee/open-booking")).toEqual({
      error:
        '"open-booking" is a main step before the path joins at "open-payments", so this path never runs it (path steps: open-attendee, pick-booking; then main steps from open-payments: open-payments, enter-amount, save)',
    });
    expect(resolveAfterTarget(wt, "from-desk/save")).toEqual({ error: 'no path "from-desk" in walkthrough record-payment (paths: from-attendee)' });
    expect(resolveAfterTarget(wt, "nope")).toEqual({
      error: 'no step "nope" in walkthrough record-payment (steps: open-booking, open-payments, enter-amount, save); a path\'s step is "<pathId>/<stepId>" (paths: from-attendee)',
    });
    const { paths: _p, ...noPaths } = wt;
    expect(resolveAfterTarget(noPaths, "nope")).toEqual({
      error: 'no step "nope" in walkthrough record-payment (steps: open-booking, open-payments, enter-amount, save)',
    });
  });

  it("prefers a main step whose id has a slash in it, as the edit actions do", () => {
    const odd: Walkthrough = { ...wt, steps: [...wt.steps, step("from-attendee/save")] };
    expect(resolveAfterTarget(odd, "from-attendee/save")).toEqual({ walkthrough: odd, stopAfterStep: "from-attendee/save" });
  });
});
