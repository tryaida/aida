// Turns what the person did (RecordedAction[], in order) into walkthrough steps. Pure: no browser,
// no files, so the grouping rules are tested directly.
//
// Grouping, the way the hand-written walkthroughs group:
// - Filling in fields (typing, choosing in a list, ticking a box) gathers into one step until
//   something else happens, so "enter the name" is one step, not one per field.
// - Every other click (a button, link, tab, menu item) is its own step. The page it leads to,
//   when it navigated, is waited for in the same step.
// - "Check shown" adds an `expect` to the step just done; "Point at" is a step of its own.
// - Enter in a field being filled in ends that step ("type the name and press Enter"). Tab is
//   moving between fields, which the fills and clicks already do, so it's never a step. Escape and
//   shortcuts are steps of their own.
// - "New step" starts a step; "Note" becomes the `say` of the step just done.
// Typed values go into `data`, with anything email- or phone-shaped swapped for a safe value.
import type { Action, Target } from "../walkthrough/index.js";
import { keyWords } from "../walkthrough/index.js";
import { isOpaqueSegment } from "../capture/redact.js";
import { safeValue } from "./safe-values.js";
import type { RecordedAction, ResolvedTarget } from "./types.js";

export interface DraftStep {
  id: string;
  title: string;
  say: string;
  /** True when `say` is the person's own note, not a placeholder. */
  noted: boolean;
  actions: Action[];
  /** Comments written above the step: unverified targets, things not recorded. */
  comments: string[];
}

export interface DraftSteps {
  steps: DraftStep[];
  data: Record<string, string>;
  /** Typed values swapped for safe ones, e.g. `email in "Email"`. */
  swapped: string[];
  /** Number of targets the recorder couldn't check against the page. */
  unverified: number;
  /** Comments with nowhere to go (after the last step). */
  trailing: string[];
}

interface Open {
  kind: "fill" | "do" | "show";
  title?: string;
  say?: string;
  actions: Action[];
  comments: string[];
  /** Words for the title, from the first action. */
  words: string[];
  /** A fill step that Enter sent: the next field starts a new step. */
  sent?: boolean;
}

export interface BuildStepsOptions {
  locale?: string;
}

export function buildSteps(recorded: RecordedAction[], opts: BuildStepsOptions = {}): DraftSteps {
  const steps: Open[] = [];
  const data: Record<string, string> = {};
  const swapped: string[] = [];
  let unverified = 0;
  let current: Open | undefined;
  let pendingTitle: string | undefined;
  let pendingComments: string[] = [];

  const open = (kind: Open["kind"]): Open => {
    current = { kind, actions: [], comments: pendingComments, words: [], ...(pendingTitle ? { title: pendingTitle } : {}) };
    pendingTitle = undefined;
    pendingComments = [];
    steps.push(current);
    return current;
  };
  const note = (at: ResolvedTarget, step: Open): void => {
    if (at.verified) return;
    unverified++;
    step.comments.push(`TODO: check this target, the recorder couldn't confirm it on the page: ${JSON.stringify(at.target)}`);
  };

  for (const r of recorded) {
    switch (r.kind) {
      case "type":
      case "select":
      case "click": {
        const fill = r.kind !== "click" || r.field;
        const step = fill ? (current?.kind === "fill" && !current.sent ? current : open("fill")) : open("do");
        note(r.at, step);
        if (r.kind === "click") {
          step.actions.push({ do: "click", target: r.at.target });
          step.words.push(r.at.words);
        } else if (r.kind === "select") {
          step.actions.push({ do: "select", target: r.at.target, option: r.option });
          step.words.push(r.at.words);
        } else {
          const key = dataKey(r.at.words, data);
          if (r.secret) {
            data[key] = "TODO: a demo password";
            step.comments.push(`TODO: "${r.at.words}" is a password field; the recorder never keeps what was typed there. Put a demo value in data.${key}.`);
          } else {
            const safe = safeValue(r.text, opts.locale);
            if (safe.swapped.length > 0) swapped.push(...safe.swapped.map((s) => `${s} in "${r.at.words}"`));
            data[key] = safe.value;
          }
          step.actions.push({ do: "type", target: r.at.target, text: `{{${key}}}` });
          step.words.push(r.at.words);
        }
        break;
      }
      case "press": {
        if (r.key === "Tab" || r.key === "Shift+Tab") break;
        const action: Action = r.at ? { do: "press", key: r.key, target: r.at.target } : { do: "press", key: r.key };
        if (r.key === "Enter" && current?.kind === "fill" && !current.sent) {
          if (r.at) note(r.at, current);
          current.actions.push(action);
          current.sent = true;
          break;
        }
        const step = open("do");
        if (r.at) note(r.at, step);
        step.actions.push(action);
        step.words.push(r.at?.words ?? keyWords(r.key));
        break;
      }
      case "point": {
        const step = open("show");
        note(r.at, step);
        step.actions.push({ do: "point", target: r.at.target, highlight: true });
        step.words.push(r.at.words);
        current = undefined;
        break;
      }
      case "expect": {
        const step = current ?? steps[steps.length - 1] ?? open("show");
        note(r.at, step);
        step.actions.push({ do: "expect", target: r.at.target });
        if (step.words.length === 0) step.words.push(r.at.words);
        break;
      }
      case "navigate": {
        const last = steps[steps.length - 1];
        if (r.byAction && last && last.actions.length > 0) {
          // A redirect after a save moves on more than once: wait only for where it ended up.
          const prev = last.actions[last.actions.length - 1];
          const wait: Action = { do: "waitForUrl", pattern: urlPattern(r.path) };
          if (prev.do === "waitForUrl") last.actions[last.actions.length - 1] = wait;
          else last.actions.push(wait);
        } else {
          const step = open("do");
          step.actions.push({ do: "goto", path: r.path });
          step.words.push(r.path);
          current = undefined;
        }
        break;
      }
      case "note": {
        const step = steps[steps.length - 1];
        if (step) {
          step.say = step.say ? `${step.say} ${r.text}` : r.text;
        } else {
          pendingComments.push(`Note: ${r.text}`);
        }
        break;
      }
      case "step":
        current = undefined;
        pendingTitle = r.title;
        break;
      case "todo":
        if (current) current.comments.push(`TODO: ${r.text}`);
        else pendingComments.push(`TODO: ${r.text}`);
        break;
    }
  }

  const used = new Set<string>();
  const out: DraftStep[] = steps
    .filter((s) => s.actions.length > 0)
    .map((s) => {
      const title = s.title ?? titleFor(s);
      return {
        id: uniqueId(slug(title), used),
        title,
        say: s.say ?? sayFor(s),
        noted: s.say !== undefined,
        actions: s.actions,
        comments: s.comments,
      };
    });
  // Comments on steps that ended up empty, or left pending at the end, still reach the file.
  const trailing = [...steps.filter((s) => s.actions.length === 0).flatMap((s) => s.comments), ...pendingComments];
  return { steps: out, data, swapped, unverified, trailing };
}

function first(s: Open): Action {
  return s.actions.find((a) => a.do !== "expect" && a.do !== "waitForUrl") ?? s.actions[0];
}

function titleFor(s: Open): string {
  const a = first(s);
  const words = s.words[0] ?? "";
  switch (a.do) {
    case "goto":
      return `Go to ${a.path}`;
    case "point":
      return `Look at ${words}`;
    case "expect":
      return `Check ${words}`;
    case "press":
      return `Press ${keyWords(a.key)}`;
    case "click":
      if (s.kind === "fill") return fillTitle(s.words);
      return `${a.target.role === "link" ? "Open" : "Click"} ${words}`;
    case "type":
    case "select":
      return fillTitle(s.words);
    default:
      return words || "Step";
  }
}

function fillTitle(words: string[]): string {
  const unique = [...new Set(words)];
  if (unique.length === 1) return `Fill in ${unique[0]}`;
  if (unique.length === 2) return `Fill in ${unique[0]} and ${unique[1]}`;
  return `Fill in ${unique[0]}, ${unique[1]} and more`;
}

const bold = (t: Target): string => `**${t.name ?? t.label ?? t.placeholder ?? t.text ?? "it"}**`;

/** Placeholder narration in the style guide's voice, for the person or aida-write to rewrite. */
function sayFor(s: Open): string {
  const a = first(s);
  // A fill ended with Enter: say the fill, then the key.
  const last = s.actions.filter((x) => x.do !== "expect" && x.do !== "waitForUrl").pop();
  if (a.do !== "press" && last?.do === "press") {
    return `${sayFor({ ...s, kind: "fill", actions: s.actions.filter((x) => x !== last) })} Then press **${keyWords(last.key)}**.`;
  }
  switch (a.do) {
    case "goto":
      return `Go to ${a.path}.`;
    case "press":
      return a.target ? `In ${bold(a.target)}, press **${keyWords(a.key)}**.` : `Press **${keyWords(a.key)}**.`;
    case "point":
      return `This is ${bold(a.target)}.`;
    case "expect":
      return `You'll see ${bold(a.target)}.`;
    case "click":
      if (s.kind === "fill") break;
      return `Click ${bold(a.target)}.`;
    case "select":
      if (s.actions.length === 1) return `Choose **${a.option}** in ${bold(a.target)}.`;
      break;
    case "type":
      if (s.actions.length === 1) return `Fill in ${bold(a.target)}.`;
      break;
  }
  const fields = [...new Set(s.actions.filter((x) => x.do !== "expect" && x.do !== "waitForUrl").map((x) => ("target" in x && x.target ? bold(x.target) : "")))].filter(Boolean);
  return `Fill in ${fields.length > 1 ? `${fields.slice(0, -1).join(", ")} and ${fields[fields.length - 1]}` : fields[0]}.`;
}

/** A `waitForUrl` pattern for a path, with id-like segments matching any value. */
export function urlPattern(path: string): string {
  const escaped = path
    .split("/")
    .map((seg) => (isOpaqueSegment(seg) || /^\d+$/.test(seg) ? "[^/?#]+" : seg.replace(/[.+?^${}()|[\]\\*]/g, "\\$&")))
    .join("/");
  return `^[^?#]*://[^/]+${escaped}(?:[?#].*)?$`;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .split("-")
      .slice(0, 5)
      .join("-")
      .replace(/(?:-(?:and|or|the|a|more))+$/, "") || "step"
  );
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}

/** `First name` -> `firstName`, unique within `data`. */
function dataKey(words: string, data: Record<string, string>): string {
  const base =
    words
      .replace(/[^a-zA-Z0-9]+/g, " ")
      .trim()
      .split(" ")
      .filter(Boolean)
      .slice(0, 4)
      .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
      .join("") || "value";
  // `run` is reserved for run-unique values (`{{run.id}}`).
  const start = base === "run" ? "runValue" : /^[a-z]/.test(base) ? base : `value${base}`;
  let key = start;
  for (let n = 2; key in data; n++) key = `${start}${n}`;
  return key;
}
