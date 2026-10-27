import * as YAML from "yaml";
import type { ExtractedTest } from "./playwright/extract.js";
import type { Action } from "./action.js";
import type { Target } from "./target.js";

/** `extractTests`/`convertStatements`, loaded only when converting a Playwright file actually
 * runs. Both modules import the TypeScript compiler API to parse the test's AST, and `typescript`
 * is only a devDependency of the engine (an optional peer otherwise) — not installed when aida
 * runs as a plain CLI install. Deferring the import keeps every other command loadable without it. */
type PlaywrightConverters = {
  extractTests: typeof import("./playwright/extract.js").extractTests;
  convertStatements: typeof import("./playwright/statement.js").convertStatements;
};

/** Turns a module-not-found error for `typescript` into the actionable message; rethrows
 * anything else as-is. Exported so the mapping itself is unit-testable without having to
 * actually uninstall typescript to exercise it. */
export function playwrightImportInstallHint(err: unknown): string | undefined {
  const message = err instanceof Error ? err.message : String(err);
  if (/Cannot find (package|module) ['"]typescript['"]/.test(message)) {
    return "install typescript to import Playwright tests: npm i -D typescript";
  }
  return undefined;
}

/** Loads the two Playwright-import modules. Node's own module cache makes repeat calls cheap
 * once typescript has loaded once, so nothing here needs its own cache. `loader` is overridable
 * in tests to simulate typescript missing without touching node_modules. */
export async function loadPlaywrightConverters(
  loader: () => Promise<PlaywrightConverters> = async () => {
    const [extract, statement] = await Promise.all([import("./playwright/extract.js"), import("./playwright/statement.js")]);
    return { extractTests: extract.extractTests, convertStatements: statement.convertStatements };
  },
): Promise<PlaywrightConverters> {
  try {
    return await loader();
  } catch (err) {
    const hint = playwrightImportInstallHint(err);
    throw hint ? new Error(hint) : err;
  }
}

export interface PlaywrightDraft {
  /** The walkthrough slug id this draft would be saved under. */
  id: string;
  /** The YAML text, including the draft banner and per-step `TODO from test:` comments. */
  yaml: string;
  title: string;
  mapped: number;
  unmapped: number;
  signInNotes: number;
}

export interface ConvertPlaywrightResult {
  /** Relative-ish label for the source file, used in the draft banner. */
  source: string;
  drafts: PlaywrightDraft[];
}

/** Converts one Playwright spec file's text into one draft walkthrough per `test(...)`. */
export async function convertPlaywrightFile(text: string, fileName: string, sourceLabel = fileName): Promise<ConvertPlaywrightResult> {
  const { extractTests, convertStatements } = await loadPlaywrightConverters();
  const tests = extractTests(text, fileName);
  const usedIds = new Set<string>();
  const drafts = tests.map((t) => buildDraft(t, sourceLabel, usedIds, convertStatements));
  return { source: sourceLabel, drafts };
}

function buildDraft(test: ExtractedTest, sourceLabel: string, usedIds: Set<string>, convertStatements: PlaywrightConverters["convertStatements"]): PlaywrightDraft {
  const converted = convertStatements(
    [...test.beforeEach, ...test.body],
    test.pageName,
    test.sourceFile,
  );

  const id = uniqueId(slugify(test.title), usedIds);
  const title = placeholderTitle(test.title);
  const chapter = test.describeTitles.length > 0 ? test.describeTitles[test.describeTitles.length - 1] : undefined;

  const doc = buildYamlDoc({
    id,
    title,
    summary: `Draft imported from a Playwright test. Review every TODO before publishing.`,
    source: sourceLabel,
    testTitle: test.title,
    describeTitles: test.describeTitles,
    data: converted.data,
    chapter,
    steps: converted.steps,
  });

  return {
    id,
    yaml: doc,
    title,
    mapped: converted.mapped,
    unmapped: converted.unmapped,
    signInNotes: converted.signInNotes,
  };
}

interface BuildArgs {
  id: string;
  title: string;
  summary: string;
  source: string;
  testTitle: string;
  describeTitles: string[];
  data: Record<string, string>;
  chapter?: string;
  steps: { actions: Action[]; todos: string[] }[];
}

function buildYamlDoc(args: BuildArgs): string {
  const stepObjs = args.steps
    .filter((s) => s.actions.length > 0)
    .map((s) => ({
      ...(args.chapter ? { chapter: args.chapter } : {}),
      say: placeholderSay(s.actions[0]),
      actions: s.actions,
    }));

  // A draft with every call unmapped still needs at least one step to pass schema validation
  // (`steps: z.array(RawStepSchema).min(1)`) — fall back to a single no-op `expect` placeholder
  // the person replaces, so the file is still a valid shell to finish by hand.
  if (stepObjs.length === 0) {
    stepObjs.push({
      ...(args.chapter ? { chapter: args.chapter } : {}),
      say: "This step needs to be written by hand — see the TODOs above.",
      actions: [{ do: "expect", target: { text: "TODO" } } satisfies Action],
    });
  }

  const raw: Record<string, unknown> = {
    walkthrough: args.id,
    title: args.title,
    summary: args.summary,
    ...(Object.keys(args.data).length > 0 ? { data: args.data } : {}),
    steps: stepObjs,
  };

  const doc = new YAML.Document();
  doc.contents = doc.createNode(raw);

  doc.commentBefore = [
    ` DRAFT — generated by \`aida import playwright\` from ${args.source}, test "${args.testTitle}".`,
    args.describeTitles.length > 0 ? ` Nested under: ${args.describeTitles.join(" > ")}.` : undefined,
    " Review before publishing: fill in `for:`/`start:`, check every step's narration and",
    " doc text, and resolve the TODOs below (unmapped Playwright calls this importer couldn't",
    " translate, left as comments so nothing is silently dropped).",
  ]
    .filter((l): l is string => Boolean(l))
    .join("\n");

  // Attach each step's TODOs as a comment immediately before that step's node, in document order.
  // The index tracking has to skip steps we filtered out above (all-TODO steps with no actions).
  const stepsNode = doc.get("steps", true) as YAML.YAMLSeq;
  let nodeIndex = 0;
  for (const step of args.steps) {
    if (step.actions.length === 0) {
      // No node for this one — fold its TODOs onto the comment of the next real step, or the
      // document's trailing comment if it's the last thing in the test.
      const target = stepsNode.items[nodeIndex] as YAML.YAMLMap | undefined;
      if (target) {
        target.commentBefore = appendComments(target.commentBefore, step.todos);
      } else {
        doc.comment = appendComments(doc.comment ?? undefined, step.todos);
      }
      continue;
    }
    nodeIndex++;
  }

  return doc.toString();
}

function appendComments(existing: string | null | undefined, todos: string[]): string {
  const lines = todos.map((t) => ` ${t}`);
  return [existing ?? undefined, ...lines].filter((l): l is string => Boolean(l)).join("\n");
}

function placeholderTitle(testTitle: string): string {
  const stripped = testTitle.replace(/^[a-z]+:\s*/i, "");
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

function placeholderSay(action: Action): string {
  switch (action.do) {
    case "goto":
      return `Go to ${action.path}.`;
    case "click":
      return `Select ${targetLabel(action.target)}.`;
    case "type":
      return `Fill in ${targetLabel(action.target)}.`;
    case "select":
      return `Choose "${action.option}" for ${targetLabel(action.target)}.`;
    case "expect":
      return `Check that ${targetLabel(action.target)} is visible.`;
    case "waitForUrl":
      return "Wait for the page to navigate.";
    case "point":
    case "waitFor":
      return `Look at ${targetLabel(action.target)}.`;
    case "scrollTo":
      return `Scroll to ${targetLabel(action.target)}.`;
    default:
      return "This step needs narration.";
  }
}

function targetLabel(target: Target): string {
  const text =
    target.name ?? target.label ?? target.placeholder ?? target.text ?? target.hasText ?? target.css ?? "it";
  return `"${text}"`;
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "test";
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}-${n}`;
    n++;
  }
  used.add(id);
  return id;
}
