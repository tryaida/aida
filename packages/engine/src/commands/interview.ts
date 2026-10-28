// `aida interview` (decision 38): the builder interview the aida-interview skill runs before
// planning. `start` writes or refreshes `app-interview.yaml` beside the brief with the questions
// worth asking; `next`, `answer`, `skip` and `ask` move the conversation along; `notes` hands the
// answers to whoever writes them into the brief; `applied` and `status` track what's been moved.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ResolvedConfig } from "../config/index.js";
import { briefPath, loadBrief, type ParsedBrief } from "../brief/index.js";
import {
  INTERVIEW_DEPTHS,
  INTERVIEW_TOPICS,
  InterviewError,
  addFollowUp,
  answerQuestion,
  buildInterviewGuide,
  depthPriority,
  interviewNotes,
  interviewPath,
  interviewStatus,
  markApplied,
  mergeGuide,
  nextQuestions,
  readInterview,
  skipQuestion,
  today,
  withInterviewLock,
  writeInterview,
  type InterviewDepth,
  type InterviewFile,
  type InterviewQuestion,
  type InterviewTopic,
  type QuestionPriority,
} from "../interview/index.js";
import { OutlineError, outlinePath, readOutline } from "../outline/index.js";
import { buildAppDomain, fail, loadOptionalConfig, resolveAppRepo } from "./domain.js";

interface InterviewOptions {
  configPath?: string;
  /** Explicit interview file; default `app-interview.yaml` beside the brief. */
  file?: string;
  json: boolean;
}

interface Loaded {
  config?: ResolvedConfig;
  file: string;
  brief?: ParsedBrief;
}

async function setup(command: string, opts: InterviewOptions): Promise<{ loaded?: Loaded; code?: number }> {
  const { config, code } = await loadOptionalConfig(opts.configPath, command, opts.json);
  if (code) return { code };
  if (!opts.file && !config) return { code: fail(command, "pass --config (the interview sits beside the brief) or --file <path>", opts.json) };
  const brief = config ? loadBrief(briefPath(config)) : undefined;
  const file = opts.file ? resolve(opts.file) : interviewPath(briefPath(config!));
  return { loaded: { config, file, brief } };
}

async function read(command: string, opts: InterviewOptions): Promise<{ data?: InterviewFile; file?: string; code?: number }> {
  const { loaded, code } = await setup(command, opts);
  if (!loaded) return { code: code ?? 1 };
  try {
    const data = readInterview(loaded.file);
    if (!data) return { code: fail(command, `no interview at ${loaded.file} (aida interview start writes one)`, opts.json, { path: loaded.file }) };
    return { data, file: loaded.file };
  } catch (err) {
    if (err instanceof InterviewError) return { code: fail(command, err.message, opts.json) };
    throw err;
  }
}

/** Reads the interview file, runs `fn` on it and writes it back, under a lock so two commands at
 * once never lose an answer; errors become a failed command. */
async function change(command: string, opts: InterviewOptions, fn: (data: InterviewFile) => unknown): Promise<number> {
  const { loaded, code } = await setup(command, opts);
  if (!loaded) return code ?? 1;
  const { file } = loaded;
  if (!existsSync(file)) return fail(command, `no interview at ${file} (aida interview start writes one)`, opts.json, { path: file });
  try {
    const result = withInterviewLock(file, () => {
      const data = readInterview(file);
      if (!data) throw new InterviewError(`no interview at ${file} (aida interview start writes one)`);
      const out = fn(data);
      data.updated = today();
      writeInterview(file, data);
      return out;
    });
    if (opts.json) console.log(JSON.stringify({ ok: true, path: file, result }));
    return 0;
  } catch (err) {
    if (err instanceof InterviewError || err instanceof OutlineError) return fail(command, err.message, opts.json);
    throw err;
  }
}

/** The outline's cards when there is one; a broken outline only means no task questions. */
function readOutlineQuietly(file: string): ReturnType<typeof readOutline> {
  try {
    return readOutline(file);
  } catch {
    return null;
  }
}

export async function runInterviewStart(opts: InterviewOptions & { depth?: string; repo?: string }): Promise<number> {
  if (opts.depth && !(INTERVIEW_DEPTHS as readonly string[]).includes(opts.depth)) {
    return fail("interview start", `--depth must be one of ${INTERVIEW_DEPTHS.join(", ")}`, opts.json);
  }
  const { loaded, code } = await setup("interview start", opts);
  if (!loaded) return code ?? 1;
  const { config, file, brief } = loaded;
  try {
    mkdirSync(dirname(file), { recursive: true });
    return withInterviewLock(file, () => startLocked(opts, config, file, brief));
  } catch (err) {
    if (err instanceof InterviewError || err instanceof OutlineError) return fail("interview start", err.message, opts.json);
    throw err;
  }
}

function startLocked(opts: InterviewOptions & { depth?: string; repo?: string }, config: ResolvedConfig | undefined, file: string, brief: ParsedBrief | undefined): number {
  const existing = readInterview(file);
  const depth = (opts.depth as InterviewDepth | undefined) ?? existing?.depth ?? "standard";
  const repo = config || opts.repo ? resolveAppRepo(opts.repo, config) : undefined;
  const domain = repo && existsSync(repo) ? buildAppDomain(repo, {}, !opts.repo) : undefined;
  const roles = config?.roles
    ? Object.entries(config.roles).map(([role, v]) => ({ role, name: typeof v === "string" ? v : v.name }))
    : (config?.readers ?? []).map((r) => ({ role: r, name: r.replace(/[-_]/g, " ") }));
  const outline = config ? readOutlineQuietly(outlinePath(config)) : null;
  const briefApp = typeof brief?.frontmatter?.app === "string" ? brief.frontmatter.app.trim() : "";
  const app = briefApp || config?.chat?.appName || config?.brand?.name || existing?.app;
  const guide = buildInterviewGuide({ app, depth, brief, roles, domain: domain?.ok ? domain.model : undefined, cards: outline?.outline.cards });
  const data: InterviewFile = existing ?? { ...(app ? { app } : {}), depth, started: today(), updated: today(), questions: [] };
  data.depth = depth;
  if (app && !data.app) data.app = app;
  const { added, retired } = mergeGuide(data, guide, { maxPriority: depthPriority(depth) });
  data.updated = today();
  writeInterview(file, data);
  const status = interviewStatus(data);
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, path: file, created: !existing, added, retired, depth, brief: Boolean(brief), domain: Boolean(domain?.ok), status }));
  } else {
    const what = existing
      ? `refreshed ${file}: ${added} new question(s)${retired > 0 ? `, ${retired} no longer asked` : ""}`
      : `wrote ${file}: ${data.questions.length} questions`;
    console.log(`${what} (${depth}; ${status.open} open, ${status.answered} answered${brief ? "" : "; no brief yet, so nothing is marked known"})`);
    console.log("next: aida interview next --config <cfg>");
  }
  return 0;
}

function formatQuestion(q: InterviewQuestion): string {
  const tags = [
    q.topic,
    q.about,
    q.priority === 1 ? "essential" : undefined,
    q.known ? "the brief already says something: confirm it" : undefined,
    q.source === "brief" ? "from the brief's open questions" : undefined,
  ].filter(Boolean);
  return `[${q.id}] (${tags.join("; ")})\n  ${q.ask}\n  why: ${q.why}\n  goes to: ${q.goesTo}`;
}

export async function runInterviewNext(opts: InterviewOptions & { count?: number; topic?: string }): Promise<number> {
  if (opts.topic && !(INTERVIEW_TOPICS as readonly string[]).includes(opts.topic)) {
    return fail("interview next", `--topic must be one of ${INTERVIEW_TOPICS.join(", ")}`, opts.json);
  }
  if (opts.count !== undefined && (!Number.isInteger(opts.count) || opts.count < 1)) return fail("interview next", "--count must be a whole number, 1 or more", opts.json);
  const { data, code } = await read("interview next", opts);
  if (!data) return code ?? 1;
  const questions = nextQuestions(data, { count: opts.count, topic: opts.topic as InterviewTopic | undefined });
  const status = interviewStatus(data);
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, questions, open: status.open, essentialOpen: status.essentialOpen.length }));
  } else if (questions.length === 0) {
    console.log(opts.topic ? `no open questions on ${opts.topic}` : "no open questions left; move the answers into the brief (aida interview notes --unapplied)");
  } else {
    console.log(`${status.open} open (${status.essentialOpen.length} essential). Next:\n`);
    console.log(questions.map(formatQuestion).join("\n\n"));
  }
  return 0;
}

/** `--text`, or `--text-file <path>` (`-` reads stdin): an answer with `$`, quotes or backticks
 * survives a shell only through a file or a quoted heredoc. */
function answerText(opts: { text?: string; textFile?: string }): string {
  if (opts.text !== undefined && opts.textFile !== undefined) throw new InterviewError("pass --text or --text-file, not both");
  if (opts.textFile !== undefined) {
    try {
      return readFileSync(opts.textFile === "-" ? 0 : resolve(opts.textFile), "utf8");
    } catch (err) {
      throw new InterviewError(`can't read --text-file: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  if (opts.text === undefined) throw new InterviewError("pass the answer with --text, or --text-file - and a quoted heredoc");
  return opts.text;
}

export async function runInterviewAnswer(opts: InterviewOptions & { id: string; text?: string; textFile?: string; append?: boolean }): Promise<number> {
  let text: string;
  try {
    text = answerText(opts);
  } catch (err) {
    return fail("interview answer", (err as Error).message, opts.json);
  }
  return change("interview answer", opts, (data) => {
    const q = answerQuestion(data, opts.id, text, { append: opts.append });
    if (!opts.json) console.log(`answered ${q.id} (goes to ${q.goesTo})`);
    return { id: q.id, goesTo: q.goesTo };
  });
}

export async function runInterviewSkip(opts: InterviewOptions & { id: string; reason?: string }): Promise<number> {
  return change("interview skip", opts, (data) => {
    const q = skipQuestion(data, opts.id, opts.reason);
    if (!opts.json) console.log(`skipped ${q.id}`);
    return { id: q.id };
  });
}

export async function runInterviewAsk(
  opts: InterviewOptions & { topic: string; text: string; about?: string; goesTo?: string; why?: string; priority?: number; after?: string },
): Promise<number> {
  if (!(INTERVIEW_TOPICS as readonly string[]).includes(opts.topic)) return fail("interview ask", `--topic must be one of ${INTERVIEW_TOPICS.join(", ")}`, opts.json);
  if (opts.priority !== undefined && ![1, 2, 3].includes(opts.priority)) return fail("interview ask", "--priority must be 1, 2 or 3", opts.json);
  return change("interview ask", opts, (data) => {
    const q = addFollowUp(data, {
      topic: opts.topic as InterviewTopic,
      ask: opts.text,
      about: opts.about,
      goesTo: opts.goesTo,
      why: opts.why,
      priority: opts.priority as QuestionPriority | undefined,
      after: opts.after,
    });
    if (!opts.json) console.log(`added ${q.id}`);
    return { id: q.id };
  });
}

export async function runInterviewApplied(opts: InterviewOptions & { ids: string[]; all?: boolean }): Promise<number> {
  return change("interview applied", opts, (data) => {
    const ids = opts.all ? data.questions.filter((q) => q.status === "answered" && !q.applied && q.goesTo !== "plan").map((q) => q.id) : opts.ids;
    if (ids.length === 0 && !opts.all) throw new InterviewError("name the questions whose answers are now in the brief, or pass --all");
    const marked = markApplied(data, ids);
    if (!opts.json) console.log(`marked ${marked.length} answer(s) applied`);
    return { ids: marked.map((q) => q.id) };
  });
}

export async function runInterviewStatus(opts: InterviewOptions): Promise<number> {
  const { data, file, code } = await read("interview status", opts);
  if (!data) return code ?? 1;
  const status = interviewStatus(data);
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, path: file, ...status }));
    return 0;
  }
  console.log(`${status.ready ? "ready" : "in progress"}: ${file} (${status.depth}) — ${status.answered} answered, ${status.skipped} skipped, ${status.open} open`);
  for (const t of status.topics) console.log(`  ${t.title}: ${t.answered} answered, ${t.skipped} skipped, ${t.open} open`);
  if (status.essentialOpen.length > 0) console.log(`  essential still open: ${status.essentialOpen.join(", ")}`);
  if (status.unappliedBrief.length > 0) console.log(`  answered, not yet in the brief: ${status.unappliedBrief.join(", ")}`);
  if (status.unappliedPlan.length > 0) console.log(`  for the planner: ${status.unappliedPlan.join(", ")}`);
  for (const p of status.personalData) console.log(`  warning: [${p.id}] ${p.problem}; keep it out of the brief`);
  return 0;
}

export async function runInterviewNotes(opts: InterviewOptions & { topic?: string; goesTo?: string; unapplied?: boolean }): Promise<number> {
  if (opts.topic && !(INTERVIEW_TOPICS as readonly string[]).includes(opts.topic)) {
    return fail("interview notes", `--topic must be one of ${INTERVIEW_TOPICS.join(", ")}`, opts.json);
  }
  const { data, code } = await read("interview notes", opts);
  if (!data) return code ?? 1;
  const notes = interviewNotes(data, { topic: opts.topic as InterviewTopic | undefined, goesTo: opts.goesTo, unapplied: opts.unapplied });
  if (opts.json) console.log(JSON.stringify({ ok: true, notes }));
  else console.log(notes);
  return 0;
}
