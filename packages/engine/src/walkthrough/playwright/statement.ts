import ts from "typescript";
import type { Action } from "../action.js";
import type { Target } from "../target.js";
import { describeTarget, resolveLocatorExpr, type LocatorVars } from "./locator.js";
import { keyProblem, normaliseKey } from "../keys.js";
import { literalPattern, textPattern, textPatternProblem } from "../text-pattern.js";
import { SELECT_HELPER, TEXT_HELPER } from "../../export/helpers.js";

export interface StepDraft {
  /** A `test.step` title, for a step drafted from one. */
  title?: string;
  /** Drafted from a `test.step`: kept as a step of its own when it sits inside another. */
  fromTestStep?: true;
  actions: Action[];
  /** Comment lines to attach before this step, e.g. `TODO from test: ...`. */
  todos: string[];
  /** Comment lines to attach before the action at `index` (after the last when it's past it):
   * the calls a `test.step` made between two of its actions that couldn't be read. */
  todosAt?: { index: number; todos: string[] }[];
}

export interface ConvertResult {
  steps: StepDraft[];
  data: Record<string, string>;
  mapped: number;
  unmapped: number;
  signInNotes: number;
}

const ACTION_METHODS = new Set(["click", "fill", "selectOption", "check", "press", "focus", "hover"]);
const EXPECT_METHODS = new Set([
  "toBeVisible",
  "toHaveText",
  "toHaveURL",
  "toHaveCount",
  "toBeChecked",
  "toBeEnabled",
  "toBeDisabled",
  "toContainText",
]);

/** Converts one block of statements (a test body, or a folded-in `beforeEach`) into step drafts. */
export function convertStatements(
  statements: readonly ts.Statement[],
  pageName: string,
  sourceFile: ts.SourceFile,
): ConvertResult {
  const vars: LocatorVars = new Map();
  const result: ConvertResult = { steps: [], data: {}, mapped: 0, unmapped: 0, signInNotes: 0 };
  const pageNames = new Set([pageName]);

  for (const stmt of statements) {
    convertOne(stmt, vars, pageNames, sourceFile, result);
  }
  return result;
}

function sourceLine(node: ts.Node, sourceFile: ts.SourceFile): string {
  const text = node.getText(sourceFile).split("\n")[0].trim();
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  return `line ${line}: ${text.length > 140 ? `${text.slice(0, 140)}…` : text}`;
}

function todo(stmt: ts.Node, sourceFile: ts.SourceFile, result: ConvertResult): void {
  result.unmapped++;
  result.steps.push({ actions: [], todos: [`TODO from test: ${sourceLine(stmt, sourceFile)}`] });
}

function mapped(action: Action, result: ConvertResult): void {
  result.mapped++;
  result.steps.push({ actions: [action], todos: [] });
}

function isSignInCall(expr: ts.CallExpression): boolean {
  const callee = expr.expression;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : undefined;
  return Boolean(name && /sign[-_]?in|log[-_]?in/i.test(name));
}

function convertOne(
  stmt: ts.Statement,
  vars: LocatorVars,
  pageNames: Set<string>,
  sourceFile: ts.SourceFile,
  result: ConvertResult,
): void {
  // const foo = page.getByRole(...) — a locator binding, not an action.
  if (ts.isVariableStatement(stmt)) {
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.initializer || !ts.isIdentifier(decl.name)) continue;
      const resolved = resolveLocatorExpr(decl.initializer, vars, pageNames);
      if (resolved && !resolved.root) {
        vars.set(decl.name.text, resolved.target);
        continue;
      }
      // Not a recognised locator binding (e.g. `const response = await fetch(...)`) — only
      // worth a TODO when it looks load-bearing (a call), not a plain data literal.
      if (containsCall(decl.initializer)) todo(stmt, sourceFile, result);
    }
    return;
  }

  if (!ts.isExpressionStatement(stmt)) {
    // if/for/while/etc. — control flow we don't attempt to unroll.
    if (
      ts.isIfStatement(stmt) ||
      ts.isForStatement(stmt) ||
      ts.isForOfStatement(stmt) ||
      ts.isForInStatement(stmt) ||
      ts.isWhileStatement(stmt)
    ) {
      todo(stmt, sourceFile, result);
    }
    return;
  }

  const expr = unwrapAwait(stmt.expression);
  if (!ts.isCallExpression(expr)) {
    todo(stmt, sourceFile, result);
    return;
  }

  // test.step("Title", async () => { ... }): one step, titled like it, with every call inside.
  const step = testStepOf(expr);
  if (step) {
    const inner: ConvertResult = { steps: [], data: result.data, mapped: 0, unmapped: 0, signInNotes: 0 };
    for (const s of step.body) convertOne(s, vars, pageNames, sourceFile, inner);
    result.mapped += inner.mapped;
    result.unmapped += inner.unmapped;
    result.signInNotes += inner.signInNotes;
    result.steps.push(...stepsOfTestStep(step.title, inner.steps));
    return;
  }

  // await aidaSelect(page, <locator>, "Option"): an exported `select` (src/export/helpers.ts).
  const select = helperSelect(expr, vars, pageNames);
  if (select) {
    mapped(select, result);
    return;
  }

  // expect(...).matcher(...)
  const asExpect = tryConvertExpect(expr, vars, pageNames, result.data);
  if (asExpect !== undefined) {
    if (asExpect === "todo") todo(stmt, sourceFile, result);
    else mapped(asExpect, result);
    return;
  }

  // page.goto("/path")
  const callee = expr.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    const method = callee.name.text;

    if (method === "goto") {
      const base = resolveLocatorExpr(callee.expression, vars, pageNames);
      const path = stringArg(expr.arguments[0]) ?? pageRelativePath(expr.arguments[0], pageNames);
      if (base?.root && path !== undefined) {
        mapped({ do: "goto", path }, result);
        return;
      }
    }

    // page.keyboard.press("Control+K") — a key to whatever has focus.
    if (method === "press" && ts.isPropertyAccessExpression(callee.expression) && callee.expression.name.text === "keyboard") {
      const base = resolveLocatorExpr(callee.expression.expression, vars, pageNames);
      const raw = stringArg(expr.arguments[0]);
      const key = raw === undefined ? undefined : normaliseKey(raw);
      if (base?.root && key !== undefined && !keyProblem(key) && optionsOnly(expr.arguments[1], new Set(["delay"]))) {
        mapped({ do: "press", key }, result);
        return;
      }
    }

    if (ACTION_METHODS.has(method)) {
      const base = resolveLocatorExpr(callee.expression, vars, pageNames);
      if (base && !base.root) {
        const action = buildActionFromMethod(method, base.target, expr.arguments, result.data);
        if (action) {
          mapped(action, result);
          return;
        }
      }
      // The older page-level form, page.click(selector, ...): the selector is the target. A
      // Playwright selector ("text=Save", "#id", "role=button[name=Save]") works as `css`, which
      // capture hands to page.locator() as written.
      const selector = stringArg(expr.arguments[0]);
      if (base?.root && selector !== undefined) {
        const action = buildActionFromMethod(method, { css: selector }, expr.arguments.slice(1), result.data);
        if (action) {
          mapped(action, result);
          return;
        }
      }
    }
  }

  if (isSignInCall(expr)) {
    result.signInNotes++;
    result.steps.push({
      actions: [],
      todos: [`sign-in: handled by the configured sign-in adapter — original: ${sourceLine(stmt, sourceFile)}`],
    });
    return;
  }

  todo(stmt, sourceFile, result);
}

/**
 * The steps one `test.step` drafts: its own actions as one step with its title, with the TODOs of
 * the calls between them kept in place, and a `test.step` nested in it as a step of its own (the
 * actions after one continue in an untitled step).
 */
function stepsOfTestStep(title: string | undefined, inner: StepDraft[]): StepDraft[] {
  const out: StepDraft[] = [];
  let current: StepDraft = { ...(title !== undefined ? { title } : {}), fromTestStep: true, actions: [], todos: [] };
  const flush = () => {
    if (current.actions.length > 0 || current.todos.length > 0 || (current.todosAt ?? []).length > 0) out.push(current);
    current = { fromTestStep: true, actions: [], todos: [] };
  };
  for (const s of inner) {
    if (s.fromTestStep) {
      flush();
      out.push(s);
      continue;
    }
    if (s.todos.length > 0) {
      if (current.actions.length === 0) current.todos.push(...s.todos);
      else (current.todosAt ??= []).push({ index: current.actions.length, todos: s.todos });
    }
    current.actions.push(...s.actions);
  }
  flush();
  return out;
}

/** `new URL("<path>", page.url()).href`: an exported `goto` resolved against the current page. */
function pageRelativePath(expr: ts.Expression | undefined, pageNames: Set<string>): string | undefined {
  if (!expr || !ts.isPropertyAccessExpression(expr) || expr.name.text !== "href") return undefined;
  const url = expr.expression;
  if (!ts.isNewExpression(url) || !ts.isIdentifier(url.expression) || url.expression.text !== "URL" || url.arguments?.length !== 2) return undefined;
  const [path, base] = url.arguments;
  const isPageUrl =
    ts.isCallExpression(base) &&
    base.arguments.length === 0 &&
    ts.isPropertyAccessExpression(base.expression) &&
    base.expression.name.text === "url" &&
    ts.isIdentifier(base.expression.expression) &&
    pageNames.has(base.expression.expression.text);
  return isPageUrl ? stringArg(path) : undefined;
}

/** `aidaSelect(page, <locator>, "Option")`, exactly as the export writes it. */
function helperSelect(expr: ts.CallExpression, vars: LocatorVars, pageNames: Set<string>): Action | undefined {
  if (!ts.isIdentifier(expr.expression) || expr.expression.text !== SELECT_HELPER || expr.arguments.length !== 3) return undefined;
  const [page, dropdown, option] = expr.arguments;
  if (!ts.isIdentifier(page) || !pageNames.has(page.text)) return undefined;
  const resolved = resolveLocatorExpr(dropdown, vars, pageNames);
  const value = stringArg(option);
  if (!resolved || resolved.root || value === undefined) return undefined;
  return { do: "select", target: resolved.target, option: value };
}

/** `test.step(title, fn)` with a block body: its title (when a plain string) and statements. */
function testStepOf(expr: ts.CallExpression): { title: string | undefined; body: readonly ts.Statement[] } | undefined {
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "step") return undefined;
  if (!ts.isIdentifier(callee.expression) || callee.expression.text !== "test") return undefined;
  const fn = expr.arguments.find((a): a is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
  if (!fn || !ts.isBlock(fn.body)) return undefined;
  return { title: stringArg(expr.arguments[0]), body: fn.body.statements };
}

function unwrapAwait(expr: ts.Expression): ts.Expression {
  return ts.isAwaitExpression(expr) ? expr.expression : expr;
}

function containsCall(expr: ts.Expression): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) found = true;
    if (!found) ts.forEachChild(n, visit);
  };
  visit(expr);
  return found;
}

function stringArg(expr: ts.Expression | undefined): string | undefined {
  if (!expr) return undefined;
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  return undefined;
}

/** `fill`, `check`, `selectOption`, etc. with a resolved target -> an Action, or undefined if unsupported. */
function buildActionFromMethod(
  method: string,
  target: Target,
  args: readonly ts.Expression[],
  data: Record<string, string>,
): Action | undefined {
  // Options that change what the call does (a right click, a modifier held, `trial`) have no
  // walkthrough equivalent: leave the call as a TODO rather than import a different action.
  const optionsAt = method === "fill" || method === "selectOption" || method === "press" ? 1 : 0;
  if (!optionsOnly(args[optionsAt], HARMLESS_ACTION_OPTIONS)) return undefined;
  switch (method) {
    case "click":
    case "check":
      return { do: "click", target };
    case "fill": {
      const value = stringArg(args[0]);
      if (value === undefined) return undefined;
      const key = dataKey(describeTarget(target), data);
      data[key] = maskPersonalValue(value);
      return { do: "type", target, text: `{{${key}}}` };
    }
    case "selectOption": {
      const option = selectOptionValue(args[0]);
      if (option === undefined) return undefined;
      return { do: "select", target, option };
    }
    case "press": {
      const raw = stringArg(args[0]);
      const key = raw === undefined ? undefined : normaliseKey(raw);
      return key === undefined || keyProblem(key) ? undefined : { do: "press", key, target };
    }
    case "hover":
      return { do: "hover", target };
    case "focus":
      return { do: "focus", target };
    default:
      return undefined;
  }
}

/** Options an action call may carry and still mean the same action. */
const HARMLESS_ACTION_OPTIONS = new Set(["timeout", "force", "noWaitAfter", "delay"]);

/** True when `expr` is absent, or an object literal naming only `allowed` keys. */
function optionsOnly(expr: ts.Expression | undefined, allowed: ReadonlySet<string>): boolean {
  if (!expr) return true;
  if (!ts.isObjectLiteralExpression(expr)) return false;
  return expr.properties.every(
    (p) => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && allowed.has(p.name.text),
  );
}

/** `ignoreCase: true` in an object literal. */
function ignoreCaseOption(expr: ts.Expression | undefined): boolean {
  if (!expr || !ts.isObjectLiteralExpression(expr)) return false;
  return expr.properties.some(
    (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "ignoreCase" && p.initializer.kind === ts.SyntaxKind.TrueKeyword,
  );
}

/**
 * A text matcher's expected value as an expect's `text`: a RegExp literal (no flags, or `i`) as
 * `/source/flags`; a string as itself, or as an escaped pattern when it would otherwise read as
 * one ("/orders/") or `ignoreCase` is set. Undefined (a TODO) for anything else, or a pattern the
 * schema would reject. `isPattern`: the value is searched for, whichever matcher it came from.
 */
function expectedText(expr: ts.Expression | undefined, ignoreCase: boolean): { text: string; isPattern: boolean } | undefined {
  let text: string | undefined;
  let isPattern = false;
  if (expr && ts.isRegularExpressionLiteral(expr)) {
    const m = expr.text.match(/^\/(.*)\/([a-z]*)$/s);
    if (!m) return undefined;
    const flags = ignoreCase && !m[2].includes("i") ? `${m[2]}i` : m[2];
    text = `/${m[1]}/${flags}`;
    isPattern = true;
  } else {
    const str = stringArg(expr);
    if (str === undefined) return undefined;
    text = ignoreCase || textPattern(str) ? literalPattern(str, ignoreCase) : str;
  }
  return textPatternProblem(text) ? undefined : { text, isPattern };
}

function selectOptionValue(expr: ts.Expression | undefined): string | undefined {
  if (!expr) return undefined;
  const str = stringArg(expr);
  if (str !== undefined) return str;
  if (ts.isObjectLiteralExpression(expr)) {
    for (const p of expr.properties) {
      if (
        ts.isPropertyAssignment(p) &&
        ts.isIdentifier(p.name) &&
        (p.name.text === "label" || p.name.text === "value")
      ) {
        const v = stringArg(p.initializer);
        if (v !== undefined) return v;
      }
    }
  }
  return undefined;
}

/** `expect(locator).toBeVisible()` etc; returns an Action, "todo", or undefined (not an expect call at all). */
function tryConvertExpect(
  expr: ts.CallExpression,
  vars: LocatorVars,
  pageNames: Set<string>,
  data: Record<string, string>,
): Action | "todo" | undefined {
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const matcherName = callee.name.text;
  let inner = callee.expression;
  if (matcherName === "toMatch") return polledText(expr, vars, pageNames);

  // Peel off a `.not` in the chain: expect(x).not.toBeVisible()
  const negated = ts.isPropertyAccessExpression(inner) && inner.name.text === "not";
  if (negated && ts.isPropertyAccessExpression(inner)) {
    inner = inner.expression;
  }
  if (!EXPECT_METHODS.has(matcherName)) return undefined;
  if (!ts.isCallExpression(inner)) return undefined;
  const expectCallee = inner.expression;
  if (!ts.isIdentifier(expectCallee) || expectCallee.text !== "expect") return undefined;
  if (negated) return "todo"; // negated assertions don't map to our positive-only grammar

  const subject = inner.arguments[0];
  if (!subject) return "todo";

  if (matcherName === "toHaveURL") {
    const pattern = urlPattern(expr.arguments[0]);
    return pattern ? { do: "waitForUrl", pattern } : "todo";
  }

  const resolved = resolveLocatorExpr(subject, vars, pageNames);
  if (!resolved || resolved.root) return "todo";
  const target = resolved.target;

  if (matcherName === "toBeVisible") {
    // toBeVisible({ visible: false }) is the opposite check.
    return optionsOnly(expr.arguments[0], new Set(["timeout"])) ? { do: "expect", target } : "todo";
  }
  // toHaveText: the whole text equals it (whitespace collapsed); toContainText: contains it.
  // Both read textContent, as capture does; useInnerText has no equivalent.
  if (matcherName === "toHaveText" || matcherName === "toContainText") {
    const opts = expr.arguments[1];
    if (!optionsOnly(opts, new Set(["timeout", "ignoreCase"]))) return "todo";
    const value = expectedText(expr.arguments[0], ignoreCaseOption(opts));
    if (value === undefined) return "todo";
    // A RegExp is searched for by both matchers, so only a string toHaveText is `exact`.
    const exact = matcherName === "toHaveText" && !value.isPattern;
    return exact ? { do: "expect", target, text: value.text, exact: true } : { do: "expect", target, text: value.text };
  }
  // toHaveCount/toBeChecked/toBeEnabled/toBeDisabled have no Target-level equivalent.
  void data;
  return "todo";
}

/**
 * `expect.poll(() => aidaText(<locator>), { timeout }).toMatch(/pattern/)`: an exported text
 * check with a pattern (src/export/helpers.ts), read back as that check. Any other
 * `expect.poll(...).toMatch(...)` is a TODO; anything else `.toMatch` isn't an expect at all.
 */
function polledText(expr: ts.CallExpression, vars: LocatorVars, pageNames: Set<string>): Action | "todo" | undefined {
  const poll = (expr.expression as ts.PropertyAccessExpression).expression;
  if (!ts.isCallExpression(poll) || !ts.isPropertyAccessExpression(poll.expression) || poll.expression.name.text !== "poll") return undefined;
  if (!ts.isIdentifier(poll.expression.expression) || poll.expression.expression.text !== "expect") return undefined;
  const [fn, opts] = poll.arguments;
  if (!fn || !ts.isArrowFunction(fn) || fn.parameters.length > 0 || !optionsOnly(opts, new Set(["timeout"])) || poll.arguments.length > 2) return "todo";
  const body = fn.body;
  if (!ts.isCallExpression(body) || !ts.isIdentifier(body.expression) || body.expression.text !== TEXT_HELPER || body.arguments.length !== 1) return "todo";
  const resolved = resolveLocatorExpr(body.arguments[0], vars, pageNames);
  if (!resolved || resolved.root || expr.arguments.length !== 1 || !ts.isRegularExpressionLiteral(expr.arguments[0])) return "todo";
  const value = expectedText(expr.arguments[0], false);
  return value ? { do: "expect", target: resolved.target, text: value.text } : "todo";
}

function urlPattern(expr: ts.Expression | undefined): string | undefined {
  if (!expr) return undefined;
  if (ts.isRegularExpressionLiteral(expr)) {
    const m = expr.text.match(/^\/(.*)\/[a-z]*$/);
    return m ? m[1] : undefined;
  }
  const str = stringArg(expr);
  if (str === undefined) return undefined;
  const escaped = str.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return `^[^?#]*://[^/]+${escaped}(?:[?#].*)?$`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[+()\d][\d\s().-]{6,}\d$/;

/** Replaces anything email/phone-shaped with a safe example.com / fictional value. */
function maskPersonalValue(value: string): string {
  if (EMAIL_RE.test(value)) return "person@example.com";
  if (PHONE_RE.test(value)) return "+1-555-0100";
  return value;
}

function dataKey(base: string, data: Record<string, string>): string {
  const slug =
    base
      .replace(/^\/|\/$/g, "")
      .replace(/[^a-zA-Z0-9]+/g, " ")
      .trim()
      .split(" ")
      .filter(Boolean)
      .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
      .join("") || "value";
  let key = slug;
  let n = 2;
  while (key in data) {
    key = `${slug}${n}`;
    n++;
  }
  return key;
}
