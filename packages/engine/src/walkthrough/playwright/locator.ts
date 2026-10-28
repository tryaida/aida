import ts from "typescript";
import type { Target } from "../target.js";

/**
 * Resolves a Playwright locator-chain expression (e.g. `page.getByRole("button", { name: "Save"
 * })`, or `exportDialog.getByRole("checkbox", { name: "Product ID" })` where `exportDialog` is a
 * variable already bound to a locator) into our `Target` shape, or `undefined` when the chain
 * uses something we don't recognise (a helper function, `.last()`, a dynamic selector, ...).
 *
 * `root: true` means the chain is scoped directly off the page fixture (no `within` needed);
 * `root: false` carries the `Target` built so far, used as `within` for anything chained off it.
 */
export type Resolved = { root: true } | { root: false; target: Target };

/** Maps a locator variable's name (e.g. `exportDialog`) to the Target it was built from. */
export type LocatorVars = Map<string, Target>;

export function resolveLocatorExpr(
  expr: ts.Expression,
  vars: LocatorVars,
  pageNames: Set<string>,
): Resolved | undefined {
  if (ts.isParenthesizedExpression(expr)) return resolveLocatorExpr(expr.expression, vars, pageNames);

  if (ts.isIdentifier(expr)) {
    if (pageNames.has(expr.text)) return { root: true };
    const target = vars.get(expr.text);
    if (target) return { root: false, target };
    return undefined;
  }

  // `this.page` or similar — treat the final property name "page" as the root fixture too.
  if (ts.isPropertyAccessExpression(expr) && expr.name.text === "page" && !ts.isCallExpression(expr.expression)) {
    return { root: true };
  }

  if (!ts.isCallExpression(expr)) return undefined;
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;

  const method = callee.name.text;
  const args = expr.arguments;

  // `.filter(...)`, `.nth(n)`, `.first()` narrow the *already built* target rather than
  // nesting a new `within` level.
  if (method === "filter" || method === "nth" || method === "first" || method === "last") {
    const base = resolveLocatorExpr(callee.expression, vars, pageNames);
    if (!base || base.root) return undefined; // nothing to narrow
    if (method === "nth") {
      const n = args[0] && ts.isNumericLiteral(args[0]) ? Number(args[0].text) : undefined;
      if (n === undefined) return undefined;
      return { root: false, target: { ...base.target, nth: n } };
    }
    if (method === "first") {
      return { root: false, target: { ...base.target, nth: 0 } };
    }
    if (method === "last") {
      // No "last" concept in Target — can't express without knowing the count.
      return undefined;
    }
    // filter({ hasText: "..." })
    const obj = args[0];
    if (!obj || !ts.isObjectLiteralExpression(obj)) return undefined;
    const hasText = readStringProp(obj, "hasText");
    if (hasText === undefined) return undefined;
    return { root: false, target: { ...base.target, hasText } };
  }

  const finders = new Set([
    "getByRole",
    "getByLabel",
    "getByText",
    "getByPlaceholder",
    "getByTestId",
    "locator",
  ]);
  if (!finders.has(method)) return undefined;

  const base = resolveLocatorExpr(callee.expression, vars, pageNames);
  if (!base) return undefined;

  const within = base.root ? undefined : base.target;
  const built = buildFinderTarget(method, args);
  if (!built) return undefined;
  return { root: false, target: within ? { ...built, within } : built };
}

function buildFinderTarget(method: string, args: readonly ts.Expression[]): Target | undefined {
  switch (method) {
    case "getByRole": {
      const role = readStringOrRegex(args[0]);
      if (role === undefined) return undefined;
      const opts = args[1];
      const target: Target = { role };
      if (opts && ts.isObjectLiteralExpression(opts)) {
        const name = readStringOrRegexProp(opts, "name");
        if (name !== undefined) target.name = name;
        const exact = readBoolProp(opts, "exact");
        if (exact !== undefined) target.exact = exact;
      }
      return target;
    }
    case "getByLabel": {
      const label = readStringOrRegex(args[0]);
      if (label === undefined) return undefined;
      return withExact({ label }, args[1]);
    }
    case "getByText": {
      const text = readStringOrRegex(args[0]);
      if (text === undefined) return undefined;
      return withExact({ text }, args[1]);
    }
    case "getByPlaceholder": {
      const placeholder = readStringOrRegex(args[0]);
      if (placeholder === undefined) return undefined;
      return { placeholder };
    }
    case "getByTestId": {
      const id = readStringOrRegex(args[0]);
      if (id === undefined) return undefined;
      return { css: `[data-testid="${id}"]` };
    }
    case "locator": {
      const css = readStringOrRegex(args[0]);
      if (css === undefined) return undefined;
      return { css };
    }
    default:
      return undefined;
  }
}

/** `target` with `exact` from a `{ exact: true }` options argument, when there is one. */
function withExact(target: Target, opts: ts.Expression | undefined): Target {
  if (!opts || !ts.isObjectLiteralExpression(opts)) return target;
  const exact = readBoolProp(opts, "exact");
  return exact === undefined ? target : { ...target, exact };
}

/** A string literal, or a `/.../` regex literal turned into our `"/source/"` convention. */
function readStringOrRegex(expr: ts.Expression | undefined): string | undefined {
  if (!expr) return undefined;
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (ts.isRegularExpressionLiteral(expr)) {
    const m = expr.text.match(/^\/(.*)\/[a-z]*$/);
    return m ? `/${m[1]}/` : expr.text;
  }
  return undefined;
}

function readStringProp(obj: ts.ObjectLiteralExpression, name: string): string | undefined {
  const prop = findProp(obj, name);
  return prop ? readStringOrRegex(prop) : undefined;
}

function readStringOrRegexProp(obj: ts.ObjectLiteralExpression, name: string): string | undefined {
  return readStringProp(obj, name);
}

function readBoolProp(obj: ts.ObjectLiteralExpression, name: string): boolean | undefined {
  const prop = findProp(obj, name);
  if (!prop) return undefined;
  if (prop.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (prop.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

function findProp(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name) {
      return p.initializer;
    }
  }
  return undefined;
}

/** A short, stable label for a target, used to name a `{{data}}` entry or describe a step. */
export function describeTarget(target: Target): string {
  const bits = [target.role, target.name, target.label, target.placeholder, target.text, target.css].filter(
    Boolean,
  );
  return bits[0] ?? "field";
}
