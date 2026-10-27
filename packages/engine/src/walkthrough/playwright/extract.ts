import ts from "typescript";

/** One `test(...)` found in a Playwright spec file, with enough context to convert it. */
export interface ExtractedTest {
  title: string;
  /** `test.describe` titles it's nested under, outermost first. */
  describeTitles: string[];
  /** Statements from every ancestor `beforeEach`, outermost first, folded in before the test's own body. */
  beforeEach: ts.Statement[];
  body: ts.Statement[];
  /** The name bound to the `page` fixture in this test's callback, usually "page". */
  pageName: string;
  sourceFile: ts.SourceFile;
}

/** Parses a Playwright spec file and returns every `test(...)` it defines, in source order. */
export function extractTests(text: string, fileName: string): ExtractedTest[] {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: ExtractedTest[] = [];
  walk(sourceFile.statements, [], [], sourceFile, out);
  return out;
}

function walk(
  statements: readonly ts.Statement[],
  describeTitles: string[],
  beforeEachStack: ts.Statement[][],
  sourceFile: ts.SourceFile,
  out: ExtractedTest[],
): void {
  const ownBeforeEach: ts.Statement[] = [];
  const stack = [...beforeEachStack, ownBeforeEach];

  for (const stmt of statements) {
    const call = testCallOf(stmt);
    if (!call) continue;

    const kind = testCallKind(call);
    if (!kind) continue;

    if (kind === "describe") {
      const title = stringArg(call.arguments[0]) ?? "(untitled)";
      const fn = callbackArg(call.arguments);
      if (fn && ts.isBlock(fn.body)) {
        walk(fn.body.statements, [...describeTitles, title], stack, sourceFile, out);
      }
      continue;
    }

    if (kind === "beforeEach") {
      const fn = callbackArg(call.arguments);
      if (fn && ts.isBlock(fn.body)) {
        ownBeforeEach.push(...fn.body.statements);
      }
      continue;
    }

    // kind === "test"
    const title = stringArg(call.arguments[0]) ?? "(untitled)";
    const fn = callbackArg(call.arguments);
    if (!fn || !ts.isBlock(fn.body)) continue;
    const pageName = fixtureParamName(fn, "page") ?? "page";
    out.push({
      title,
      describeTitles,
      beforeEach: stack.flat(),
      body: fn.body.statements.slice(),
      pageName,
      sourceFile,
    });
  }
}

type Kind = "test" | "describe" | "beforeEach";

function testCallOf(stmt: ts.Statement): ts.CallExpression | undefined {
  if (!ts.isExpressionStatement(stmt)) return undefined;
  const expr = stmt.expression;
  if (ts.isCallExpression(expr)) return expr;
  return undefined;
}

/** `test(...)`, `test.only(...)`, `test.describe(...)`, `test.describe.serial(...)`, `test.beforeEach(...)`. */
function testCallKind(call: ts.CallExpression): Kind | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee) && callee.text === "test") return "test";
  if (!ts.isPropertyAccessExpression(callee)) return undefined;

  const names: string[] = [];
  let cur: ts.Expression = callee;
  while (ts.isPropertyAccessExpression(cur)) {
    names.unshift(cur.name.text);
    cur = cur.expression;
  }
  if (!ts.isIdentifier(cur) || cur.text !== "test") return undefined;

  if (names.includes("describe")) return "describe";
  if (names.includes("beforeEach")) return "beforeEach";
  if (names.includes("only") || names.includes("skip") || names.includes("fixme") || names.includes("slow")) {
    return "test";
  }
  return undefined;
}

function callbackArg(args: readonly ts.Expression[]): ts.ArrowFunction | ts.FunctionExpression | undefined {
  for (const a of args) {
    if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) return a;
  }
  return undefined;
}

function stringArg(expr: ts.Expression | undefined): string | undefined {
  if (!expr) return undefined;
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  return undefined;
}

/** Looks at a callback's first parameter's destructuring pattern for a fixture, e.g. `{ page: p }` -> "p". */
function fixtureParamName(fn: ts.ArrowFunction | ts.FunctionExpression, fixture: string): string | undefined {
  const param = fn.parameters[0];
  if (!param || !ts.isObjectBindingPattern(param.name)) return undefined;
  for (const el of param.name.elements) {
    if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
      const propName = el.propertyName
        ? ts.isIdentifier(el.propertyName)
          ? el.propertyName.text
          : undefined
        : el.name.text;
      if (propName === fixture) return el.name.text;
    }
  }
  return undefined;
}
