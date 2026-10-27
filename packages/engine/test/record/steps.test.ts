import { describe, expect, it } from "vitest";
import * as YAML from "yaml";
import { buildSteps, draftYaml, fictionalPhone, parseSnapshotHead, safeValue, urlPattern } from "../../src/record/index.js";
import type { RecordedAction, ResolvedTarget } from "../../src/record/index.js";
import type { Target } from "../../src/walkthrough/index.js";

const at = (target: Target, verified = true): ResolvedTarget => ({
  target,
  verified,
  words: target.name ?? target.label ?? target.text ?? "this",
});

describe("buildSteps", () => {
  it("gathers field fills into one step and gives every other click its own", () => {
    const recorded: RecordedAction[] = [
      { kind: "click", at: at({ role: "link", name: "Competitors" }), field: false },
      { kind: "navigate", path: "/competitors", byAction: true },
      { kind: "type", at: at({ label: "First name" }), text: "Jordan", secret: false },
      { kind: "select", at: at({ label: "Class" }), option: "Open" },
      { kind: "click", at: at({ label: "Paid" }), field: true },
      { kind: "click", at: at({ role: "button", name: "Save" }), field: false },
    ];
    const built = buildSteps(recorded);
    expect(built.steps.map((s) => [s.id, s.title, s.say])).toEqual([
      ["open-competitors", "Open Competitors", "Click **Competitors**."],
      ["fill-in-first-name-class", "Fill in First name, Class and more", "Fill in **First name**, **Class** and **Paid**."],
      ["click-save", "Click Save", "Click **Save**."],
    ]);
    expect(built.steps[0].actions[1]).toEqual({ do: "waitForUrl", pattern: urlPattern("/competitors") });
    expect(built.data).toEqual({ firstName: "Jordan" });
  });

  it("waits only for where a redirect chain ended, and turns a direct visit into a goto", () => {
    const built = buildSteps([
      { kind: "click", at: at({ role: "button", name: "Save" }), field: false },
      { kind: "navigate", path: "/saving", byAction: true },
      { kind: "navigate", path: "/competitors/123", byAction: true },
      { kind: "navigate", path: "/settings", byAction: false },
    ]);
    expect(built.steps[0].actions).toEqual([
      { do: "click", target: { role: "button", name: "Save" } },
      { do: "waitForUrl", pattern: "^[^?#]*://[^/]+/competitors/[^/?#]+(?:[?#].*)?$" },
    ]);
    expect(built.steps[1]).toMatchObject({ id: "go-to-settings", actions: [{ do: "goto", path: "/settings" }] });
  });

  it("puts a note on the step just done, a check into it, and a pointer in a step of its own", () => {
    const built = buildSteps([
      { kind: "note", text: "Before anything else." },
      { kind: "click", at: at({ role: "button", name: "Save" }), field: false },
      { kind: "note", text: "Save it." },
      { kind: "expect", at: at({ text: "Saved" }) },
      { kind: "step", title: "Look at the total" },
      { kind: "point", at: at({ text: "Total" }) },
    ]);
    expect(built.steps).toHaveLength(2);
    expect(built.steps[0]).toMatchObject({ say: "Save it.", noted: true, comments: ["Note: Before anything else."] });
    expect(built.steps[0].actions.map((a) => a.do)).toEqual(["click", "expect"]);
    expect(built.steps[1]).toMatchObject({ id: "look-at-the-total", title: "Look at the total", say: "This is **Total**." });
  });

  it("marks targets it couldn't confirm, and never keeps a password", () => {
    const built = buildSteps([
      { kind: "type", at: at({ label: "Password" }), text: "", secret: true },
      { kind: "click", at: at({ role: "link", name: "Next" }, false), field: false },
    ]);
    expect(built.unverified).toBe(1);
    expect(built.data).toEqual({ password: "TODO: a demo password" });
    expect(built.steps[0].comments[0]).toMatch(/password field/);
    expect(built.steps[1].comments[0]).toMatch(/couldn't confirm/);
  });

  it("swaps personal-looking values typed into fields", () => {
    const built = buildSteps([{ kind: "type", at: at({ label: "Phone" }), text: "0412 345 678", secret: false }], { locale: "en-AU" });
    expect(built.data.phone).toBe("0491 570 156");
    expect(built.swapped).toEqual(['phone number in "Phone"']);
  });
});

describe("safeValue", () => {
  it("leaves safe demo values alone", () => {
    expect(safeValue("alex@example.com")).toEqual({ value: "alex@example.com", swapped: [] });
    expect(safeValue("0491 570 156")).toEqual({ value: "0491 570 156", swapped: [] });
    expect(safeValue("Riverbend Show 2026")).toEqual({ value: "Riverbend Show 2026", swapped: [] });
  });

  it("swaps real-looking emails, phone numbers and card numbers", () => {
    expect(safeValue("jo@gmail.com, sam@work.org").value).toBe("person@example.com, person2@example.com");
    expect(safeValue("4111 1111 1111 1111")).toEqual({ value: "4242 4242 4242 4242", swapped: ["card number"] });
    expect(safeValue("212-555-7890", "en-US").value).toBe(fictionalPhone("en-US"));
  });
});

describe("parseSnapshotHead", () => {
  it("reads the role and name off the first line", () => {
    expect(parseSnapshotHead('- button "Save"')).toEqual({ role: "button", name: "Save" });
    expect(parseSnapshotHead('- link "Say \\"hi\\"":\n  - /url: /x')).toEqual({ role: "link", name: 'Say "hi"' });
    expect(parseSnapshotHead("- text: Hello")).toEqual({ role: "text" });
  });
});

describe("draftYaml", () => {
  it("writes a schema-valid draft with its TODOs as comments", () => {
    const built = buildSteps([{ kind: "click", at: at({ role: "link", name: "Next" }, false), field: false }]);
    const yaml = draftYaml(
      { id: "next", title: "Next", startPage: "/", persona: { role: "office_staff" }, needs: ["session-full"], recordedOn: "2026-10-27" },
      built,
    );
    expect(yaml).toMatch(/^# DRAFT — recorded with `aida record` on 2026-10-27\./);
    expect(yaml).toContain("# TODO: check this target");
    const doc = YAML.parse(yaml);
    expect(doc.start).toEqual({ signed_in_as: "office_staff", page: "/" });
    expect(doc.needs).toEqual(["session-full"]);
  });
});
