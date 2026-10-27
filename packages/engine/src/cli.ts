#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runValidate } from "./commands/validate.js";
import { runImportPlaywright } from "./commands/import-playwright.js";
import { runRender } from "./commands/render.js";
import { runCaptureCommand } from "./commands/capture.js";
import { runOrder } from "./commands/order.js";
import { loadConfig } from "./config/index.js";
import { runInspectCommand } from "./commands/inspect.js";
import { runRecordCommand } from "./commands/record.js";
import { runInit } from "./commands/init.js";
import { runTheme } from "./commands/theme.js";
import { runPages } from "./commands/pages.js";
import { runQaCommand } from "./commands/qa.js";
import { runBuild } from "./commands/build.js";
import { runVoiceCommand } from "./commands/voice.js";
import { runDigest } from "./commands/digest.js";
import { runDomain } from "./commands/domain.js";
import { runBriefCheck, runBriefInit, runBriefShow, runBriefSources } from "./commands/brief.js";
import { runAffected } from "./commands/affected.js";
import { runCiCli, runCiPublishCli } from "./commands/ci.js";
import { runVersionFreeze, runVersionList } from "./commands/version.js";
import { runWhatsNew } from "./commands/whats-new.js";
import { runSkillsInstall } from "./commands/skills.js";
import { runUsageAdd, runUsageReport } from "./commands/usage.js";
import type { ModelTier } from "./usage/index.js";
import { runCatchUpCommand, runEditCommand, runUndoCommand } from "./commands/edit.js";
import { runPaths } from "./commands/paths.js";
import type { EditBy } from "./edit/index.js";
import { runPublish } from "./commands/publish.js";
import { runPdfCommand } from "./commands/pdf.js";
import { runSuggest } from "./commands/suggest.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runOutlineAdd, runOutlineCheck, runOutlineImport, runOutlineList, runOutlineNote, runOutlineStatus } from "./commands/outline.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
  version: string;
};

const program = new Command();
program.name("aida").description("AIDA (Agent-driven Instruction and Documentation Automation): user guides and narrated tutorials from walkthrough files, kept current from CI.");
program.version(pkg.version);

// Command registry: each milestone adds its command here. Every command
// prints a short human summary by default, and one JSON object with --json.
//   M1  validate, import playwright
//   M2  capture
//   M3  voice
//   M4  render
//   M6  build, digest
//   M31 domain, brief

program
  .command("validate <target>")
  .description("validate all walkthroughs in a file or directory")
  .option("--config <path>", "aida.config.ts/.mjs whose `states` the walkthroughs' needs/leaves/clears are checked against")
  .option("--json", "print a single JSON object instead of a summary")
  .action(async (target: string, opts: { config?: string; json?: boolean }) => {
    let states: Record<string, { setup?: unknown; check?: unknown; as?: string }> | undefined;
    let roles: Record<string, unknown> | undefined;
    if (opts.config) {
      try {
        // Hook modules are only checked to exist here, never imported (states/hooks.ts).
        const config = await loadConfig(opts.config);
        states = config.states ?? {};
        roles = config.roles;
      } catch (err) {
        console.error(`error: ${(err as Error).message.split("\n")[0]}`);
        process.exitCode = 1;
        return;
      }
    }
    process.exitCode = runValidate(target, Boolean(opts.json), { states, roles });
  });

const importCmd = program.command("import").description("convert another tool's format into a walkthrough");

importCmd
  .command("playwright <testFileOrGlob>")
  .description("convert Playwright test(s) into draft walkthrough YAML")
  .option("-o, --out <dir>", "output directory (default: next to each input file)")
  .option("--force", "overwrite existing drafts")
  .option("--json", "print a single JSON object instead of a summary")
  .action(async (pattern: string, opts: { out?: string; json?: boolean; force?: boolean }) => {
    process.exitCode = await runImportPlaywright(pattern, opts.out, Boolean(opts.json), Boolean(opts.force));
  });

program
  .command("capture [walkthroughs...]")
  .description("replay walkthroughs in a browser and capture frames, manifest and validation")
  .requiredOption("--config <path>", "path to aida.config.ts/.mjs")
  .option("--json", "print a single JSON object instead of a summary")
  .option("--no-reset", "skip the configured database reset before capturing")
  .option("--with-deps", "also capture the walkthroughs that leave the data these ones need (see aida order)")
  .action(async (walkthroughs: string[], opts: { config: string; json?: boolean; reset: boolean; withDeps?: boolean }) => {
    process.exitCode = await runCaptureCommand({
      configPath: opts.config,
      walkthroughIds: walkthroughs,
      json: Boolean(opts.json),
      noReset: !opts.reset,
      withDeps: Boolean(opts.withDeps),
    });
  });

program
  .command("order [walkthroughs...]")
  .description("print the capture order the walkthroughs' needs/leaves/clears imply, how each need is met, and where the database is reset")
  .requiredOption("--config <path>", "path to aida.config.ts/.mjs")
  .option("--with-deps", "pull in the walkthroughs that leave the data these ones need")
  .option("--ci", "plan as aida ci does: reset before every walkthrough, always pull in dependencies")
  .option("--no-reset", "plan without database resets")
  .option("--json", "print a single JSON object instead of a summary")
  .action(async (walkthroughs: string[], opts: { config: string; withDeps?: boolean; ci?: boolean; reset: boolean; json?: boolean }) => {
    process.exitCode = await runOrder(
      { configPath: opts.config, walkthroughIds: walkthroughs, withDeps: Boolean(opts.withDeps), ci: Boolean(opts.ci), noReset: !opts.reset },
      Boolean(opts.json),
    );
  });

const outlineCmd = program
  .command("outline")
  .description("outline cards in outline.yaml: what each walkthrough should cover, and where capture found the screen differs");
const collect = (v: string, acc: string[] = []) => [...acc, v];

outlineCmd
  .command("add <title>")
  .description("add one card (status planned)")
  .requiredOption("--config <path>", "path to aida.config.ts/.mjs")
  .option("--id <id>", "kebab-case card id, the walkthrough id once written (default: from the title)")
  .option("--for <reader>", "who the walkthrough is for, e.g. \"office staff\"")
  .option("--section <section>", "help site section, e.g. Payments")
  .option("--purpose <text>", "one line: from where to what result")
  .option("--label <name>", "an on-screen name the card promises, e.g. \"Save session\" (repeatable)", collect)
  .option("--json", "print a single JSON object instead of a summary")
  .action(async (title: string, opts: { config: string; id?: string; for?: string; section?: string; purpose?: string; label?: string[]; json?: boolean }) => {
    process.exitCode = await runOutlineAdd({
      configPath: opts.config,
      title,
      id: opts.id,
      for: opts.for,
      section: opts.section,
      purpose: opts.purpose,
      labels: opts.label,
      json: Boolean(opts.json),
    });
  });

outlineCmd
  .command("import <markdown>")
  .description("add the cards from aida-plan's markdown card list (a file, or - for stdin); cards already there are left alone")
  .requiredOption("--config <path>", "path to aida.config.ts/.mjs")
  .option("--json", "print a single JSON object instead of a summary")
  .action(async (source: string, opts: { config: string; json?: boolean }) => {
    process.exitCode = await runOutlineImport({ configPath: opts.config, source, json: Boolean(opts.json) });
  });

outlineCmd
  .command("list")
  .description("print the cards, their status and any drift")
  .requiredOption("--config <path>", "path to aida.config.ts/.mjs")
  .option("--drift", "only cards where the screen differs from the card")
  .option("--json", "print a single JSON object instead of a summary")
  .action(async (opts: { config: string; drift?: boolean; json?: boolean }) => {
    process.exitCode = await runOutlineList({ configPath: opts.config, drift: Boolean(opts.drift), json: Boolean(opts.json) });
  });

outlineCmd
  .command("note <id> <text>")
  .description("record a difference by hand, e.g. a button capture can't see because it isn't there; a single quoted name in the text is taken as --expected")
  .requiredOption("--config <path>", "path to aida.config.ts/.mjs")
  .option("--expected <name>", "the on-screen name the card promised")
  .option("--seen <name>", "what the screen has instead")
  .option("--step <id>", "walkthrough step where it shows")
  .option("--json", "print a single JSON object instead of a summary")
  .action(async (id: string, text: string, opts: { config: string; expected?: string; seen?: string; step?: string; json?: boolean }) => {
    process.exitCode = await runOutlineNote({ configPath: opts.config, id, text, expected: opts.expected, seen: opts.seen, step: opts.step, json: Boolean(opts.json) });
  });

outlineCmd
  .command("check [ids...]")
  .description("recompute drift from the latest capture of each card's walkthrough and record it")
  .requiredOption("--config <path>", "path to aida.config.ts/.mjs")
  .option("--json", "print a single JSON object instead of a summary")
  .action(async (ids: string[], opts: { config: string; json?: boolean }) => {
    process.exitCode = await runOutlineCheck({ configPath: opts.config, ids, json: Boolean(opts.json) });
  });

outlineCmd
  .command("status <id> <status>")
  .description("set a card's status: planned, written, captured or dropped")
  .requiredOption("--config <path>", "path to aida.config.ts/.mjs")
  .option("--json", "print a single JSON object instead of a summary")
  .action(async (id: string, status: string, opts: { config: string; json?: boolean }) => {
    process.exitCode = await runOutlineStatus({ configPath: opts.config, id, status, json: Boolean(opts.json) });
  });

program
  .command("inspect [path]")
  .description(
    "open one app page signed in and print a compact, read-only map of its interactive elements " +
      "(role, accessible name, required/disabled, native <select> options, dialog/menu contents) " +
      "— what a walkthrough author needs before writing `do:`/`target:` locators. With --walkthrough " +
      "and --after, replay that walkthrough's real steps (this writes, like capture) and map the page a step leaves",
  )
  .requiredOption("--config <path>", "path to aida.config.ts/.mjs")
  .option("--as <persona>", "sign in as the walkthrough persona whose start.persona.role/signed_in_as matches this")
  .option("--area <cssOrLandmark>", "scope the scan to this CSS selector or ARIA landmark role (main, navigation, dialog, ...)")
  .option("--click <name>", "click this button/menuitem/tab/combobox first, to open a menu, dialog or custom listbox before scanning; repeat to click several in order (every non-GET request is blocked for the whole scan, so this can never submit anything)", (v: string, acc: string[] = []) => [...acc, v])
  .option("--check <name>", "check this radio/checkbox first, to reveal any field it conditionally shows before scanning")
  .option("--select <values...>", 'choose an option: --select "<field>" "<option>" — native <select> or custom combobox/listbox, to reveal any field it conditionally shows before scanning (non-GET requests stay blocked)')
  .option("--walkthrough <fileOrId>", "with --after: the walkthrough to replay (its file, or its id)")
  .option("--after <stepId>", "with --walkthrough: sign in as its persona, run its setup and its real actions up to and including this step (no frames or screenshots; the same safety checks as capture), then map that page")
  .option("--json", "print a single JSON object instead of a summary")
  .action(async (path: string | undefined, opts: { config: string; as?: string; area?: string; click?: string[]; check?: string; select?: string[]; walkthrough?: string; after?: string; json?: boolean }) => {
    if (opts.select && opts.select.length !== 2) {
      console.error('--select needs exactly two values: --select "<field>" "<option>"');
      process.exitCode = 1;
      return;
    }
    process.exitCode = await runInspectCommand(
      {
        configPath: opts.config,
        path,
        as: opts.as,
        area: opts.area,
        click: opts.click,
        check: opts.check,
        select: opts.select as [string, string] | undefined,
        walkthrough: opts.walkthrough,
        after: opts.after,
      },
      Boolean(opts.json),
    );
  });

program
  .command("record <id>")
  .description(
    "open the app in a browser window, signed in, and turn one click-through into a draft walkthrough " +
      "(<walkthroughsDir>/<id>.yaml): click, type and choose as a reader would; a toolbar adds pointers, " +
      "checks, notes and step breaks. Same safety checks, sign-in and setup as capture; the draft is replayed " +
      "once afterwards to show whether it works",
  )
  .requiredOption("--config <path>", "path to aida.config.ts/.mjs")
  .option("--page <path>", "page to start on", "/")
  .option("--as <role>", "sign in as this role (matched against other walkthroughs' start.persona.role/signed_in_as)")
  .option("--needs <states...>", "data states to make true before recording starts (their setup hooks run first), written to the draft's needs:")
  .option("--title <title>", "the walkthrough's title (default: from the id)")
  .option("--section <section>", "where the page sits in the help site, e.g. \"Payments\"")
  .option("--force", "overwrite an existing walkthrough file with this id")
  .option("--no-replay", "don't replay the draft afterwards (a replay saves the same things again)")
  .option("--json", "print a single JSON object instead of a summary")
  .action(
    async (
      id: string,
      opts: { config: string; page: string; as?: string; needs?: string[]; title?: string; section?: string; force?: boolean; replay: boolean; json?: boolean },
    ) => {
      process.exitCode = await runRecordCommand({
        configPath: opts.config,
        id,
        page: opts.page,
        as: opts.as,
        needs: opts.needs,
        title: opts.title,
        section: opts.section,
        force: Boolean(opts.force),
        replay: opts.replay,
        json: Boolean(opts.json),
      });
    },
  );

program
  .command("render <walkthrough>")
  .description("render a walkthrough's capture + narration into a video, captions and chapters")
  .requiredOption("--capture <dir>", "capture dir (manifest.json, validation.json, frames/)")
  .requiredOption("--voice <manifestOrDir>", "voice manifest file or its containing dir")
  .option("--draft", "lower fps/crf, ultrafast preset — for quick previews")
  .option("--stills <times>", "comma-separated seconds to render as PNG stills instead of a full render")
  .option("-o, --out-dir <dir>", "output dir (default dist/videos)")
  .option("--force", "render even if capture validation failed")
  .option("--no-cache", "re-render even if a matching .hash sidecar exists")
  .option("--config <path>", "aida config whose brand (colours, logo, font) styles the video")
  .option("--json", "print a single JSON object instead of a summary")
  .action(async (walkthrough: string, opts: {
    config?: string;
    capture: string;
    voice: string;
    draft?: boolean;
    stills?: string;
    outDir?: string;
    force?: boolean;
    cache: boolean;
    json?: boolean;
  }) => {
    process.exitCode = await runRender(walkthrough, {
      capture: opts.capture,
      voice: opts.voice,
      draft: Boolean(opts.draft),
      stills: opts.stills,
      outDir: opts.outDir,
      force: Boolean(opts.force),
      noCache: !opts.cache,
      configPath: opts.config,
    }, Boolean(opts.json));
  });

program
  .command("pages <walkthrough>")
  .description("build a walkthrough's help page (Markdown + annotated screenshots) from its capture")
  .requiredOption("--config <path>", "path to aida.config.ts/.mjs")
  .option("--video-dir <dir>", "where rendered videos/captions live (default <outDir>/videos)")
  .option("-o, --out-dir <dir>", "output dir (default <outDir>/pages)")
  .option("--json", "print a single JSON object instead of a summary")
  .action(async (walkthrough: string, opts: { config: string; videoDir?: string; outDir?: string; json?: boolean }) => {
    process.exitCode = await runPages(
      walkthrough,
      { configPath: opts.config, videoDir: opts.videoDir, outDir: opts.outDir },
      Boolean(opts.json),
    );
  });

program
  .command("pdf [walkthroughs...]")
  .description("render each walkthrough's PDF guide + quick-reference card, and the combined manual.pdf")
  .requiredOption("--config <path>", "path to aida.config.ts/.mjs")
  .option("--force", "re-render even if a matching .hash sidecar exists")
  .option("--json", "print a single JSON object instead of a summary")
  .action(async (walkthroughs: string[], opts: { config: string; force?: boolean; json?: boolean }) => {
    process.exitCode = await runPdfCommand(
      { configPath: opts.config, walkthroughIds: walkthroughs, force: Boolean(opts.force) },
      Boolean(opts.json),
    );
  });

program
  .command("qa <path>")
  .description("run QA checks (video, captions, personal data, secrets) against a file or output directory")
  .option("--json", "print a single JSON object instead of a summary")
  .action(async (target: string, opts: { json?: boolean }) => {
    process.exitCode = await runQaCommand(target, Boolean(opts.json));
  });

program
  .command("voice <walkthrough>")
  .description("narrate a walkthrough's intro/step/outro lines, writing a voice manifest render can read")
  .requiredOption("--config <path>", "path to aida.config.ts/.mjs")
  .option("--force", "re-synthesize even if a cached clip matches")
  .option("--json", "print a single JSON object instead of a summary")
  .action(async (walkthrough: string, opts: { config: string; force?: boolean; json?: boolean }) => {
    process.exitCode = await runVoiceCommand(walkthrough, { configPath: opts.config, force: opts.force }, Boolean(opts.json));
  });

program
  .command("build [walkthroughs...]")
  .description("capture, narrate, render, build pages + index, and check every walkthrough — the one-command build")
  .requiredOption("--config <path>", "path to aida.config.ts/.mjs")
  .option("--draft", "lower fps/crf, ultrafast preset — for quick previews")
  .option("--only <stages>", "comma-separated subset of: capture,voice,render,pages,pdf,index,qa")
  .option("--skip-capture", "reuse the last capture instead of replaying the browser")
  .option("--no-reset", "skip the configured database reset before capturing")
  .option("--with-deps", "also build the walkthroughs that leave the data these ones need (see aida order)")
  .option("--json", "print a single JSON object instead of a summary")
  .action(async (walkthroughs: string[], opts: {
    config: string;
    draft?: boolean;
    only?: string;
    skipCapture?: boolean;
    reset: boolean;
    withDeps?: boolean;
    json?: boolean;
  }) => {
    process.exitCode = await runBuild({
      configPath: opts.config,
      walkthroughIds: walkthroughs,
      draft: Boolean(opts.draft),
      only: opts.only,
      skipCapture: Boolean(opts.skipCapture),
      noReset: !opts.reset,
      withDeps: Boolean(opts.withDeps),
    }, Boolean(opts.json));
  });

program
  .command("digest")
  .description("compact map of a target app repo's routes, roles and on-screen labels — so an agent doesn't read the whole repo")
  .option("--app-repo <path>", "app repo to scan (default: cwd)")
  .option("--app <path>", "app directory within a workspace monorepo (e.g. apps/web) — required when several Next.js apps are found")
  .option("--area <routePrefix>", "scope the digest to routes under this prefix")
  .option("--json", "print a single JSON object instead of a summary")
  .action((opts: { appRepo?: string; app?: string; area?: string; json?: boolean }) => {
    process.exitCode = runDigest({ appRepo: opts.appRepo ?? process.cwd(), area: opts.area, app: opts.app }, Boolean(opts.json));
  });

program
  .command("domain")
  .description("the app's domain model from its database schema (Drizzle, Prisma or SQL migrations): entities, key columns, links and states")
  .option("--config <path>", "aida.config.ts/.mjs; its impact.appRepo (else the app's directory) is the repo read")
  .option("--repo <dir>", "app repo to read (default: from --config, else cwd)")
  .option("--entity <name>", "one entity in full: every column, type, reference and value")
  .option("--source <kind>", "read only this kind of schema: drizzle, prisma or sql (default: the first found, in that order)")
  .option("--json", "print a single JSON object instead of a summary")
  .action(async (opts: { config?: string; repo?: string; entity?: string; source?: string; json?: boolean }) => {
    process.exitCode = await runDomain({ configPath: opts.config, repo: opts.repo, entity: opts.entity, source: opts.source, json: Boolean(opts.json) });
  });

const briefCmd = program
  .command("brief")
  .description("the app brief (app-brief.md beside the config): what the app is for, who uses it, its words, rules and rhythm");

briefCmd
  .command("sources")
  .description("list the app's own prose worth reading for the brief (README, docs, landing page, seed data, test titles, commits): paths, sizes and headings only")
  .option("--config <path>", "aida.config.ts/.mjs; its impact.appRepo (else the app's directory) is the repo read")
  .option("--repo <dir>", "app repo to read (default: from --config, else cwd)")
  .option("--json", "print a single JSON object instead of a summary")
  .action(async (opts: { config?: string; repo?: string; json?: boolean }) => {
    process.exitCode = await runBriefSources({ configPath: opts.config, repo: opts.repo, json: Boolean(opts.json) });
  });

briefCmd
  .command("init")
  .description("write the brief's skeleton: every section with a prompt, readers from the config's roles, \"Things it keeps track of\" from aida domain")
  .option("--config <path>", "aida.config.ts/.mjs (the brief goes beside it, or at its `brief` path)")
  .option("--brief <path>", "brief file to write (default: from --config)")
  .option("--repo <dir>", "app repo to read the schema from (default: from --config, else cwd)")
  .option("--force", "replace an existing brief")
  .option("--json", "print a single JSON object instead of a summary")
  .action(async (opts: { config?: string; brief?: string; repo?: string; force?: boolean; json?: boolean }) => {
    process.exitCode = await runBriefInit({ configPath: opts.config, brief: opts.brief, repo: opts.repo, force: Boolean(opts.force), json: Boolean(opts.json) });
  });

briefCmd
  .command("check")
  .description("check the brief has its frontmatter (app, updated, readers), every section filled and a glossary table, and no real-looking emails or phone numbers")
  .option("--config <path>", "aida.config.ts/.mjs (the brief sits beside it, or at its `brief` path)")
  .option("--brief <path>", "brief file to check (default: from --config)")
  .option("--json", "print a single JSON object instead of a summary")
  .action(async (opts: { config?: string; brief?: string; json?: boolean }) => {
    process.exitCode = await runBriefCheck({ configPath: opts.config, brief: opts.brief, json: Boolean(opts.json) });
  });

briefCmd
  .command("show")
  .description("print the brief, or only the sections asked for (load just what you need)")
  .option("--config <path>", "aida.config.ts/.mjs (the brief sits beside it, or at its `brief` path)")
  .option("--brief <path>", "brief file to read (default: from --config)")
  .option("--section <name>", "a section, by name or its start, e.g. \"Words it uses\" or words (repeatable)", collect)
  .option("--json", "print a single JSON object instead of a summary")
  .action(async (opts: { config?: string; brief?: string; section?: string[]; json?: boolean }) => {
    process.exitCode = await runBriefShow({ configPath: opts.config, brief: opts.brief, sections: opts.section, json: Boolean(opts.json) });
  });

program
  .command("affected")
  .description("map a git diff to the walkthroughs it touches (routes, API calls, walkthrough files); unknown means all")
  .requiredOption("--config <path>", "path to aida.config.ts/.mjs")
  .requiredOption("--base <ref>", "git ref to diff --head against")
  .option("--head <ref>", "git ref to compare (default: HEAD); use --base <commit>^ --head <commit> for one past commit")
  .option("--app-repo <path>", "app repo to diff (default: config.impact.appRepo, then cwd)")
  .option("--app <path>", "app directory within a workspace monorepo (e.g. apps/web)")
  .option("--include-working-tree", "also consider uncommitted changes")
  .option("--json", "print a single JSON object instead of a summary")
  .action(
    async (opts: { config: string; base: string; head?: string; appRepo?: string; app?: string; includeWorkingTree?: boolean; json?: boolean }) => {
      process.exitCode = await runAffected(
        { configPath: opts.config, appRepo: opts.appRepo, base: opts.base, head: opts.head, app: opts.app, includeWorkingTree: opts.includeWorkingTree },
        Boolean(opts.json),
      );
    },
  );

program
  .command("paths <walkthrough>")
  .description("find other screens a walkthrough's task can start from: pages whose code makes the same save as its captured main path, not yet covered by its paths")
  .requiredOption("--config <path>", "path to aida.config.ts/.mjs")
  .option("--app-repo <path>", "app repo to read (default: config.impact.appRepo, then cwd)")
  .option("--app <path>", "app directory within a workspace monorepo (e.g. apps/web)")
  .option("--limit <n>", "most candidates to list (default 20)")
  .option("--json", "print a single JSON object instead of a summary")
  .action(async (walkthrough: string, opts: { config: string; appRepo?: string; app?: string; limit?: string; json?: boolean }) => {
    process.exitCode = await runPaths(
      { configPath: opts.config, walkthrough, appRepo: opts.appRepo, app: opts.app, limit: opts.limit ? Number(opts.limit) : undefined },
      Boolean(opts.json),
    );
  });

const versionCmd = program.command("version").description("manage frozen docs versions (release tags)");

versionCmd
  .command("freeze <name>")
  .description("snapshot the current build's search index, procedures and llms.txt into public/versions/<name>")
  .requiredOption("--help-app <dir>", "the help app directory (holds public/)")
  .option("--git-ref <ref>", "git ref this version corresponds to")
  .option("--force", "overwrite an existing version")
  .option("--json", "print a single JSON object instead of a summary")
  .action((name: string, opts: { helpApp: string; gitRef?: string; force?: boolean; json?: boolean }) => {
    process.exitCode = runVersionFreeze(
      { helpApp: opts.helpApp, name, gitRef: opts.gitRef, force: Boolean(opts.force) },
      Boolean(opts.json),
    );
  });

versionCmd
  .command("list")
  .description("list frozen docs versions")
  .requiredOption("--help-app <dir>", "the help app directory (holds public/)")
  .option("--json", "print a single JSON object instead of a summary")
  .action((opts: { helpApp: string; json?: boolean }) => {
    process.exitCode = runVersionList({ helpApp: opts.helpApp }, Boolean(opts.json));
  });

program
  .command("whats-new")
  .description("build the What's new page from merged PRs since the last frozen version (or --since)")
  .requiredOption("--config <path>", "path to aida.config.ts/.mjs")
  .option("--since <ref>", "git ref to start from")
  .option("--from-github", "use gh pr list instead of git log")
  .option("--app-repo <path>", "app repo to read history from (default: config.impact.appRepo, then the config's directory)")
  .option("--json", "print a single JSON object instead of a summary")
  .action(async (opts: { config: string; since?: string; fromGithub?: boolean; appRepo?: string; json?: boolean }) => {
    process.exitCode = await runWhatsNew(
      { configPath: opts.config, since: opts.since, fromGithub: Boolean(opts.fromGithub), appRepo: opts.appRepo },
      Boolean(opts.json),
    );
  });

program
  .command("suggest")
  .description("group logged unanswered chat questions into suggested new walkthroughs (keyword clustering, no model call)")
  .option("--dir <path>", "directory holding .aida/unanswered.jsonl (default: cwd)")
  .option("--from <logfile|->", "read unanswered questions from host log text instead (a file path, or - for stdin) — for a prod deployment that logs to the console instead of .aida/unanswered.jsonl")
  .option("--json", "print a single JSON object instead of a summary")
  .action((opts: { dir?: string; from?: string; json?: boolean }) => {
    process.exitCode = runSuggest({ dir: opts.dir, from: opts.from }, Boolean(opts.json));
  });

const usageCmd = program.command("usage").description("track and report model token/cost usage for a build");

usageCmd
  .command("add")
  .description("record one model call to the build's usage ledger")
  .requiredOption("--stage <stage>", "build stage that made the call, e.g. voice, pages, discover")
  .requiredOption("--tier <tier>", "fast | standard | deep")
  .option("--model <id>", "model id, e.g. claude-sonnet-5 — required unless --estimate is set, in which case it defaults to the tier's default model")
  .requiredOption("--input <n>", "input tokens", (v: string) => Number(v))
  .requiredOption("--output <n>", "output tokens", (v: string) => Number(v))
  .option("--cache-read <n>", "cache-read input tokens", (v: string) => Number(v))
  .option("--build-dir <dir>", "build dir the ledger lives in (default .build)", ".build")
  .option("--note <text>", "free-text note on this entry (why it was recorded, what it estimates, etc.)")
  .option("--estimate", "mark this entry as an estimate, not a real call's reported counts — kept out of the real total in `usage report`")
  .option("--json", "print a single JSON object instead of a summary")
  .action((opts: {
    stage: string;
    tier: ModelTier;
    model?: string;
    input: number;
    output: number;
    cacheRead?: number;
    buildDir: string;
    note?: string;
    estimate?: boolean;
    json?: boolean;
  }) => {
    process.exitCode = runUsageAdd({
      buildDir: opts.buildDir,
      stage: opts.stage,
      tier: opts.tier,
      model: opts.model,
      input: opts.input,
      output: opts.output,
      cacheRead: opts.cacheRead,
      note: opts.note,
      estimate: Boolean(opts.estimate),
    }, Boolean(opts.json));
  });

usageCmd
  .command("report")
  .description("print the build's aggregated token/cost usage")
  .option("--build-dir <dir>", "build dir the ledger lives in (default .build)", ".build")
  .option("--json", "print a single JSON object instead of a summary")
  .action((opts: { buildDir: string; json?: boolean }) => {
    process.exitCode = runUsageReport(opts.buildDir, Boolean(opts.json));
  });

const skillsCmd = program.command("skills").description("install aida's Agent Skills + subagent definitions into a repo");

skillsCmd
  .command("install")
  .description("copy skills/** into <target>/.claude/skills/ and agents into <target>/.claude/agents/")
  .option("--target <repo>", "target repo (default: cwd)")
  .option("--json", "print a single JSON object instead of a summary")
  .action((opts: { target?: string; json?: boolean }) => {
    process.exitCode = runSkillsInstall({ target: opts.target }, Boolean(opts.json));
  });

program
  .command("init [dir]")
  .description("scaffold the help app template into <dir>/help, detecting the app's framework, routes and brand")
  .option("--app-repo <path>", "app repo to detect framework/routes/brand from (default: <dir>)")
  .option("--app <path>", "app directory within a workspace monorepo (e.g. apps/web) — required when several Next.js apps are found")
  .option("--ci", "also write .github/workflows/aida.yml (PR check with screenshot diffs, publish-on-merge)")
  .option("--ci-start-command <cmd>", "command that starts the app in CI (default: npm run dev)")
  .option("--ci-uses <ownerRepoAtRef>", "the aida action to use (default: tryaida/aida@main)")
  .option("--claude", "also write .github/workflows/aida-repair.yml: opt-in Claude Code repair on an @claude comment or the docs:repair label (requires --ci)")
  .option("--claude-trigger-phrase <phrase>", "--claude's PR-comment trigger phrase (default: @claude)")
  .option("--claude-label <label>", "--claude's label trigger (default: docs:repair)")
  .option("--docs-repo <ownerRepo>", "walkthroughs/help app live in a separate repo — the workflow checks it out to .aida-docs with secrets.AIDA_DOCS_TOKEN (requires --ci)")
  .option("--no-install", "don't run npm install in the help app afterwards")
  .option(
    "--tunnel-host <host>",
    "a host a dev tunnel serves the help app on, so the Studio loads there with a private access link (repeatable; host and key written to help/.env.local)",
    (value: string, previous: string[] = []) => [...previous, value],
  )
  .option("--json", "print a single JSON object instead of a summary")
  .action(
    async (
      dir: string | undefined,
      opts: {
        appRepo?: string;
        app?: string;
        ci?: boolean;
        ciStartCommand?: string;
        ciUses?: string;
        claude?: boolean;
        claudeTriggerPhrase?: string;
        claudeLabel?: string;
        docsRepo?: string;
        install: boolean;
        tunnelHost?: string[];
        json?: boolean;
      },
    ) => {
      process.exitCode = await runInit(
        {
          dir,
          appRepo: opts.appRepo,
          app: opts.app,
          ci: opts.ci,
          ciStartCommand: opts.ciStartCommand,
          ciUses: opts.ciUses,
          ciClaude: opts.claude,
          ciClaudeTriggerPhrase: opts.claudeTriggerPhrase,
          ciClaudeLabel: opts.claudeLabel,
          ciDocsRepo: opts.docsRepo,
          install: opts.install,
          tunnelHosts: opts.tunnelHost,
        },
        Boolean(opts.json),
      );
    },
  );

program
  .command("theme [dir]")
  .description("rewrite the help app's theme files (app/brand.css, lib/brand.json, public/brand/) from aida.config's brand")
  .option("--config <path>", "path to aida.config.ts/.mjs (default: <dir>/aida.config.* or <dir>/help/aida.config.*)")
  .option("--detect", "re-detect the brand from the app and print a suggested brand block (writes nothing)")
  .option("--app-repo <path>", "app repo to detect from with --detect (default: impact.appRepo, else the config's directory)")
  .option("--from-app", "read the brand from the running app (signed in, read-only) into brand/from-app.json, then rewrite the theme")
  .option("--page <path>", "page to read with --from-app (repeatable; default: the walkthroughs' start pages)", (v: string, prev: string[] = []) => [...prev, v])
  .option("--as <role>", "persona to sign in as with --from-app (as in aida inspect --as)")
  .option("--json", "print a single JSON object instead of a summary")
  .action(
    async (
      dir: string | undefined,
      opts: { config?: string; detect?: boolean; appRepo?: string; fromApp?: boolean; page?: string[]; as?: string; json?: boolean },
    ) => {
      process.exitCode = await runTheme(
        { dir, config: opts.config, detect: Boolean(opts.detect), appRepo: opts.appRepo, fromApp: Boolean(opts.fromApp), pages: opts.page, as: opts.as },
        Boolean(opts.json),
      );
    },
  );

program
  .command("proof")
  .description("render the proof sheet (help site page, printed page, card, video frames) into <buildDir>/proof to approve the look")
  .option("--config <path>", "path to aida.config.ts/.mjs (default: ./aida.config.* or ./help/aida.config.*)")
  .option("--walkthrough <id>", "walkthrough to show (default: the first one captured and built)")
  .option("--site-url <url>", "help site to screenshot (default: publish.siteUrl; the page layout is used when it doesn't answer)")
  .option("--out-dir <dir>", "where to write the sheet (default: <buildDir>/proof)")
  .option("--json", "print a single JSON object instead of a summary")
  .action(async (opts: { config?: string; walkthrough?: string; siteUrl?: string; outDir?: string; json?: boolean }) => {
    const { runProof } = await import("./commands/proof.js");
    process.exitCode = await runProof(
      { config: opts.config, walkthrough: opts.walkthrough, siteUrl: opts.siteUrl, outDir: opts.outDir },
      Boolean(opts.json),
    );
  });

program
  .command("ci")
  .description("PR check: affected walkthroughs, capture, screenshot diff, one PR comment (no model, no API keys)")
  .requiredOption("--config <path>", "path to aida.config.ts/.mjs")
  .requiredOption("--base <ref>", "git ref to diff --head against")
  .option("--head <ref>", "git ref to compare (default: HEAD)")
  .option("--pr <number>", "pull request number, for the PR comment")
  .option("--app-url <url>", "override config.app.baseUrl for this run")
  .option("--app-repo <path>", "app repo to diff (default: config.impact.appRepo, then cwd)")
  .option("--baseline <source>", "where before-screenshots come from: disk (help app, default) or git (at --base)")
  .option("--fork-pr", "PR comes from a fork (read-only token): skip push and comment, write an artifact")
  .option("--dry-run", "write the comment and images to a local dir instead of GitHub")
  .option(
    "--publish",
    "merge-behaviour hook (build-plan.md M19): re-capture and republish what --base..--head affected into the help app, no PR/comment — run this on push to main",
  )
  .option("--json", "print a single JSON object instead of a summary")
  .action(
    async (opts: {
      config: string;
      base: string;
      head?: string;
      pr?: string;
      appUrl?: string;
      appRepo?: string;
      baseline?: string;
      forkPr?: boolean;
      dryRun?: boolean;
      publish?: boolean;
      json?: boolean;
    }) => {
      if (opts.publish) {
        process.exitCode = await runCiPublishCli(
          { configPath: opts.config, base: opts.base, head: opts.head, appUrl: opts.appUrl, appRepo: opts.appRepo },
          Boolean(opts.json),
        );
        return;
      }
      if (opts.baseline && opts.baseline !== "disk" && opts.baseline !== "git") {
        console.error(`--baseline must be "disk" or "git", got "${opts.baseline}"`);
        process.exitCode = 2;
        return;
      }
      process.exitCode = await runCiCli(
        {
          configPath: opts.config,
          base: opts.base,
          head: opts.head,
          prNumber: opts.pr ? Number(opts.pr) : undefined,
          appUrl: opts.appUrl,
          appRepo: opts.appRepo,
          baseline: opts.baseline as "disk" | "git" | undefined,
          forkPr: Boolean(opts.forkPr),
          dryRun: Boolean(opts.dryRun),
        },
        Boolean(opts.json),
      );
    },
  );

program
  .command("edit <action> [args...]")
  .description(
    "apply a shared edit action: setStepField <file> <stepId> <say|caption|page_text|title|hold|do|check> <value> | " +
      "setStepActions <file> <stepId> <actionsJson> | reorderSteps <file> <id1,id2,...> | " +
      "removeStep <file> <stepId> | " +
      "insertStep <file> --after <stepId>|--before <stepId>|--at-start --id <newId> --do \"...\" [--say ..] [--caption ..] [--page-text ..] [--title ..] [--chapter ..] [--camera full|<targetJson>] | " +
      "setData <file> <dotted.path> <value> | " +
      "setPageBlock <pageFile> <key> <text> | lock <anchorFile> <item> | unlock <anchorFile> <item> | " +
      "addCallout <file> <stepId> <calloutJson> | updateCallout <file> <stepId> <calloutId> <patchJson> | " +
      "removeCallout <file> <stepId> <calloutId> | reorderCallouts <file> <stepId> <id1,id2,...> | " +
      "addBlur <file> <stepId> <blurJson> | updateBlur <file> <stepId> <blurId> <patchJson> | " +
      "removeBlur <file> <stepId> <blurId> (callout/blur <stepId> may be <pathId>/<stepId>) | " +
      "addPath <file> <pathJson> | removePath <file> <pathId> | setPathField <file> <pathId> <title|when|note|joins|page> <value> | " +
      "setPathStepField <file> <pathId> <stepId> <field> <value> | setPathStepActions <file> <pathId> <stepId> <actionsJson>",
  )
  // insertStep's position/field flags (--after/--before/--at-start/--id/--do/--say/--caption/
  // --page-text/--title/--chapter/--camera) aren't declared options on this command — they're
  // parsed out of `args` by dispatchEdit — so Commander must not reject them as unknown options.
  .allowUnknownOption()
  .option("--by <who>", "agent | person (default agent)", "agent")
  .option("--json", "print a single JSON object instead of a summary")
  .action((action: string, args: string[], opts: { by: EditBy; json?: boolean }) => {
    process.exitCode = runEditCommand(action, args, { by: opts.by, json: Boolean(opts.json) });
  });

program
  .command("undo")
  .description("revert the last edit (optionally the last by agent or person only)")
  .option("--by <who>", "agent | person — only undo the last edit by this author")
  .option("--dir <path>", "any path inside the help app (default: cwd)")
  .option("--json", "print a single JSON object instead of a summary")
  .action((opts: { by?: EditBy; dir?: string; json?: boolean }) => {
    process.exitCode = runUndoCommand(opts.dir, { by: opts.by, json: Boolean(opts.json) });
  });

program
  .command("catch-up")
  .description("list edits a person made in the Studio since a point in time — for an agent to read at the start of a turn")
  .option("--since <isoOrLast>", "ISO timestamp, or \"last\" for since this command's last call")
  .option("--dir <path>", "any path inside the help app (default: cwd)")
  .option("--json", "print a single JSON object instead of a summary")
  .action((opts: { since?: string; dir?: string; json?: boolean }) => {
    process.exitCode = runCatchUpCommand(opts.dir, opts.since, { json: Boolean(opts.json) });
  });

program
  .command("publish")
  .description("write a host's config, optionally upload videos to blob storage, then deploy through the host's own CLI")
  .requiredOption("--config <path>", "path to aida.config.ts/.mjs")
  .option("--to <host>", "vercel | netlify | amplify | cloudflare | node | static (default: config.host)")
  .option("--prod", "production publish (default: preview)")
  .option("--dry-run", "print the plan only — no gates, no file write, no deploy")
  .option("--approve", "record first-production-publish approval (must be used with --by person)")
  .option("--by <who>", "who --approve is on behalf of — must be \"person\"")
  .option("--json", "print a single JSON object instead of a summary")
  .action(async (opts: { config: string; to?: string; prod?: boolean; dryRun?: boolean; approve?: boolean; by?: string; json?: boolean }) => {
    process.exitCode = await runPublish(
      {
        configPath: opts.config,
        to: opts.to,
        prod: Boolean(opts.prod),
        dryRun: Boolean(opts.dryRun),
        approve: Boolean(opts.approve),
        approveBy: opts.by,
      },
      Boolean(opts.json),
    );
  });

program
  .command("doctor")
  .description("check this machine and the app before capturing: Node, ffmpeg, Playwright's Chromium, disk, app address, app database, help app install")
  .option("--config <path>", "path to aida.config.ts/.mjs (default: ./aida.config.* or ./help/aida.config.*; none: machine checks only)")
  .option("--json", "print a single JSON object instead of a summary")
  .action(async (opts: { config?: string; json?: boolean }) => {
    process.exitCode = await runDoctorCommand({ configPath: opts.config }, Boolean(opts.json));
  });

program.parse();
