// Starter sign-in adapters `aida init` writes when it recognises the app's sign-in library
// (build-plan.md M25): `templates/auth-js-sign-in.mjs` mints an Auth.js app's own JWT session
// cookie; `templates/better-auth-sign-in.mjs` inserts a better-auth database session and sets its
// signed cookie. Plain `.mjs`, not `.ts`: the built CLI loads adapters with a plain
// `import()` unless tsx is around, and TS-only syntax would fail there.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { ENGINE_DIR } from "./install.js";

/** Templates live in src/ (tsc doesn't copy .mjs into dist); the published package ships
 * `src/init/templates` too (package.json `files`), so the path is the same in a clone and an install. */
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

/** True for better-auth (`better-auth` dependency). */
export function isBetterAuth(authLibrary: string | undefined): boolean {
  return authLibrary === "better-auth";
}

/** Which starter adapter fits the app's sign-in library, if any. */
export function signInTemplateFor(authLibrary: string | undefined): "auth-js" | "better-auth" | undefined {
  if (isAuthJs(authLibrary)) return "auth-js";
  if (isBetterAuth(authLibrary)) return "better-auth";
  return undefined;
}

/** Writes `<helpDir>/adapters/sign-in.mjs` from `templateFile`, pointing it at `appDir`.
 * Never overwrites an existing adapter — it's the user's to edit. */
function writeSignInFromTemplate(helpDir: string, appDir: string, templateFile: string): WriteSignInResult {
  const file = join(helpDir, SIGN_IN_ADAPTER_PATH);
  if (existsSync(file)) return { file, written: false };
  const rel = relative(dirname(file), appDir).split(sep).join("/") || ".";
  // The placeholder is a whole JS string literal; swap in a JSON-encoded one through a replacer
  // function, so quotes, backslashes and `$&`-style patterns in the path stay literal.
  const content = readFileSync(templateFile, "utf8").replace('"__APP_DIR__"', () => JSON.stringify(rel));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
  return { file, written: true };
}

/** Writes `<helpDir>/adapters/sign-in.mjs` from the Auth.js template, pointing it at `appDir`.
 * Never overwrites an existing adapter — it's the user's to edit. */
export function writeAuthJsSignIn(helpDir: string, appDir: string, templateDir: string = SIGN_IN_TEMPLATE_DIR): WriteSignInResult {
  return writeSignInFromTemplate(helpDir, appDir, join(templateDir, "auth-js-sign-in.mjs"));
}

/** Writes `<helpDir>/adapters/sign-in.mjs` from the better-auth template, pointing it at `appDir`.
 * Never overwrites an existing adapter. */
export function writeBetterAuthSignIn(helpDir: string, appDir: string, templateDir: string = SIGN_IN_TEMPLATE_DIR): WriteSignInResult {
  return writeSignInFromTemplate(helpDir, appDir, join(templateDir, "better-auth-sign-in.mjs"));
}
