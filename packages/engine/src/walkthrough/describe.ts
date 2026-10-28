// Plain instruction wording for actions (M38): "Press **Enter**.", "Hover over **Settings**.".
// Used where a step's words come from its actions rather than a writer: the recorder's and the
// Playwright importer's draft narration, and the page/procedure/card instruction of a step that
// has no `page_text` or `caption`. Style guide voice: second person, exact on-screen label in bold,
// one instruction per sentence. Markdown; strip it for plain text.
import type { Action } from "./action.js";
import type { Target, Step } from "./types.js";
import { resolveDisplayText } from "./display.js";
import { textPattern } from "./text-pattern.js";

/** The words a reader sees for a target: its name, label, placeholder or text — never a
 * `/pattern/`, which means nothing to a reader. */
export function targetWords(target: Target): string | undefined {
  return [target.name, target.label, target.placeholder, target.text, target.hasText].find((w) => w !== undefined && !textPattern(w));
}

/** On-screen words in bold, or in quotes when bold would break on a `*`, `_` or backtick in them. */
function strong(words: string): string {
  return /[*_`]/.test(words) ? `"${words}"` : `**${words}**`;
}

type Data = Record<string, unknown> | undefined;

function boldTarget(target: Target, data?: Data): string {
  const raw = targetWords(target);
  const words = raw === undefined ? undefined : resolveDisplayText(raw, data);
  if (words) return strong(words);
  // No words to show (a css or role-only target): a neutral phrase, since a procedure or a
  // connector reader has no highlight to point at.
  return target.role ? `the ${target.role}` : "the item";
}

/** Roles (and target kinds) a person types or chooses in: "go to the field", not "move to". */
const FIELD_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider", "listbox"]);

function isField(target: Target): boolean {
  return Boolean(target.label || target.placeholder || (target.role && FIELD_ROLES.has(target.role)));
}

const KEY_WORDS: Record<string, string> = {
  Control: "Ctrl",
  Meta: "Cmd",
  Escape: "Esc",
  ArrowUp: "Up arrow",
  ArrowDown: "Down arrow",
  ArrowLeft: "Left arrow",
  ArrowRight: "Right arrow",
  " ": "Space",
};

/**
 * A Playwright key or chord in the words printed on a keyboard: "Control+K" -> "Ctrl+K",
 * "Escape" -> "Esc", "ControlOrMeta+K" -> "Ctrl+K (Cmd+K on a Mac)".
 */
export function keyWords(key: string): string {
  const parts = key.split(/\+(?=.)/);
  const words = (mod: string) =>
    parts.map((p) => (p === "ControlOrMeta" ? mod : (KEY_WORDS[p] ?? (p.length === 1 ? p.toUpperCase() : p)))).join("+");
  return parts.includes("ControlOrMeta") ? `${words("Ctrl")} (${words("Cmd")} on a Mac)` : words("Ctrl");
}

/** One action as one instruction sentence, or undefined for an action a reader doesn't do
 * (waiting for a page or element). */
export function describeAction(a: Action, data?: Data): string | undefined {
  const bold = (t: Target) => boldTarget(t, data);
  switch (a.do) {
    case "goto":
      return `Go to ${a.path}.`;
    case "click":
      return `${a.target.role === "link" ? "Open" : "Select"} ${bold(a.target)}.`;
    case "type":
      return `Fill in ${bold(a.target)}.`;
    case "select":
      return `In ${bold(a.target)}, choose ${strong(resolveDisplayText(a.option, data))}.`;
    case "point":
      return `Look at ${bold(a.target)}.`;
    case "scrollTo":
      return `Scroll to ${bold(a.target)}.`;
    case "expect":
      if (a.text !== undefined && textPattern(a.text)) return `Check that ${bold(a.target)} shows the expected text.`;
      if (a.text !== undefined) return `Check that ${bold(a.target)} shows ${a.exact ? "exactly " : ""}"${resolveDisplayText(a.text, data)}".`;
      return `Check that ${bold(a.target)} is shown.`;
    case "press":
      return a.target ? `In ${bold(a.target)}, press ${strong(keyWords(a.key))}.` : `Press ${strong(keyWords(a.key))}.`;
    case "hover":
      return `Hover over ${bold(a.target)}.`;
    case "focus": {
      if (!isField(a.target)) return `Move to ${bold(a.target)}.`;
      const words = targetWords(a.target);
      return words ? `Go to the ${strong(resolveDisplayText(words, data))} field.` : `Go to ${bold(a.target)}.`;
    }
    case "showEmail": {
      const subject = a.mock?.subject ?? (a.subject !== undefined && !textPattern(a.subject) ? resolveDisplayText(a.subject, data) : undefined);
      return subject ? `Open the email ${strong(subject)}.` : "Open the email.";
    }
    case "waitFor":
    case "waitForUrl":
      return undefined;
  }
}

/** A step's actions as instruction sentences, joined: "Fill in **Search**. Press **Enter**." */
export function describeActions(actions: readonly Action[], data?: Data): string {
  return actions
    .map((a) => describeAction(a, data))
    .filter((s): s is string => Boolean(s))
    .join(" ");
}

/**
 * A step's written instruction: its `page_text`, else its `caption`, else words from its actions
 * with `{{data}}` filled in (a draft or a step nobody wrote words for still reads as an
 * instruction). Markdown.
 */
export function stepInstruction(step: Step, data?: Record<string, unknown>): string {
  return step.page_text?.trim() || step.caption?.trim() || describeActions(step.actions, data);
}
