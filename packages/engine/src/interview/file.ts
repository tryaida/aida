// `app-interview.yaml` (decision 38): the questions the aida-interview skill asks the builder, their
// answers in the builder's own words, and which answers have been moved into the brief or the
// plan. It sits beside the brief, stays in the repo so a later interview never asks twice, and is
// never published.
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml, stringify } from "yaml";
import { scanEmails, scanPhones } from "../qa/pii.js";
import { withOutlineLock } from "../outline/file.js";
import { INTERVIEW_DEPTHS, INTERVIEW_TOPICS, TOPIC_TITLES, slug, type GuideQuestion, type InterviewDepth, type InterviewTopic, type QuestionPriority } from "./guide.js";

export const DEFAULT_INTERVIEW_FILE = "app-interview.yaml";

export const QUESTION_STATUSES = ["open", "answered", "skipped"] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export interface InterviewQuestion extends Omit<GuideQuestion, "source"> {
  source: GuideQuestion["source"] | "follow-up";
  status: QuestionStatus;
  /** The builder's answer, in their words (lightly condensed). */
  answer?: string;
  /** Why it was skipped ("doesn't apply", "ask the support team"). */
  reason?: string;
  /** YYYY-MM-DD the answer was recorded. */
  answeredOn?: string;
  /** The answer has been moved to where `goesTo` says. */
  applied?: boolean;
}

export interface InterviewFile {
  app?: string;
  depth: InterviewDepth;
  started: string;
  updated: string;
  questions: InterviewQuestion[];
}

export class InterviewError extends Error {}

/** `app-interview.yaml` beside the brief. */
export function interviewPath(briefFile: string): string {
  return join(dirname(briefFile), DEFAULT_INTERVIEW_FILE);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function dateString(v: unknown): string | undefined {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return typeof v === "string" ? v : undefined;
}

export function parseInterview(text: string, file = DEFAULT_INTERVIEW_FILE): InterviewFile {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (err) {
    throw new InterviewError(`${file}: not valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new InterviewError(`${file}: not a YAML mapping`);
  const raw = data as Record<string, unknown>;
  if (!Array.isArray(raw.questions)) throw new InterviewError(`${file}: \`questions\` must be a list`);
  const depth = (INTERVIEW_DEPTHS as readonly unknown[]).includes(raw.depth) ? (raw.depth as InterviewDepth) : "standard";
  const seen = new Set<string>();
  const questions = raw.questions.map((q, i) => {
    const at = `${file}: questions[${i}]`;
    if (!q || typeof q !== "object") throw new InterviewError(`${at} is not a mapping`);
    const r = q as Record<string, unknown>;
    for (const key of ["id", "ask"] as const) if (typeof r[key] !== "string" || !(r[key] as string).trim()) throw new InterviewError(`${at} needs \`${key}\``);
    const id = r.id as string;
    if (seen.has(id)) throw new InterviewError(`${at}: id "${id}" is used twice`);
    seen.add(id);
    if (!(INTERVIEW_TOPICS as readonly unknown[]).includes(r.topic)) throw new InterviewError(`${at}: topic must be one of ${INTERVIEW_TOPICS.join(", ")}`);
    const out: InterviewQuestion = {
      id,
      topic: r.topic as InterviewTopic,
      ask: (r.ask as string).trim(),
      why: typeof r.why === "string" ? r.why : "",
      goesTo: typeof r.goesTo === "string" && r.goesTo.trim() ? r.goesTo.trim() : "brief",
      priority: r.priority === 1 || r.priority === 2 || r.priority === 3 ? r.priority : 2,
      source: r.source === "brief" || r.source === "follow-up" ? r.source : "guide",
      status: (QUESTION_STATUSES as readonly unknown[]).includes(r.status) ? (r.status as QuestionStatus) : "open",
    };
    if (typeof r.about === "string" && r.about) out.about = r.about;
    if (r.known === true) out.known = true;
    if (typeof r.answer === "string" && r.answer.trim()) out.answer = r.answer.trim();
    if (typeof r.reason === "string" && r.reason.trim()) out.reason = r.reason.trim();
    const on = dateString(r.answeredOn);
    if (on) out.answeredOn = on;
    if (r.applied === true) out.applied = true;
    if (out.status === "answered" && !out.answer) throw new InterviewError(`${at}: "${id}" is answered but has no answer`);
    return out;
  });
  return {
    ...(typeof raw.app === "string" && raw.app ? { app: raw.app } : {}),
    depth,
    started: dateString(raw.started) ?? today(),
    updated: dateString(raw.updated) ?? today(),
    questions,
  };
}

export function readInterview(file: string): InterviewFile | undefined {
  if (!existsSync(file)) return undefined;
  return parseInterview(readFileSync(file, "utf8"), basename(file));
}

const HEADER =
  "# The builder interview (aida-interview skill): questions, answers in the builder's words, and which answers\n" +
  "# have been moved into app-brief.md or the plan. Kept in the repo so nothing is asked twice; never published.\n" +
  "# Change it with `aida interview answer|skip|ask|applied`, or by hand.\n";

export function formatInterview(data: InterviewFile): string {
  return HEADER + stringify(data, { lineWidth: 0 });
}

export function writeInterview(file: string, data: InterviewFile): void {
  const text = formatInterview(data);
  parseInterview(text, basename(file));
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (err) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw err;
  }
}

/** Why `mergeGuide` skipped a question: what it asked about is gone. Reopened if it comes back. */
export const RETIRED_REASON = "no longer applies: what it asked about is gone from the brief, config or outline";

/**
 * Adds the guide's questions that aren't in `data` yet (a new reader, a deeper depth, a new open
 * question in the brief) and refreshes `known` on questions still open. A guide or brief question
 * still open that the guide no longer asks at this depth (an open question answered in the brief,
 * a reader or card removed) is skipped as retired, and reopened if it comes back. Answers and
 * follow-ups are never touched. Returns how many were added.
 */
export function mergeGuide(data: InterviewFile, guide: GuideQuestion[], opts: { maxPriority?: QuestionPriority } = {}): { added: number; retired: number } {
  const byId = new Map(data.questions.map((q) => [q.id, q]));
  const wanted = new Set(guide.map((g) => g.id));
  let added = 0;
  let retired = 0;
  for (const g of guide) {
    const existing = byId.get(g.id);
    if (!existing) {
      data.questions.push({ ...g, status: "open" });
      added++;
      continue;
    }
    if (existing.status === "skipped" && existing.reason === RETIRED_REASON) {
      existing.status = "open";
      delete existing.reason;
    }
    if (existing.status === "open") {
      if (g.known) existing.known = true;
      else delete existing.known;
    }
  }
  if (opts.maxPriority !== undefined) {
    for (const q of data.questions) {
      if (q.status !== "open" || q.source === "follow-up" || wanted.has(q.id) || q.priority > opts.maxPriority) continue;
      q.status = "skipped";
      q.reason = RETIRED_REASON;
      delete q.known;
      retired++;
    }
  }
  return { added, retired };
}

/** Runs a read-modify-write of the interview file under a lock, so answers recorded at the same
 * time never overwrite each other. */
export function withInterviewLock<T>(file: string, fn: () => T): T {
  return withOutlineLock(file, fn);
}

/** Open questions in asking order: the essentials across every topic first (so stopping early
 * still leaves a useful brief), then the detail, topic by topic. Follow-ups sit with their topic. */
export function nextQuestions(data: InterviewFile, opts: { count?: number; topic?: InterviewTopic } = {}): InterviewQuestion[] {
  const order = new Map(INTERVIEW_TOPICS.map((t, i) => [t, i]));
  return data.questions
    .map((q, index) => ({ q, index }))
    .filter(({ q }) => q.status === "open" && (!opts.topic || q.topic === opts.topic))
    .sort((a, b) => a.q.priority - b.q.priority || order.get(a.q.topic)! - order.get(b.q.topic)! || a.index - b.index)
    .slice(0, opts.count ?? 3)
    .map(({ q }) => q);
}

export function findQuestion(data: InterviewFile, id: string): InterviewQuestion {
  const q = data.questions.find((x) => x.id === id);
  if (!q) throw new InterviewError(`no question "${id}" (aida interview next lists the open ones)`);
  return q;
}

/** Records an answer; `append` adds to an earlier one (the builder came back to it). A changed
 * answer has to be moved into the brief again. */
export function answerQuestion(data: InterviewFile, id: string, answer: string, opts: { append?: boolean } = {}): InterviewQuestion {
  const q = findQuestion(data, id);
  const text = answer.trim();
  if (!text) throw new InterviewError("the answer is empty; use aida interview skip for a question with no answer");
  q.answer = opts.append && q.status === "answered" && q.answer ? `${q.answer}\n\n${text}` : text;
  q.status = "answered";
  q.answeredOn = today();
  delete q.reason;
  delete q.applied;
  return q;
}

export function skipQuestion(data: InterviewFile, id: string, reason?: string): InterviewQuestion {
  const q = findQuestion(data, id);
  if (q.status === "answered") throw new InterviewError(`"${id}" is already answered`);
  q.status = "skipped";
  if (reason?.trim()) q.reason = reason.trim();
  else delete q.reason;
  return q;
}

/** A follow-up the interviewer asks after an answer. Its id comes from its topic and text; with
 * `after`, it takes that question's reader, destination and priority unless given. */
export function addFollowUp(
  data: InterviewFile,
  opts: { topic: InterviewTopic; ask: string; about?: string; goesTo?: string; why?: string; priority?: QuestionPriority; after?: string },
): InterviewQuestion {
  const ask = opts.ask.trim();
  if (!ask) throw new InterviewError("the question is empty");
  const parent = opts.after ? findQuestion(data, opts.after) : undefined;
  // `fu-`: a follow-up can never take an id a deeper guide adds later.
  const base = `fu-${opts.topic}-${slug(ask).split("-").slice(0, 5).join("-") || "more"}`;
  let id = base;
  for (let n = 2; data.questions.some((q) => q.id === id); n++) id = `${base}-${n}`;
  const q: InterviewQuestion = {
    id,
    topic: opts.topic,
    ask,
    why: opts.why?.trim() || "A follow-up to an earlier answer.",
    goesTo: opts.goesTo?.trim() || parent?.goesTo || "brief",
    priority: opts.priority ?? parent?.priority ?? 1,
    source: "follow-up",
    status: "open",
  };
  const about = opts.about ?? parent?.about;
  if (about) q.about = about;
  data.questions.push(q);
  return q;
}

export function markApplied(data: InterviewFile, ids: string[]): InterviewQuestion[] {
  const found = ids.map((id) => findQuestion(data, id));
  const notAnswered = found.filter((q) => q.status !== "answered");
  if (notAnswered.length > 0) throw new InterviewError(`not answered yet: ${notAnswered.map((q) => q.id).join(", ")}`);
  for (const q of found) q.applied = true;
  return found;
}

export interface TopicStatus {
  topic: InterviewTopic;
  title: string;
  answered: number;
  skipped: number;
  open: number;
}

export interface InterviewStatus {
  depth: InterviewDepth;
  topics: TopicStatus[];
  answered: number;
  skipped: number;
  open: number;
  /** Open questions at the essential priority. */
  essentialOpen: string[];
  /** Answered, not yet moved into the brief. */
  unappliedBrief: string[];
  /** Answered, for the planner; moved when the outline is made. */
  unappliedPlan: string[];
  /** Real-looking emails or phone numbers in answers: they must not reach the brief. */
  personalData: { id: string; problem: string }[];
  /** Every essential question answered or skipped, and every brief answer moved. */
  ready: boolean;
}

export function interviewStatus(data: InterviewFile): InterviewStatus {
  const topics: TopicStatus[] = [];
  for (const topic of INTERVIEW_TOPICS) {
    const qs = data.questions.filter((q) => q.topic === topic);
    if (qs.length === 0) continue;
    topics.push({
      topic,
      title: TOPIC_TITLES[topic],
      answered: qs.filter((q) => q.status === "answered").length,
      skipped: qs.filter((q) => q.status === "skipped").length,
      open: qs.filter((q) => q.status === "open").length,
    });
  }
  const answered = data.questions.filter((q) => q.status === "answered");
  const unapplied = answered.filter((q) => !q.applied);
  const essentialOpen = data.questions.filter((q) => q.status === "open" && q.priority === 1).map((q) => q.id);
  const unappliedBrief = unapplied.filter((q) => q.goesTo !== "plan").map((q) => q.id);
  const personalData: { id: string; problem: string }[] = [];
  for (const q of answered) for (const problem of [...scanEmails(q.answer ?? ""), ...scanPhones(q.answer ?? "")]) personalData.push({ id: q.id, problem });
  return {
    depth: data.depth,
    topics,
    answered: answered.length,
    skipped: data.questions.filter((q) => q.status === "skipped").length,
    open: data.questions.filter((q) => q.status === "open").length,
    essentialOpen,
    unappliedBrief,
    unappliedPlan: unapplied.filter((q) => q.goesTo === "plan").map((q) => q.id),
    personalData,
    ready: essentialOpen.length === 0 && unappliedBrief.length === 0,
  };
}

const GROUP_TITLES: Record<string, string> = {
  readers: "Readers (frontmatter profile and Who uses it)",
  plan: "For the planner (not published)",
  brief: "Wherever it fits in the brief",
};

/** Answered questions as compact notes for whoever moves them into the brief or the plan,
 * grouped by where each answer goes. */
export function interviewNotes(data: InterviewFile, opts: { topic?: InterviewTopic; goesTo?: string; unapplied?: boolean } = {}): string {
  const want = opts.goesTo?.toLowerCase();
  const picked = data.questions.filter(
    (q) =>
      q.status === "answered" &&
      (!opts.topic || q.topic === opts.topic) &&
      (!want || q.goesTo.toLowerCase() === want || q.goesTo.toLowerCase().startsWith(`${want}.`)) &&
      (!opts.unapplied || !q.applied),
  );
  if (picked.length === 0) return "No answers yet.";
  const groups = new Map<string, InterviewQuestion[]>();
  for (const q of picked) {
    const key = q.goesTo.startsWith("readers.") ? "readers" : q.goesTo;
    groups.set(key, [...(groups.get(key) ?? []), q]);
  }
  const parts: string[] = [];
  for (const [goesTo, qs] of groups) {
    const lines = [`## ${GROUP_TITLES[goesTo] ?? goesTo}`, ""];
    for (const q of qs) {
      const tags = [q.about, q.goesTo.startsWith("readers.") ? q.goesTo : undefined, q.applied ? "applied" : undefined].filter(Boolean);
      lines.push(`- [${q.id}]${tags.length > 0 ? ` (${tags.join("; ")})` : ""} Q: ${q.ask}`);
      lines.push(`  A: ${(q.answer ?? "").replace(/\s*\n+\s*/g, " ")}`);
    }
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}
