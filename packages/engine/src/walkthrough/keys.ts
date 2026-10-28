// Key names for `press` (M38): what Playwright's keyboard accepts, checked when a walkthrough
// loads so "Ctrl+K" or "Entr" fails at validate, not halfway through a capture.

const MODIFIERS = ["Shift", "Control", "Alt", "Meta", "ControlOrMeta"];
const NAMED = [
  "Enter", "Tab", "Escape", "Backspace", "Delete", "Insert", "Space", "Home", "End", "PageUp", "PageDown",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "CapsLock", "ContextMenu",
  "Backquote", "Minus", "Equal", "Backslash", "BracketLeft", "BracketRight", "Semicolon", "Quote", "Comma", "Period", "Slash",
  "NumpadEnter", "NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide", "NumpadDecimal",
];
const ALIASES: Record<string, string> = {
  esc: "Escape", ctrl: "Control", cmd: "Meta", command: "Meta", option: "Alt", opt: "Alt", return: "Enter", del: "Delete",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
};
const KNOWN = new Map([...MODIFIERS, ...NAMED].map((k) => [k.toLowerCase(), k] as const));

function splitChord(key: string): string[] {
  // "Shift++" is Shift and "+": a "+" only separates when something follows it.
  return key.split(/\+(?=.)/);
}

/** `enter` -> `Enter`, `ctrl+k` -> `Control+k`, `Cmd+K` -> `Meta+K`: Playwright's names are
 * case-sensitive, writers needn't be. Single characters and unknown names are kept as written. */
export function normaliseKey(key: string): string {
  return splitChord(key.trim())
    .map((part) => {
      const lower = part.toLowerCase();
      return ALIASES[lower] ?? KNOWN.get(lower) ?? part;
    })
    .join("+");
}

function isKeyName(part: string): boolean {
  if ([...part].length === 1) return true;
  if (KNOWN.has(part.toLowerCase()) && KNOWN.get(part.toLowerCase()) === part) return true;
  return /^(Key[A-Z]|Digit[0-9]|Numpad[0-9]|F([1-9]|1[0-2]))$/.test(part);
}

/** Why `key` (already normalised) isn't a key Playwright can press, or undefined when it is. */
export function keyProblem(key: string): string | undefined {
  if (!key) return "a key is needed";
  const parts = splitChord(key);
  const last = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  const badMod = mods.find((m) => !MODIFIERS.includes(m));
  if (badMod !== undefined) return `"${badMod}" in "${key}" isn't a modifier: use Shift, Control, Alt, Meta or ControlOrMeta before the +`;
  if (!isKeyName(last)) {
    return `"${last}" isn't a key name: use one character or a name like Enter, Escape, Tab, ArrowDown, F2 (chords like Control+K)`;
  }
  return undefined;
}
