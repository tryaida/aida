// Public entry point ("aida-docs"). Configs and adapters import `defineConfig` and types from here,
// and every CLI command loads the config, so this entry must load no npm package at all: the help
// app installs a lean runtime build of the engine without Playwright, Kokoro, ffmpeg or pdf-lib
// (decisions #17, #29), and a config that pulled the whole engine in took ~3 s to import.
// test/package/runtime-imports.test.ts enforces it.
//
// So: values only from dependency-free modules; every module's types via `export type *`; the
// full runtime API is "aida-docs/dist/engine.js" (src/engine.ts). A new module goes in both files.
export { defineConfig } from "./config/define.js";
export { DEFAULT_MODEL_TIERS, DEFAULT_CAPTURE_SETTINGS, resolveCaptureSettings } from "./config/types.js";
export type * from "./walkthrough/index.js";
export type * from "./config/index.js";
export type * from "./capture/index.js";
export type * from "./render/index.js";
export type * from "./init/index.js";
export type * from "./index-search/index.js";
export type * from "./pages/index.js";
export type * from "./qa/index.js";
export type * from "./edit/index.js";
export type * from "./inspect/index.js";
export type * from "./build/index.js";
export type * from "./digest/index.js";
export type * from "./usage/index.js";
export type * from "./publish/index.js";
export type * from "./pdf/index.js";
export type * from "./procedures/index.js";
export type * from "./chat/index.js";
export type * from "./mcp/index.js";
export type * from "./impact/index.js";
export type * from "./versions/index.js";
export type * from "./whats-new/index.js";
export type * from "./ci/index.js";
export type * from "./theme/index.js";
export type * from "./safety/index.js";
export type * from "./states/index.js";
export type * from "./outline/index.js";
export type { PlaywrightDraft } from "./walkthrough/convert-playwright.js";
