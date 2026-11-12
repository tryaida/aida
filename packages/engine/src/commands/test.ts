// `aida test [walkthroughs...] --config <path>`: replay walkthroughs as end-to-end checks and
// report like a test runner (src/smoke). Exit 0 when every replay passed, 1 when anything didn't
// (or the run couldn't start: the safety gate refused, the config didn't load), 2 for bad usage.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runWalkthroughTests, type RunWalkthroughTestsOptions } from "../smoke/run.js";
import { formatSummary, runErrorJUnit, toJUnit } from "../smoke/report.js";
import type { TestRunResult } from "../smoke/types.js";
import { AppDatabaseRefusedError } from "../safety/index.js";

export interface RunTestCommandOptions {
  configPath: string;
  walkthroughIds: string[];
  json?: boolean;
  /** Also write JUnit XML here. */
  junit?: string;
  bail?: boolean;
  /** Only the walkthroughs the diff `base`...`head` touches. */
  affected?: boolean;
  base?: string;
  head?: string;
  appRepo?: string;
}

function writeJUnit(path: string, xml: string): void {
  const file = resolve(path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, xml);
}

/** A run-level error, as `aida ci` reports one: a safety refusal whole (message, suggestions, and
 * in `--json` the redacted checks), anything else as its first line. */
function reportRunError(err: unknown, opts: RunTestCommandOptions): void {
  const refusal = err instanceof AppDatabaseRefusedError;
  const message = refusal ? err.message : err instanceof Error ? err.message.split("\n")[0] : String(err);
  if (opts.junit) writeJUnit(opts.junit, runErrorJUnit(message));
  if (opts.json) {
    console.log(JSON.stringify({ ok: false, error: message, ...(refusal ? { database: err.check, ...(err.outbound ? { outbound: err.outbound } : {}) } : {}) }));
  } else {
    console.error(`aida test failed${refusal ? ":\n" : ": "}${message}`);
  }
}

export async function runTestCommand(opts: RunTestCommandOptions): Promise<number> {
  if (opts.affected && !opts.base) {
    console.error("--affected needs --base <ref>");
    return 2;
  }
  if (!opts.affected && (opts.base || opts.head)) {
    console.error("--base and --head only apply with --affected");
    return 2;
  }

  const runOpts: RunWalkthroughTestsOptions = {
    configPath: opts.configPath,
    walkthroughs: opts.walkthroughIds,
    bail: opts.bail,
    ...(opts.affected ? { affected: { base: opts.base!, head: opts.head, appRepo: opts.appRepo } } : {}),
  };
  let result: TestRunResult;
  try {
    result = await runWalkthroughTests(runOpts);
  } catch (err) {
    reportRunError(err, opts);
    return 1;
  }

  if (opts.junit) writeJUnit(opts.junit, toJUnit(result));
  if (opts.json) console.log(JSON.stringify(result));
  else console.log(formatSummary(result));
  return result.ok ? 0 : 1;
}
