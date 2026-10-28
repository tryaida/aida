// The builder interview (M40, decision 38): the guide's questions, `app-interview.yaml`, the
// `aida interview` commands, and the brief's optional sections and reader profile it feeds.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { briefOverview, briefPages, briefReaders, checkBrief, parseBrief } from "../../src/brief/index.js";
import { runBriefCheck } from "../../src/commands/brief.js";
import {
  runInterviewAnswer,
  runInterviewApplied,
  runInterviewAsk,
  runInterviewNext,
  runInterviewNotes,
  runInterviewSkip,
  runInterviewStart,
  runInterviewStatus,
} from "../../src/commands/interview.js";
import { buildDomain } from "../../src/domain/index.js";
import {
  InterviewError,
  addFollowUp,
  answerQuestion,
  buildInterviewGuide,
  formatInterview,
  interviewNotes,
  interviewStatus,
  markApplied,
  mergeGuide,
  nextQuestions,
  openQuestions,
  parseInterview,
  readerPhrase,
  skipQuestion,
  type InterviewFile,
} from "../../src/interview/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "..", "fixtures");
const briefText = readFileSync(path.join(fixtures, "brief", "app-brief.md"), "utf8");
const brief = parseBrief(briefText);

let dir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "aida-interview-test-"));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

function lastJson(): Record<string, unknown> {
  const calls = logSpy.mock.calls;
  return JSON.parse(String(calls[calls.length - 1][0])) as Record<string, unknown>;
}

function emptyInterview(questions = buildInterviewGuide({ app: "Acme Events", depth: "standard", brief })): InterviewFile {
  const data: InterviewFile = { app: "Acme Events", depth: "standard", started: "2026-10-28", updated: "2026-10-28", questions: [] };
  mergeGuide(data, questions);
  return data;
}

describe("buildInterviewGuide", () => {
  it("asks only the essentials at quick depth, and more at each deeper one", () => {
    const quick = buildInterviewGuide({ app: "Acme Events", depth: "quick", brief });
    const standard = buildInterviewGuide({ app: "Acme Events", depth: "standard", brief });
    const deep = buildInterviewGuide({ app: "Acme Events", depth: "deep", brief });
    expect(quick.every((q) => q.priority === 1)).toBe(true);
    expect(quick.length).toBeLessThan(standard.length);
    expect(standard.length).toBeLessThan(deep.length);
    expect(standard.some((q) => q.priority === 3)).toBe(false);
    // Essentials cover purpose, every reader, whole jobs, what can't be undone and where people get stuck.
    const ids = quick.map((q) => q.id);
    expect(ids).toEqual(expect.arrayContaining(["purpose-what", "reader-organiser-who", "reader-door-staff-where", "workflow-main", "rules-undo", "trouble-stuck"]));
  });

  it("names readers naturally whether the brief calls them a role, a plural or a group", () => {
    expect(readerPhrase("Organiser")).toBe("an organiser");
    expect(readerPhrase("an organizer")).toBe("an organizer");
    expect(readerPhrase("Event organisers")).toBe("event organisers");
    expect(readerPhrase("Door staff")).toBe("door staff");
    expect(readerPhrase("Coach")).toBe("a coach");
    const guide = buildInterviewGuide({ app: "Acme Events", depth: "quick", brief });
    expect(guide.find((q) => q.id === "reader-door-staff-where")!.ask).toBe(
      "Picture door staff opening Acme Events: where are they, and what are they using: a phone, a tablet, a computer? What else is going on around them?",
    );
  });

  it("takes readers from the config's roles when there's no brief yet", () => {
    const guide = buildInterviewGuide({ depth: "quick", roles: [{ role: "coach", name: "Coach" }] });
    const q = guide.find((x) => x.id === "reader-coach-who")!;
    expect(q.about).toBe("coach");
    expect(q.ask).toContain("Tell me about a coach:");
    expect(guide.find((x) => x.id === "purpose-what")!.ask).toContain("what does the app do");
    expect(guide.some((x) => x.known)).toBe(false);
  });

  it("marks questions the brief already answers so they're confirmed, not asked cold", () => {
    const guide = buildInterviewGuide({ app: "Acme Events", depth: "standard", brief });
    expect(guide.find((q) => q.id === "purpose-what")!.known).toBe(true);
    expect(guide.find((q) => q.id === "rules-undo")!.known).toBe(true);
    // No Workflows section and no reader profile in the fixture brief yet.
    expect(guide.find((q) => q.id === "workflow-main")!.known).toBeUndefined();
    expect(guide.find((q) => q.id === "reader-organiser-where")!.known).toBeUndefined();
    const withDevices = parseBrief(briefText.replace("    job: Check people in and take payments on the night.", "    job: Check people in and take payments on the night.\n    devices: [phone]"));
    const again = buildInterviewGuide({ app: "Acme Events", depth: "standard", brief: withDevices });
    expect(again.find((q) => q.id === "reader-door-staff-where")!.known).toBe(true);
  });

  it("brings in the brief's open questions as essentials", () => {
    expect(openQuestions(brief)).toEqual(["Can a door staff member refund a payment? (asked; waiting)"]);
    const q = buildInterviewGuide({ depth: "quick", brief }).find((x) => x.topic === "open")!;
    expect(q).toMatchObject({ source: "brief", priority: 1, goesTo: "brief", ask: "Can a door staff member refund a payment? (asked; waiting)" });
    expect(q.id).toMatch(/^open-can-a-door-staff-member-refund-[0-9a-f]{6}$/);
    expect(openQuestions(parseBrief("## Open questions\n\nNone.\n"))).toEqual([]);
  });

  it("asks what moves the domain model's things between states, and about outline tasks at deep depth", () => {
    const domain = buildDomain(path.join(fixtures, "domain", "prisma"));
    if (!domain.ok) throw new Error("fixture schema not read");
    const quick = buildInterviewGuide({ depth: "quick", domain: domain.model });
    expect(quick.some((q) => q.topic === "things")).toBe(false);
    const standard = buildInterviewGuide({ app: "Acme Events", depth: "standard", domain: domain.model });
    const things = standard.filter((q) => q.topic === "things");
    expect(things[0]).toMatchObject({ id: "thing-payment-states", priority: 2, goesTo: "Things it keeps track of" });
    expect(things[0].ask).toBe("A payment can be pending, completed or refunded. What moves one from one to the next, who does it, and can it go back?");
    // Things without states are only asked about at deep depth.
    expect(things.every((q) => q.id.endsWith("-states"))).toBe(true);
    const deep = buildInterviewGuide({
      app: "Acme Events",
      depth: "deep",
      domain: domain.model,
      cards: [
        { id: "record-a-payment", title: "Record a payment", for: "Organiser" },
        { id: "old-thing", title: "Old thing", status: "dropped" },
      ],
    });
    expect(deep.filter((q) => q.topic === "things").length).toBeGreaterThan(1);
    expect(deep.find((q) => q.id === "task-record-a-payment-when")!.ask).toBe('"Record a payment": when and why would an organiser do this? What comes just before it, and just after?');
    expect(deep.some((q) => q.id === "task-old-thing-when")).toBe(false);
  });
});

describe("app-interview.yaml", () => {
  it("round-trips through YAML, multi-line answers included", () => {
    const data = emptyInterview();
    answerQuestion(data, "purpose-what", "Runs community events.\n\nMostly sports clubs.");
    const back = parseInterview(formatInterview(data));
    expect(back.questions.find((q) => q.id === "purpose-what")).toMatchObject({ status: "answered", answer: "Runs community events.\n\nMostly sports clubs." });
    expect(back.questions.length).toBe(data.questions.length);
    expect(formatInterview(data)).toMatch(/^# The builder interview/);
  });

  it("refuses a file it can't trust", () => {
    expect(() => parseInterview("questions: nope\n")).toThrow(InterviewError);
    expect(() => parseInterview("questions:\n  - id: a\n    ask: x\n    topic: nonsense\n")).toThrow(/topic must be one of/);
    expect(() => parseInterview("questions:\n  - {id: a, ask: x, topic: purpose}\n  - {id: a, ask: y, topic: purpose}\n")).toThrow(/used twice/);
    expect(() => parseInterview("questions:\n  - {id: a, ask: x, topic: purpose, status: answered}\n")).toThrow(/no answer/);
  });

  it("keeps answers when the guide is merged again, and adds only what's new", () => {
    const data = emptyInterview(buildInterviewGuide({ app: "Acme Events", depth: "quick", brief }));
    answerQuestion(data, "purpose-what", "Runs events.");
    skipQuestion(data, "rules-undo", "doesn't apply");
    const before = data.questions.length;
    const { added } = mergeGuide(data, buildInterviewGuide({ app: "Acme Events", depth: "standard", brief }));
    expect(added).toBeGreaterThan(0);
    expect(data.questions.length).toBe(before + added);
    expect(data.questions.find((q) => q.id === "purpose-what")).toMatchObject({ status: "answered", answer: "Runs events." });
    expect(data.questions.find((q) => q.id === "rules-undo")).toMatchObject({ status: "skipped", reason: "doesn't apply" });
    expect(mergeGuide(data, buildInterviewGuide({ app: "Acme Events", depth: "standard", brief }))).toEqual({ added: 0, retired: 0 });
  });

  it("asks the essentials across every topic before any detail, follow-ups with their topic", () => {
    const data = emptyInterview();
    const all = nextQuestions(data, { count: 100 });
    const firstDetail = all.findIndex((q) => q.priority > 1);
    expect(all.slice(0, firstDetail).every((q) => q.priority === 1)).toBe(true);
    expect(all[0].id).toBe("purpose-what");
    expect(nextQuestions(data).length).toBe(3);
    expect(nextQuestions(data, { topic: "trouble" }).map((q) => q.topic)).toEqual(["trouble", "trouble", "trouble"]);
    answerQuestion(data, "purpose-what", "Runs events.");
    answerQuestion(data, "purpose-before", "A spreadsheet.");
    const follow = addFollowUp(data, { topic: "readers", ask: "Do door staff share one phone?", after: "reader-door-staff-where" });
    expect(follow).toMatchObject({ id: "fu-readers-do-door-staff-share-one", about: "door_staff", goesTo: "readers.devices", priority: 1, source: "follow-up" });
    const order = nextQuestions(data, { count: 100 }).map((q) => q.id);
    expect(order.indexOf(follow.id)).toBeLessThan(order.indexOf("workflow-main"));
    expect(addFollowUp(data, { topic: "readers", ask: "Do door staff share one phone?" }).id).toBe("fu-readers-do-door-staff-share-one-2");
  });

  it("records, appends, skips and marks answers applied", () => {
    const data = emptyInterview();
    expect(() => answerQuestion(data, "nope", "x")).toThrow(/no question "nope"/);
    expect(() => answerQuestion(data, "purpose-what", "  ")).toThrow(/empty/);
    answerQuestion(data, "trouble-asked", "How to refund.");
    markApplied(data, ["trouble-asked"]);
    answerQuestion(data, "trouble-asked", "And how to move a booking.", { append: true });
    const q = data.questions.find((x) => x.id === "trouble-asked")!;
    expect(q.answer).toBe("How to refund.\n\nAnd how to move a booking.");
    // A changed answer has to be moved again.
    expect(q.applied).toBeUndefined();
    expect(() => skipQuestion(data, "trouble-asked")).toThrow(/already answered/);
    expect(() => markApplied(data, ["trouble-stuck"])).toThrow(/not answered yet: trouble-stuck/);
  });

  it("is ready once every essential is answered or skipped and every brief answer is moved", () => {
    const data = emptyInterview(buildInterviewGuide({ app: "Acme Events", depth: "quick", brief }));
    expect(interviewStatus(data).ready).toBe(false);
    for (const q of data.questions) answerQuestion(data, q.id, `Answer to ${q.id}.`);
    let status = interviewStatus(data);
    expect(status.essentialOpen).toEqual([]);
    expect(status.unappliedBrief.length).toBe(data.questions.length);
    expect(status.ready).toBe(false);
    markApplied(data, status.unappliedBrief);
    status = interviewStatus(data);
    expect(status.ready).toBe(true);
    expect(status.topics.find((t) => t.topic === "readers")).toMatchObject({ title: "Who uses it", answered: 4, open: 0 });
  });

  it("keeps planner answers apart, and flags personal data before it reaches the brief", () => {
    const data = emptyInterview();
    answerQuestion(data, "scope-leave-out", "Leave out the admin billing screens.");
    answerQuestion(data, "trouble-asked", "Ring Sam on +1 415 555 2671 or write to sam@realclub.org about refunds.");
    const status = interviewStatus(data);
    expect(status.unappliedPlan).toEqual(["scope-leave-out"]);
    expect(status.unappliedBrief).toEqual(["trouble-asked"]);
    expect(status.personalData.map((p) => p.id)).toEqual(["trouble-asked", "trouble-asked"]);
  });

  it("hands over answers as compact notes grouped by where they go", () => {
    const data = emptyInterview();
    answerQuestion(data, "reader-door-staff-where", "On their own phones,\nat a noisy door.");
    answerQuestion(data, "trouble-stuck", "They forget to mark cash paid.");
    answerQuestion(data, "scope-leave-out", "Leave out billing.");
    markApplied(data, ["trouble-stuck"]);
    const notes = interviewNotes(data);
    expect(notes).toContain("## Readers (frontmatter profile and Who uses it)\n\n- [reader-door-staff-where] (door_staff; readers.devices) Q: ");
    expect(notes).toContain("  A: On their own phones, at a noisy door.");
    expect(notes).toContain("## Where people get stuck\n\n- [trouble-stuck] (applied) Q:");
    expect(notes).toContain("## For the planner (not published)");
    expect(interviewNotes(data, { unapplied: true })).not.toContain("trouble-stuck");
    expect(interviewNotes(data, { goesTo: "readers" })).not.toContain("billing");
    expect(interviewNotes(data, { goesTo: "plan" })).toContain("Leave out billing.");
    expect(interviewNotes(emptyInterview())).toBe("No answers yet.");
  });
});

describe("aida interview commands", () => {
  async function writeConfig(withBrief = true): Promise<string> {
    const cfg = path.join(dir, "aida.config.mjs");
    writeFileSync(cfg, `export default { app: { baseUrl: "http://localhost:3000" }, walkthroughsDir: "./walkthroughs", roles: { organiser: "Organiser" } };\n`);
    if (withBrief) writeFileSync(path.join(dir, "app-brief.md"), briefText);
    return cfg;
  }

  it("runs an interview end to end beside the brief", async () => {
    const cfg = await writeConfig();
    expect(await runInterviewStart({ configPath: cfg, depth: "quick", json: true })).toBe(0);
    const started = lastJson();
    expect(started).toMatchObject({ ok: true, created: true, depth: "quick", brief: true });
    const file = path.join(dir, "app-interview.yaml");
    expect(started.path).toBe(file);

    expect(await runInterviewNext({ configPath: cfg, count: 2, json: true })).toBe(0);
    const next = lastJson() as { questions: { id: string }[] };
    expect(next.questions.map((q) => q.id)).toEqual(["purpose-what", "purpose-before"]);

    expect(await runInterviewAnswer({ configPath: cfg, id: "purpose-what", text: "Ticketed community events.", json: false })).toBe(0);
    expect(await runInterviewSkip({ configPath: cfg, id: "purpose-before", reason: "same as the brief", json: false })).toBe(0);
    expect(await runInterviewAsk({ configPath: cfg, topic: "purpose", text: "Who pays for it?", after: "purpose-what", json: true })).toBe(0);
    expect(lastJson()).toMatchObject({ ok: true, result: { id: "fu-purpose-who-pays-for-it" } });
    expect(await runInterviewApplied({ configPath: cfg, ids: ["purpose-what"], json: false })).toBe(0);
    expect(await runInterviewApplied({ configPath: cfg, ids: ["fu-purpose-who-pays-for-it"], json: true })).toBe(1);
    expect(lastJson()).toMatchObject({ ok: false, error: "not answered yet: fu-purpose-who-pays-for-it" });

    // Rerunning start at a deeper depth keeps every answer.
    expect(await runInterviewStart({ configPath: cfg, depth: "standard", json: true })).toBe(0);
    expect(lastJson()).toMatchObject({ created: false, depth: "standard" });
    const saved = parseInterview(readFileSync(file, "utf8"));
    expect(saved.depth).toBe("standard");
    expect(saved.questions.find((q) => q.id === "purpose-what")).toMatchObject({ status: "answered", applied: true });
    expect(saved.questions.find((q) => q.id === "purpose-before")).toMatchObject({ status: "skipped", reason: "same as the brief" });

    expect(await runInterviewStatus({ configPath: cfg, json: true })).toBe(0);
    expect(lastJson()).toMatchObject({ ok: true, answered: 1, skipped: 1, ready: false });
    expect(await runInterviewNotes({ configPath: cfg, json: true })).toBe(0);
    expect(String(lastJson().notes)).toContain("Ticketed community events.");
  });

  it("reports what's missing instead of guessing", async () => {
    expect(await runInterviewStart({ json: true })).toBe(1);
    expect(lastJson().error).toMatch(/pass --config/);
    const cfg = await writeConfig(false);
    expect(await runInterviewNext({ configPath: cfg, json: true })).toBe(1);
    expect(lastJson().error).toMatch(/aida interview start writes one/);
    expect(await runInterviewStart({ configPath: cfg, depth: "forever", json: true })).toBe(1);
    expect(await runInterviewStart({ configPath: cfg, json: true })).toBe(0);
    // No brief: readers come from the config's roles.
    expect(lastJson()).toMatchObject({ brief: false, depth: "standard" });
    expect(await runInterviewNext({ configPath: cfg, topic: "readers", count: 1, json: true })).toBe(0);
    expect((lastJson() as { questions: { id: string }[] }).questions[0].id).toBe("reader-organiser-who");
    expect(await runInterviewAsk({ configPath: cfg, topic: "nope", text: "x", json: true })).toBe(1);
    expect(await runInterviewApplied({ configPath: cfg, ids: [], json: true })).toBe(1);
  });

  it("works on an explicit file without a config", async () => {
    const file = path.join(dir, "notes", "interview.yaml");
    expect(await runInterviewStart({ file, depth: "quick", json: true })).toBe(0);
    expect(lastJson()).toMatchObject({ path: file, brief: false });
    expect(await runInterviewAnswer({ file, id: "rules-undo", text: "Refunds.", json: false })).toBe(0);
    expect(await runInterviewApplied({ file, ids: [], all: true, json: true })).toBe(0);
    expect(lastJson()).toMatchObject({ result: { ids: ["rules-undo"] } });
  });
});

describe("the brief's interview additions", () => {
  const extended = briefText
    .replace(
      "    job: Check people in and take payments on the night.",
      "    job: Check people in and take payments on the night.\n    devices: [phone]\n    comfort: new\n    frequency: A few nights a month\n    context: At a busy door with a queue",
    )
    .replace(
      "## Open questions",
      "## Workflows\n\n- Run an event: publish it, chase held bookings in the last week, check people in on the night.\n\n## Where people get stuck\n\n- Cash taken at the door isn't marked paid: open the booking and record a payment.\n- People look for a refund button on the attendee: refunds are on the payment.\n\n## Open questions",
    );

  it("checks the optional sections and profile fields without requiring them", () => {
    const result = checkBrief(extended);
    expect(result.ok).toBe(true);
    expect(result.warnings.filter((w) => !w.section || ["Workflows", "Where people get stuck"].includes(w.section))).toEqual([]);
    expect(result.sections.find((s) => s.name === "Workflows")).toMatchObject({ present: true, filled: true });
    expect(checkBrief(briefText).sections.some((s) => s.name === "Workflows")).toBe(false);

    const bad = checkBrief(
      briefText.replace("    job: Check people in and take payments on the night.", "    job: Check people in and take payments on the night.\n    devices: [laptop]\n    comfort: expert\n    frequency: 3").replace("## Open questions", "## Workflows\n\n## Open questions"),
    );
    expect(bad.ok).toBe(true);
    const messages = bad.warnings.map((w) => w.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        "readers[1].devices must be a list of phone, tablet, desktop (not laptop)",
        "readers[1].comfort must be one of new, some, confident",
        "readers[1].frequency must be a short sentence",
        '"Workflows" is empty; fill it or remove the heading',
      ]),
    );
  });

  it("gives readers only well-formed profile fields", () => {
    const readers = briefReaders(parseBrief(extended));
    expect(readers[1]).toEqual({ role: "door_staff", name: "Door staff", job: "Check people in and take payments on the night.", devices: ["phone"], comfort: "new", frequency: "A few nights a month", context: "At a busy door with a queue" });
    const messy = briefReaders(parseBrief(briefText.replace("    job: Check people in and take payments on the night.", "    job: Check people in and take payments on the night.\n    devices: [phone, laptop]\n    comfort: expert")));
    expect(messy[1].devices).toEqual(["phone"]);
    expect(messy[1].comfort).toBeUndefined();
  });

  it("publishes them to the agent connector and as a Common problems page", () => {
    const parsed = parseBrief(extended);
    const overview = briefOverview(parsed)!;
    expect(overview).toContain("Door staff (Check people in and take payments on the night; on phone, A few nights a month)");
    expect(overview).toContain("## Workflows\n\n- Run an event:");
    expect(overview).toContain("## Where people get stuck");
    const page = briefPages(parsed).find((p) => p.slug === "common-problems")!;
    expect(page).toMatchObject({ category: "troubleshooting-and-faq", title: "Common problems" });
    expect(page.body.split("\n")).toHaveLength(2);
    expect(briefPages(brief).some((p) => p.slug === "common-problems")).toBe(false);
  });

  it("counts only the required sections in aida brief check's summary", async () => {
    const file = path.join(dir, "app-brief.md");
    writeFileSync(file, extended);
    expect(await runBriefCheck({ brief: file, json: false })).toBe(0);
    expect(String(logSpy.mock.calls[0][0])).toMatch(/— 8\/8 sections filled \(and Workflows, Where people get stuck\), \d+ characters/);
  });
});

describe("review fixes", () => {
  it("gives open questions that start alike, or use another script, their own ids", () => {
    const text = briefText.replace(
      "- Can a door staff member refund a payment? (asked; waiting)",
      "- What happens to a booking when the event is cancelled by the organiser?\n- What happens to a booking when the event is cancelled by the venue?\n- 返金は誰ができますか?\n- 締め切りはいつですか?",
    );
    const open = buildInterviewGuide({ depth: "quick", brief: parseBrief(text) }).filter((q) => q.topic === "open");
    expect(open).toHaveLength(4);
    expect(new Set(open.map((q) => q.id)).size).toBe(4);
  });

  it("sets aside questions whose source is gone, and brings them back if it returns", () => {
    const data = emptyInterview(buildInterviewGuide({ app: "Acme Events", depth: "standard", brief }));
    const openId = data.questions.find((q) => q.topic === "open")!.id;
    const resolved = parseBrief(briefText.replace("- Can a door staff member refund a payment? (asked; waiting)", "None."));
    expect(mergeGuide(data, buildInterviewGuide({ app: "Acme Events", depth: "standard", brief: resolved }), { maxPriority: 2 })).toEqual({ added: 0, retired: 1 });
    expect(data.questions.find((q) => q.id === openId)).toMatchObject({ status: "skipped" });
    expect(interviewStatus(data).essentialOpen).not.toContain(openId);
    mergeGuide(data, buildInterviewGuide({ app: "Acme Events", depth: "standard", brief }), { maxPriority: 2 });
    expect(data.questions.find((q) => q.id === openId)!.status).toBe("open");
    // Going back to quick doesn't throw away the standard questions, and follow-ups are kept.
    addFollowUp(data, { topic: "rules", ask: "Who signs off refunds?" });
    expect(mergeGuide(data, buildInterviewGuide({ app: "Acme Events", depth: "quick", brief }), { maxPriority: 1 }).retired).toBe(0);
    expect(data.questions.find((q) => q.id === "rules-limits")!.status).toBe("open");
  });

  it("never lets a follow-up take an id a deeper guide adds later", () => {
    const data = emptyInterview(buildInterviewGuide({ app: "Acme Events", depth: "quick", brief }));
    expect(addFollowUp(data, { topic: "rules", ask: "Limits?" }).id).toBe("fu-rules-limits");
    expect(mergeGuide(data, buildInterviewGuide({ app: "Acme Events", depth: "standard", brief })).added).toBeGreaterThan(0);
    expect(data.questions.find((q) => q.id === "rules-limits")).toMatchObject({ source: "guide", status: "open" });
  });

  it("keeps the agent connector's room per section for briefs without the optional sections", () => {
    const long = Array.from({ length: 120 }, (_, i) => `- **Thing ${i}**: belongs to an Event; details about it here.`).join("\n");
    const parsed = parseBrief(briefText.replace(/## Things it keeps track of\n\n[\s\S]*?\n\n## Words/, `## Things it keeps track of\n\n${long}\n\n## Words`));
    const things = briefOverview(parsed)!.split("## Things it keeps track of\n\n")[1].split("\n\n## ")[0];
    expect(long.length).toBeGreaterThan(5000);
    expect(things.length).toBeGreaterThan(4000);
    expect(things.length).toBeLessThanOrEqual(Math.floor(16_000 / 7) * 2 + 2);
  });

  it("treats None. in an optional section as empty, and wants bullets for problems", () => {
    const none = briefText.replace("## Open questions", "## Where people get stuck\n\nNone.\n\n## Open questions");
    expect(checkBrief(none).warnings.map((w) => w.message)).toContain('"Where people get stuck" is empty; fill it or remove the heading');
    expect(briefOverview(parseBrief(none))).not.toContain("Where people get stuck");
    const prose = briefText.replace("## Open questions", "## Where people get stuck\n\nPeople forget to mark cash paid.\n\n## Open questions");
    expect(checkBrief(prose).warnings.map((w) => w.message)).toContain('"Where people get stuck" needs one bullet per problem; the Common problems page lists bullets only');
  });

  it("refuses a --count that isn't a whole number of 1 or more", async () => {
    const file = path.join(dir, "interview.yaml");
    expect(await runInterviewStart({ file, depth: "quick", json: true })).toBe(0);
    for (const count of [0, Number.NaN, 1.5]) {
      expect(await runInterviewNext({ file, count, json: true })).toBe(1);
      expect(lastJson().error).toMatch(/--count must be a whole number/);
    }
  });

  it("keeps every answer when several are recorded at once, exactly as written", async () => {
    const cli = path.join(here, "..", "..", "src", "cli.ts");
    const file = path.join(dir, "interview.yaml");
    expect(await runInterviewStart({ file, depth: "quick", json: true })).toBe(0);
    const ids = ["rules-undo", "trouble-asked", "trouble-stuck", "workflow-main"];
    const run = (id: string) =>
      new Promise<number>((done) => {
        const child = spawn(process.execPath, ["--import", "tsx", cli, "interview", "answer", id, "--file", file, "--text-file", "-"], { stdio: ["pipe", "ignore", "pipe"] });
        child.stdin.end(`Costs $20 a month; "quotes" and \`ticks\` for ${id}.`);
        child.on("close", (code) => done(code ?? 1));
      });
    expect(await Promise.all(ids.map(run))).toEqual([0, 0, 0, 0]);
    const saved = parseInterview(readFileSync(file, "utf8"));
    for (const id of ids) expect(saved.questions.find((q) => q.id === id)!.answer).toBe(`Costs $20 a month; "quotes" and \`ticks\` for ${id}.`);
    expect(await runInterviewAnswer({ file, id: "rules-undo", text: "x", textFile: "-", json: true })).toBe(1);
    expect(await runInterviewAnswer({ file, id: "rules-undo", json: true })).toBe(1);
  }, 60_000);
});
