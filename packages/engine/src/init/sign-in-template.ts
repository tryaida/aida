// Starter sign-in adapters `aida init` writes when it recognises the app's sign-in library
// (build-plan.md M25). Auth.js only for now: `templates/auth-js-sign-in.mjs` mints the app's own
// JWT session cookie. Plain `.mjs`, not `.ts`: the built CLI loads adapters with a plain
// `import()` unless tsx is around, and TS-only syntax would fail there.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { ENGINE_DIR } from "./install.js";

/** Templates live in src/ (tsc doesn't copy .mjs into dist); the engine runs from the monorepo
 * either way, same as the help-app template (copy-template.ts). */
export const SIGN_IN_TEMPLATE_DIR = join(ENGINE_DIR, "src", "init", "templates");

/** The config's `signIn` value for the written adapter, relative to aida.config.ts. */
export const SIGN_IN_ADAPTER_PATH = "./adapters/sign-in.mjs";

/** True for the libraries the Auth.js template handles: `next-auth` (v4, v5) and `@auth/*`. */
export function isAuthJs(authLibrary: string | undefined): boolean {
  return Boolean(authLibrary && authLibrary.startsWith("Auth.js"));
}

export interface WriteSignInResult {
  file: string;
  written: boolean;
}

/** Writes `<helpDir>/adapters/sign-in.mjs` from the Auth.js template, pointing it at `appDir`.
 * Never overwrites an existing adapter — it's the user's to edit. */
export function writeAuthJsSignIn(helpDir: string, appDir: string, templateDir: string = SIGN_IN_TEMPLATE_DIR): WriteSignInResult {
  const file = join(helpDir, SIGN_IN_ADAPTER_PATH);
  if (existsSync(file)) return { file, written: false };
  const rel = relative(dirname(file), appDir).split(sep).join("/") || ".";
  // The placeholder is a whole JS string literal; swap in a JSON-encoded one through a replacer
  // function, so quotes, backslashes and `$&`-style patterns in the path stay literal.
  const content = readFileSync(join(templateDir, "auth-js-sign-in.mjs"), "utf8").replace('"__APP_DIR__"', () => JSON.stringify(rel));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
  return { file, written: true };
}
