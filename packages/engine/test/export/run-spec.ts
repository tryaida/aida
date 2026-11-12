// Runs exported Playwright code in a plain `playwright` browser, the way `@playwright/test` would
// run it (it isn't a dependency here): the spec is transpiled with its helpers, and `test`,
// `expect` and `use.baseURL` are small stand-ins that keep Playwright's own matching rules.
import ts from "typescript";
import type { Locator, Page } from "playwright";
import { CodeContext, helperCode, locatorCode } from "../../src/export/index.js";
import type { Target } from "../../src/walkthrough/index.js";

function toJs(source: string): string {
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
}

/** The exported locator for `target`, with the helpers it calls, evaluated against `page`. */
export async function exportedLocator(target: Target, page: Page): Promise<Locator> {
  const ctx = new CodeContext();
  const code = locatorCode(target, "page", ctx);
  const js = toJs(`${helperCode(ctx).join("\n")}\nasync function locate(page: any) { return ${code}; }`);
  return (await new Function("page", `${js}\nreturn locate(page);`)(page)) as Locator;
}

const normalise = (text: string) => text.replace(/\s+/g, " ").trim();

async function poll(check: () => Promise<boolean>, timeout: number, what: () => string): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() >= deadline) throw new Error(`expect timed out: ${what()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Playwright's text matching: a string is compared with whitespace collapsed, a RegExp is
 * tested against the text as it is (injectedScript's ExpectedTextMatcher). */
function textMatches(actual: string, expected: string | RegExp, substring: boolean): boolean {
  if (expected instanceof RegExp) return expected.test(actual);
  const got = normalise(actual);
  return substring ? got.includes(normalise(expected)) : got === normalise(expected);
}

function expectShim(subject: Locator | Page) {
  type Opts = { timeout?: number };
  const loc = subject as Locator;
  const text = async () => (await loc.textContent({ timeout: 200 })) ?? "";
  return {
    toBeVisible: (o: Opts = {}) => loc.waitFor({ state: "visible", timeout: o.timeout ?? 5_000 }),
    toHaveText: (e: string | RegExp, o: Opts = {}) => poll(async () => textMatches(await text(), e, false), Math.min(o.timeout ?? 5_000, 2_000), () => `toHaveText ${e}`),
    toContainText: (e: string | RegExp, o: Opts = {}) => poll(async () => textMatches(await text(), e, true), Math.min(o.timeout ?? 5_000, 2_000), () => `toContainText ${e}`),
    toHaveURL: (e: RegExp, o: Opts = {}) => (subject as Page).waitForURL(e, { timeout: o.timeout }),
  };
}
expectShim.poll = (fn: () => Promise<unknown>, o: { timeout?: number } = {}) => ({
  toMatch: (re: RegExp) => {
    let last: unknown;
    return poll(
      async () => {
        last = await fn();
        return typeof last === "string" && re.test(last);
      },
      Math.min(o.timeout ?? 5_000, 2_000),
      () => `poll got ${JSON.stringify(last)}, wanted ${re}`,
    );
  },
});

/** `page` as `@playwright/test` hands it to a test: `goto` resolves a URL against use.baseURL. */
function withBaseURL(page: Page, baseURL: string): Page {
  return new Proxy(page, {
    get(target, prop) {
      if (prop === "goto") return (url: string, opts?: object) => target.goto(new URL(url, baseURL).href, opts);
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Runs every `test(...)` in an exported spec against `page`, failing as the test would. */
export async function runSpec(spec: string, page: Page, baseURL: string): Promise<void> {
  const tests: ((args: { page: Page }) => Promise<void>)[] = [];
  const test = Object.assign((_title: string, fn: (args: { page: Page }) => Promise<void>) => void tests.push(fn), {
    step: (_title: string, fn: () => Promise<unknown>) => fn(),
    use: () => {},
  });
  const js = toJs(spec.replace(/^import .* from "@playwright\/test";$/m, ""));
  new Function("test", "expect", "process", js)(test, expectShim, process);
  for (const fn of tests) await fn({ page: withBaseURL(page, baseURL) });
}
