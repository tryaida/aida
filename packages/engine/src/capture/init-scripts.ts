// Shared browser-side init scripts for the capture runner.
//
// Playwright's `context.addInitScript()`/`page.evaluate()` accept either a function or a string
// of source text. Passing a *function* is where the bug lived: tsx (and esbuild generally) can
// rewrite a named function — including a plain `const foo = () => {...}` nested inside another
// function — into `const foo = __name(() => {...}, "foo")`, part of its "keep names for stack
// traces" transform. `__name` is a helper the transpiler injects into the *module* it compiled;
// it does not exist in the browser realm the callback is serialised into (Playwright sends only
// the function's source text, via `Function.prototype.toString()`). The result is
// `ReferenceError: __name is not defined` the instant that script runs on the page — on every
// navigation, since `addInitScript` re-runs per document. A compiled `dist/` build (plain `tsc`,
// no esbuild) never emits `__name`, so this only bit under `tsx`/vitest — exactly where it showed
// up (every pilot-app page, during `npx tsx .../cli.ts capture`).
//
// Fix, robust under both tsx and dist: write init scripts as plain source-text *strings* instead
// of functions. A string is never re-parsed by esbuild's transform — it reaches the browser
// byte-for-byte, so no `__name` wrapping can ever be introduced no matter how it's written or
// which toolchain ran it.
export const HIDE_NEXT_PORTAL_SCRIPT = `
(function () {
  function inject() {
    var s = document.createElement("style");
    s.textContent = "nextjs-portal{display:none!important}";
    document.documentElement.appendChild(s);
  }
  if (document.documentElement) inject();
  else document.addEventListener("DOMContentLoaded", inject);
})();
`;

// Belt and braces for the same bug: callbacks still passed to `page.evaluate()` as functions get
// the same `__name(...)` wrapping under tsx. Defining a no-op `__name` in every document means
// such a callback still runs, so a missed one can't break capture or masking.
export const NAME_SHIM_SCRIPT = `globalThis.__name = globalThis.__name || function (f) { return f; };`;
