// The interview guide (decision 38): the questions `aida interview start` writes for the
// aida-interview skill to ask the builder, built the same way every time from what's already known
// — the brief's readers and open questions, the domain model's things and their states, and the
// outline's cards. The skill does the talking; this decides what's worth asking and why.
import { createHash } from "node:crypto";
import { linkCount, rankEntities, type DomainModel } from "../domain/index.js";
import { keyColumns } from "../domain/format.js";
import { briefReaders, findSection, normalizeHeading, sectionText, type ParsedBrief } from "../brief/index.js";

/** Topics in the order an interview moves through them. */
export const INTERVIEW_TOPICS = ["purpose", "readers", "workflows", "open", "things", "rules", "trouble", "words", "rhythm", "scope", "tasks"] as const;
export type InterviewTopic = (typeof INTERVIEW_TOPICS)[number];

export const TOPIC_TITLES: Record<InterviewTopic, string> = {
  purpose: "What it's for",
  readers: "Who uses it",
  workflows: "Whole jobs, start to finish",
  open: "Open questions from the brief",
  things: "Things it keeps track of",
  rules: "Rules that matter",
  trouble: "Where people get stuck",
  words: "Words and tone",
  rhythm: "Rhythm",
  scope: "What to cover",
  tasks: "Single tasks",
};

/** quick: the essentials (about 10 minutes); standard: adds the detail most help needs (about
 * 25); deep: everything, the domain model's things and the outline's tasks too (45 or more). */
export const INTERVIEW_DEPTHS = ["quick", "standard", "deep"] as const;
export type InterviewDepth = (typeof INTERVIEW_DEPTHS)[number];

export type QuestionPriority = 1 | 2 | 3;

/**
 * Where an answer goes once it's been given: a brief section by name, `readers.<field>` (the
 * reader's frontmatter profile and their "Who uses it" paragraph), `brief` (whichever section
 * fits, for the brief's own open questions) or `plan` (a note the planner reads, never published).
 */
export type GoesTo = string;

export interface GuideQuestion {
  /** Stable across `start` reruns, so answers are never asked twice. */
  id: string;
  topic: InterviewTopic;
  /** The reader role, entity or card the question is about. */
  about?: string;
  ask: string;
  /** What the answer changes in the help, so the person knows why it's asked. */
  why: string;
  goesTo: GoesTo;
  priority: QuestionPriority;
  source: "guide" | "brief";
  /** The brief already says something here: confirm it rather than asking cold. */
  known?: boolean;
}

export interface GuideInput {
  app?: string;
  depth: InterviewDepth;
  brief?: ParsedBrief;
  /** Readers when the brief has none yet: the config's roles. */
  roles?: { role: string; name: string }[];
  domain?: DomainModel;
  cards?: { id: string; title: string; for?: string; status?: string }[];
}

const LIMITS: Record<InterviewDepth, { priority: QuestionPriority; readers: number; things: number; tasks: number }> = {
  quick: { priority: 1, readers: 2, things: 0, tasks: 0 },
  standard: { priority: 2, readers: 6, things: 3, tasks: 0 },
  deep: { priority: 3, readers: 8, things: 6, tasks: 8 },
};

/** The highest priority asked at `depth`. */
export function depthPriority(depth: InterviewDepth): QuestionPriority {
  return LIMITS[depth].priority;
}

/** `open-<first words>-<hash>`: readable, and two questions that start alike (or are written in
 * a script `slug` drops) never share an id. */
export function openQuestionId(question: string): string {
  const words = slug(question).split("-").slice(0, 6).join("-");
  const hash = createHash("sha1").update(question.trim()).digest("hex").slice(0, 6);
  return `open-${words ? `${words}-` : ""}${hash}`;
}

export function buildInterviewGuide(input: GuideInput): GuideQuestion[] {
  const limits = LIMITS[input.depth];
  const app = input.app?.trim() || "the app";
  const out: GuideQuestion[] = [];
  const add = (q: Omit<GuideQuestion, "source" | "known"> & { source?: GuideQuestion["source"] }) => {
    if (q.priority > limits.priority) return;
    if (out.some((o) => o.id === q.id)) return;
    out.push({ ...q, source: q.source ?? "guide", ...(isKnown(input.brief, q.goesTo, q.about) ? { known: true } : {}) });
  };

  add({ id: "purpose-what", topic: "purpose", priority: 1, goesTo: "What it's for", ask: `In a sentence or two, what does ${app} do, and who is it for?`, why: "The help site's home page opens with this." });
  add({ id: "purpose-before", topic: "purpose", priority: 1, goesTo: "What it's for", ask: `What did people do before ${app}: a spreadsheet, paper, another tool, nothing? What was painful about it?`, why: "Pages can explain things in terms readers already know." });
  add({ id: "purpose-first-week", topic: "purpose", priority: 2, goesTo: "Workflows", ask: `What does a good first week look like for someone new to ${app}? What should they have done by then?`, why: "Sets what the Getting started section must cover." });
  add({ id: "purpose-not", topic: "purpose", priority: 3, goesTo: "Where people get stuck", ask: `What do people sometimes expect ${app} to do that it doesn't?`, why: "Heads off questions the help chat can't answer from the screens." });

  for (const r of readersOf(input).slice(0, limits.readers)) {
    const who = readerPhrase(r.name);
    const role = slug(r.role) || slug(r.name);
    add({ id: `reader-${role}-who`, topic: "readers", about: r.role, priority: 1, goesTo: "readers.comfort", ask: `Tell me about ${who}: who are they, what are they trying to get done, and how at home are they with apps like this one? Describe a typical one, then the least confident one.`, why: "Sets how much each page explains." });
    add({ id: `reader-${role}-where`, topic: "readers", about: r.role, priority: 1, goesTo: "readers.devices", ask: `Picture ${who} opening ${app}: where are they, and what are they using: a phone, a tablet, a computer? What else is going on around them?`, why: "Phone-first readers get phone-sized screenshots and videos; rushed readers get shorter steps." });
    add({ id: `reader-${role}-often`, topic: "readers", about: r.role, priority: 2, goesTo: "readers.frequency", ask: `Think of ${who}: how often do they use it, and what's different the first time compared with the tenth?`, why: "Separates first-time guides from quick reminders." });
    add({ id: `reader-${role}-worry`, topic: "readers", about: r.role, priority: 2, goesTo: "Rules that matter", ask: `What worries ${who} most about getting something wrong?`, why: "Those become warnings at the step where it can happen." });
    add({ id: `reader-${role}-needs`, topic: "readers", about: r.role, priority: 2, goesTo: "Who uses it", ask: `Is there anything that makes reading or using it harder for ${who}: English as a second language, reading level, eyesight, a screen reader, slow internet?`, why: "Sets sentence length, captions, and how much rests on screenshots." });
    add({ id: `reader-${role}-words`, topic: "readers", about: r.role, priority: 3, goesTo: "Words it uses", ask: `Which of ${app}'s words would ${who} put differently, and what would they say instead?`, why: "Fills the glossary's \"not to be confused with\" column, and the help chat understands their words." });
    add({ id: `reader-${role}-limits`, topic: "readers", about: r.role, priority: 3, goesTo: "Who uses it", ask: `What can't ${who} see or change, and do they know that?`, why: "Stops pages promising a button this reader doesn't have." });
  }

  add({ id: "workflow-main", topic: "workflows", priority: 1, goesTo: "Workflows", ask: `Walk me through the most important job people do with ${app}, start to finish, including anything that happens outside it: emails, payments, phone calls, paperwork.`, why: "Orders the walkthroughs the way the job runs, and says what comes next on each page." });
  add({ id: "workflow-first", topic: "workflows", priority: 1, goesTo: "Workflows", ask: `What does someone brand new have to set up, and in what order, before ${app} is useful to them?`, why: "Decides the first walkthroughs a new reader sees." });
  add({ id: "workflow-handoff", topic: "workflows", priority: 2, goesTo: "Workflows", ask: "Which jobs pass from one person to another? How does the next person find out it's their turn?", why: "Pages say who acts next and what they'll see." });
  add({ id: "workflow-shortcuts", topic: "workflows", priority: 3, goesTo: "Several ways to do one thing", ask: "How do your most experienced people do things differently: shortcuts, bulk actions, a different order?", why: "Other ways to do a task, for readers who want the quick route." });

  for (const q of openQuestions(input.brief)) {
    add({ id: openQuestionId(q), topic: "open", priority: 1, goesTo: "brief", ask: q, why: "The brief couldn't work this out from the repo.", source: "brief" });
  }

  if (input.domain && limits.things > 0) {
    const model = input.domain;
    const stateOf = (e: (typeof model.entities)[number]) => keyColumns(model, e).find((c) => c.enum && (model.enums[c.enum]?.length ?? 0) > 1);
    const ranked = rankEntities(model.entities).filter((e) => linkCount(e) > 0);
    const withStates = ranked.filter((e) => stateOf(e));
    const rest = ranked.filter((e) => !stateOf(e));
    for (const e of [...withStates, ...rest].slice(0, limits.things)) {
      const state = stateOf(e);
      const values = state ? (model.enums[state.enum!] ?? []).slice(0, 6) : [];
      const label = e.label.toLowerCase();
      if (values.length > 1) {
        add({ id: `thing-${slug(e.name)}-states`, topic: "things", about: e.name, priority: 2, goesTo: "Things it keeps track of", ask: `${capitalize(withArticle(label))} can be ${joinOr(values)}. What moves one from one to the next, who does it, and can it go back?`, why: "Pages say what happens next, and the help chat can explain a status." });
      } else {
        add({ id: `thing-${slug(e.name)}-means`, topic: "things", about: e.name, priority: 3, goesTo: "Things it keeps track of", ask: `What is ${withArticle(label)} to the people who use ${app}, and what do they call it?`, why: "The words pages use for it." });
      }
    }
  }

  add({ id: "rules-undo", topic: "rules", priority: 1, goesTo: "Rules that matter", ask: "What can't be undone, or is costly to get wrong: money, messages sent to people, deletions, anything made public?", why: "Each becomes a warning on the step before it happens." });
  add({ id: "rules-limits", topic: "rules", priority: 2, goesTo: "Rules that matter", ask: "Are there deadlines, limits, approvals or legal rules readers have to know about?", why: "Pages mention them where they bite." });

  add({ id: "trouble-asked", topic: "trouble", priority: 1, goesTo: "Where people get stuck", ask: "What do people ask you for help with most often?", why: "The help chat answers these first, and Common problems lists them." });
  add({ id: "trouble-stuck", topic: "trouble", priority: 1, goesTo: "Where people get stuck", ask: "Where do people get stuck or make mistakes, and how do they put it right?", why: "Tips and warnings at the step where it happens." });
  add({ id: "trouble-unsupported", topic: "trouble", priority: 2, goesTo: "Where people get stuck", ask: `Is there anything people try to do that ${app} doesn't support? What should they do instead?`, why: "The help chat can say so plainly instead of guessing." });

  add({ id: "words-confusing", topic: "words", priority: 2, goesTo: "Words it uses", ask: "Which words on screen confuse people, or mean something different in your field?", why: "The glossary, and the words pages avoid." });
  add({ id: "words-tone", topic: "words", priority: 3, goesTo: "Who uses it", ask: "How should the help sound: friendly or formal? Is there anything it should never say?", why: "Sets the tone of narration and pages." });

  add({ id: "rhythm-cycle", topic: "rhythm", priority: 2, goesTo: "Rhythm", ask: "Is there a busy time: a season, a weekly cycle, an end-of-month rush? What happens first, in the rush, and at the end?", why: "Orders the guides the way the year runs." });
  add({ id: "rhythm-help-time", topic: "rhythm", priority: 3, goesTo: "Who uses it", ask: "When do people usually go looking for help, and how much time do they have when they do?", why: "Short answers first for people in a hurry; videos for those with time." });

  add({ id: "scope-leave-out", topic: "scope", priority: 2, goesTo: "plan", ask: "Is there anything the help should leave out: admin-only screens, features being removed, things still in testing?", why: "The planner leaves these out of the outline." });
  add({ id: "scope-top-three", topic: "scope", priority: 3, goesTo: "plan", ask: "If the help could only cover three tasks really well, which would they be?", why: "The planner puts these first." });

  for (const c of (input.cards ?? []).filter((c) => c.status !== "dropped").slice(0, limits.tasks)) {
    const who = c.for ? readerPhrase(c.for) : "someone";
    add({ id: `task-${c.id}-when`, topic: "tasks", about: c.id, priority: 3, goesTo: "Workflows", ask: `"${c.title}": when and why would ${who} do this? What comes just before it, and just after?`, why: "The page's opening line and its next steps." });
  }

  return out;
}

function readersOf(input: GuideInput): { role: string; name: string }[] {
  const fromBrief = input.brief ? briefReaders(input.brief).filter((r) => r.role.trim() || r.name.trim()) : [];
  return fromBrief.length > 0 ? fromBrief : (input.roles ?? []).filter((r) => r.role.trim() || r.name.trim());
}

/** The brief's open questions, one per bullet (or line), "None" ignored. */
export function openQuestions(brief: ParsedBrief | undefined): string[] {
  if (!brief) return [];
  const section = brief.sections.find((s) => normalizeHeading(s.name) === normalizeHeading("Open questions"));
  const text = sectionText(section);
  if (!text || /^none( found)?\.?$/i.test(text)) return [];
  const lines = text.split("\n").map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim());
  return [...new Set(lines.filter((l) => l && !/^none( found)?\.?$/i.test(l)))];
}

/** True when the brief already has something where the answer goes. */
function isKnown(brief: ParsedBrief | undefined, goesTo: GoesTo, about: string | undefined): boolean {
  if (!brief) return false;
  if (goesTo.startsWith("readers.")) {
    const field = goesTo.slice("readers.".length) as "comfort" | "devices" | "frequency" | "context";
    const reader = briefReaders(brief).find((r) => r.role === about);
    return Boolean(reader && reader[field] !== undefined);
  }
  if (goesTo === "plan" || goesTo === "brief") return false;
  const section = findSection(brief, goesTo);
  if (!section || normalizeHeading(section.name) !== normalizeHeading(goesTo)) return false;
  // A glossary with only its header row says nothing yet.
  return sectionText(section)
    .split("\n")
    .some((l) => l.trim() && !/^\|[\s|:-]*\|?$/.test(l.trim()) && !/^\|\s*term\s*\|/i.test(l.trim()));
}

/** "an organiser" stays; "Organiser" becomes "an organiser", "Door staff" "door staff" and
 * "Event organisers" "event organisers". Questions say "they" after it, so either reads. */
export function readerPhrase(name: string): string {
  const n = name.trim();
  if (/^(a|an|the|your)\s/i.test(n)) return n;
  const lower = n.charAt(0).toLowerCase() + n.slice(1);
  if (/(?<!s)s$|\b(staff|people|team|crew)$/i.test(lower)) return lower;
  return withArticle(lower);
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function withArticle(word: string): string {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function joinOr(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
}
