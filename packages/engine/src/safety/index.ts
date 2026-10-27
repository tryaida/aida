// Capture safety (decisions #27; build-plan.md M24): the app database guard, the live payment
// key refusal and the outbound sender warning. `capture`, `build` and `ci` call
// `runCaptureSafetyChecks` once per run, before the first browser opens; `aida doctor` reports
// the same checks without refusing.
import { AppDatabaseRefusedError, assertAppDatabaseSafe, checkAppDatabase } from "./database.js";
import type { AppDatabaseCheck, AppSafetyConfig } from "./database.js";
import { checkOutbound } from "./outbound.js";
import type { OutboundCheck } from "./outbound.js";

export {
  checkAppDatabase,
  assertAppDatabaseSafe,
  AppDatabaseRefusedError,
  resolveAppDir,
  isDatabaseVariable,
  resetAppDatabaseWarnings,
  DATABASE_VARIABLES,
  THROWAWAY_ENV,
} from "./database.js";
export type {
  AppDatabaseCheck,
  AppDatabaseFinding,
  AppDatabaseStatus,
  AppDirSource,
  AppSafetyConfig,
  CheckAppDatabaseOptions,
} from "./database.js";
export { checkOutbound } from "./outbound.js";
export type { OutboundCheck, OutboundFinding, OutboundKind, CheckOutboundOptions } from "./outbound.js";
export { classifyDatabaseSetting, classifyHost, isSharedHost, looksLikeDatabaseValue } from "./classify.js";
export type { ParsedDatabaseSetting, HostKind, ClassifyOptions } from "./classify.js";
export { parseEnvFile, collectAppEnv, isAppEnvFile, appEnvDirs, APP_ENV_FILES } from "./env.js";

export interface CaptureSafetyResult {
  database: AppDatabaseCheck;
  outbound: OutboundCheck;
}

/**
 * The run-level gate before any capture that runs steps: refuses (throws
 * `AppDatabaseRefusedError`) when the app's database isn't on this machine and isn't opted in,
 * or a live Stripe key isn't allowed (`reason: "live-payments"`); passes "unknown" database and
 * outbound-sender warnings to `warn` (stderr by default).
 */
export async function runCaptureSafetyChecks(
  config: AppSafetyConfig,
  opts: { env?: Record<string, string | undefined>; warn?: (message: string) => void } = {},
): Promise<CaptureSafetyResult> {
  const warn = opts.warn ?? ((m: string) => console.error(`warning: ${m}`));
  const database = await checkAppDatabase({ config, env: opts.env });
  assertAppDatabaseSafe(database, warn);
  const outbound = checkOutbound({ config, env: opts.env });
  if (outbound.refusal) {
    throw new AppDatabaseRefusedError(database, { message: outbound.refusal, suggestions: outbound.refusalSuggestions, outbound });
  }
  if (outbound.message) warn(outbound.message);
  return { database, outbound };
}

/**
 * `runCaptureSafetyChecks` for a command's top level: returns the refusal (plain-English `error`
 * with its suggestions, the database check, and the outbound check for a live-payments refusal)
 * instead of throwing, or undefined when capture may go ahead. Each command reports it like its other run-level errors.
 */
export async function captureSafetyRefusal(
  config: AppSafetyConfig,
  opts: { env?: Record<string, string | undefined>; warn?: (message: string) => void } = {},
): Promise<{ error: string; database?: AppDatabaseCheck; outbound?: OutboundCheck } | undefined> {
  try {
    await runCaptureSafetyChecks(config, opts);
    return undefined;
  } catch (err) {
    if (err instanceof AppDatabaseRefusedError) return { error: err.message, database: err.check, ...(err.outbound ? { outbound: err.outbound } : {}) };
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
