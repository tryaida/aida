import type { Page, BrowserContext, APIRequestContext } from "playwright";
import type { Persona, Viewport } from "../walkthrough/index.js";
import type { PronunciationMap } from "../voice/types.js";

/** Context passed to a sign-in adapter: everything it needs to establish a session. */
export interface SignInContext {
  page: Page;
  context: BrowserContext;
  baseUrl: string;
  persona?: Persona;
  /** Process environment, passed explicitly so adapters stay testable. */
  env: Record<string, string | undefined>;
}

/** Signs a browser context in, then returns — capture reuses the resulting storage state. */
export type SignInAdapter = (ctx: SignInContext) => Promise<void> | void;

/** One row-shaped result from a database adapter's query. */
export type DatabaseRow = Record<string, unknown>;

/**
 * Optional hook backing a walkthrough's `validate.database` checks. Generic by
 * design: aida never talks to a database itself. `url()` is used only to
 * enforce the local-only safety check before any query runs.
 */
export interface DatabaseAdapter {
  url(): Promise<string> | string;
  /**
   * `context`, when given, carries the `url` the capture runner already
   * validated with `assertLocalDatabase` — adapters should connect with that
   * exact URL rather than re-deriving it, closing the gap between the check
   * and the query.
   */
  query(sql: string, params?: unknown[], context?: { url: string }): Promise<DatabaseRow[]>;
  close?(): Promise<void> | void;
  /** Recreates throwaway demo data (e.g. a `db.sh reset` script). Skipped by `--no-reset`. */
  reset?(): Promise<void> | void;
}

/** A module path (resolved relative to the config file) or an adapter value/factory. */
export type SignInAdapterRef = string | SignInAdapter | { modulePath: string; export?: string };
export type DatabaseAdapterRef = string | DatabaseAdapter | { modulePath: string; export?: string };

/**
 * What a state hook gets (decision 28): a page and context signed in as the state's `as` role
 * (else the walkthrough's persona), and `request`, an API client carrying that session, so a hook
 * can put data in through the app's own API (decision 15) rather than the database.
 */
export interface StateHookContext {
  /** The state being checked or set up, e.g. "session-full". */
  state: string;
  page: Page;
  context: BrowserContext;
  /**
   * Shares the signed-in session's cookies; relative paths resolve against `baseUrl`. With no
   * `as` on the state this is the walkthrough's own recording context: signing in or out through
   * it changes who the capture is signed in as (the same holds when `as` names the walkthrough's
   * own role). A hook that signs in through the API should set `as` on its state to another role,
   * so it gets a context of its own.
   */
  request: APIRequestContext;
  baseUrl: string;
  persona?: Persona;
  env: Record<string, string | undefined>;
  /** The run's `{{run.id}}`, for names that must not collide with an earlier run's. */
  runId: string;
  log: (...args: unknown[]) => void;
}

/** Makes a state true. Must be idempotent ("ensure it exists"): it runs on every capture that needs it. */
export type StateSetupHook = (ctx: StateHookContext) => Promise<void> | void;
/** True when the state already holds. Must not change data. */
export type StateCheckHook = (ctx: StateHookContext) => Promise<boolean> | boolean;

/**
 * A module path (resolved relative to the config file, like `signIn`), or the hook itself. A
 * module's `setup`/`check` named export is used for that hook, else its default export.
 */
export type StateHookRef<T> = string | T | { modulePath: string; export?: string };

/** One named data state walkthroughs can `need`, `leave` and `clear`; see `AidaConfig.states`. */
export interface StateConfig {
  /** What's true in the app's data, in plain words (shown by `aida order`). */
  description?: string;
  /** Role to sign in as for this state's hooks. Default: the walkthrough's own persona. */
  as?: string;
  /** Makes the state true; a need with a setup hook can be captured on its own, in any order. */
  setup?: StateHookRef<StateSetupHook>;
  /** Reports whether the state holds; run before a walkthrough that needs it and after one that leaves it. */
  check?: StateHookRef<StateCheckHook>;
}

/** `StateConfig` with its hooks loaded. */
export interface ResolvedStateConfig {
  description?: string;
  as?: string;
  setup?: StateSetupHook;
  check?: StateCheckHook;
}

export interface ModelTiers {
  fast?: string;
  standard?: string;
  deep?: string;
}

export interface BudgetConfig {
  usd?: number;
  tokens?: number;
}

export interface VoiceSettings {
  provider?: string;
  model?: string;
  voiceId?: string;
  speed?: number;
  gapSeconds?: number;
  /** Word -> spoken-form replacements (e.g. "ShopKit" -> "Shop Kit"); see src/voice/types.ts. */
  pronunciation?: PronunciationMap;
  /**
   * USD per character billed by this provider, for budget accounting (see usage/prices.ts
   * `VOICE_PRICES`). `kokoro`/`silent` are free and ignore this; set it for `minimax`/
   * `elevenlabs` to match the actual rate on the account in use. Unset: 0 (reports $0, doesn't
   * trip a budget — set this to get real enforcement for a paid voice provider).
   */
  pricePerChar?: number;
}

/** Page-level masking, applied before every screenshot (see capture/mask.ts). */
export interface MaskConfig {
  /** Default true: scan every screenshot for personal data (emails/phones) and blur matches, even
   * when a step doesn't list the field in its own `mask`. example.com-style domains and the
   * reserved fictional phone ranges are always allowed through, regardless of this setting. */
  personalData?: boolean;
  /** Extra CSS selectors always blurred, independent of the personal-data scan. */
  selectors?: string[];
}

/**
 * Frame-stabilization settings for capture (docs/scope.md "Only rebuild what changed": "A
 * screenshot that moved less than a set threshold is kept."). See capture/frame-diff.ts.
 */
export interface CaptureSettings {
  /**
   * Fraction of pixels (0-1) that may differ (beyond `frameDiffTolerance`) before a frame
   * counts as changed, rather than kept as the previous capture's frame. Default `0.001`
   * (0.1%).
   */
  frameDiffThreshold?: number;
  /** Per-channel (0-255) tolerance before a pixel counts as differing at all. Default `8`. */
  frameDiffTolerance?: number;
  /** Longest a `type` action types visibly, in ms, before filling the rest at once. Default `1500`. */
  maxTypeMs?: number;
  /**
   * Other origins whose fetch/xhr traffic is the app's own, for failure diagnosis (decision 30),
   * e.g. `["https://abc.supabase.co"]` when the app's API lives elsewhere. Without it only
   * `app.baseUrl`'s origin (and a `*SUPABASE_URL` in the environment) counts: analytics, CDNs and
   * other third parties never make a failure look like the app's.
   */
  apiOrigins?: string[];
}

/** `CaptureSettings` with every default filled in (`apiOrigins` stays optional). */
export type ResolvedCaptureSettings = Required<Omit<CaptureSettings, "apiOrigins">> & Pick<CaptureSettings, "apiOrigins">;

/**
 * `aida publish --to <host>` settings (src/publish/**; docs/scope.md "Runs on Node, deploys
 * like any Next.js app", "Safety and trust"; decisions #16-18; build-plan.md M13).
 */
export interface PublishConfig {
  /**
   * Forces videos to blob storage regardless of size, and picks which provider. Unset: blob
   * storage only kicks in when a video exceeds the target host's static-asset limit (e.g.
   * Cloudflare's 25 MiB/file), using that host's default provider.
   */
  videoStorage?: "vercel-blob" | "s3" | "netlify-blobs" | "r2" | "supabase-storage";
  /**
   * The published help site's public address, e.g. "https://help.example.com". Printed guides
   * get a QR code linking to each guide's page (and its video) when this is an absolute http(s)
   * URL; unset, no QR code is printed.
   */
  siteUrl?: string;
}

/**
 * `aida ci` settings (docs/scope.md "Three kinds of change"; build-plan.md M19; decisions #22).
 */
export interface CiConfig {
  /**
   * Exit non-zero when any affected walkthrough is "broken" (capture failed / a check failed).
   * Default false — a docs check shouldn't block an app merge unless the repo owner wants it to;
   * the PR comment still flags broken walkthroughs either way.
   */
  failOnBroken?: boolean;
  /**
   * Set by `aida init --ci --claude` when the optional Claude Code GitHub Action workflow
   * (`.github/workflows/aida-repair.yml`) is installed — lets the PR comment mention the
   * `@claude` comment shortcut alongside the local repair command. Decisions #22: CI itself never
   * calls a model either way.
   */
  claudeAction?: boolean;
  /**
   * `owner/repo` of a separate docs repo, when the help app and walkthroughs live there instead
   * of in the app repo (`aida init --ci --docs-repo <owner/repo>`). Informational here — the
   * generated workflow's own checkout step is what actually fetches it; this just lets the CLI
   * describe the setup accurately. Unset: same-repo docs (the default).
   */
  docsRepo?: string;
}

/**
 * `aida affected` settings (docs/scope.md "Only rebuild what changed" -> "Impact map";
 * build-plan.md M17). `ignore`/`all` extend (never replace) the built-in glob lists in
 * src/impact/glob.ts.
 */
export interface ImpactConfig {
  /**
   * Path to the app repo whose git diff maps to walkthroughs, relative to the config file (or
   * absolute). Unset: the `--app-repo` CLI flag is required instead.
   */
  appRepo?: string;
  /** Explicit app directory within a workspace monorepo (relative to `appRepo`, or absolute) —
   * same as `digest`'s `--app`/`app` option. */
  app?: string;
  /** Extra glob patterns always treated as irrelevant to every walkthrough (docs/tests/etc. are
   * built in; this adds more without disabling the defaults). */
  ignore?: string[];
  /** Extra glob patterns that force "every walkthrough is affected" when matched (lockfiles,
   * the root layout, the auth gate, and db migrations are built in; this adds more). */
  all?: string[];
  /**
   * Fraction of routes (0-1) a changed file must be imported by (via the static import graph)
   * before it's treated as affecting every walkthrough, rather than just the routes that import
   * it. Default 0.6 (60%) — a file imported by more than that share of routes is "shared enough"
   * that per-route precision isn't worth trusting.
   */
  allThreshold?: number;
}

/**
 * Help chat settings (docs/scope.md "Help chat"; "Token efficiency": "help chat answers from
 * retrieved pages" = fast tier; decisions.md #40 "owner's key when self-hosting"). The owner's
 * `ANTHROPIC_API_KEY` env var is the only key source — never put a key in this file.
 */
export interface ChatConfig {
  /** Defaults to `models.fast` (Haiku 4.5) — chat answers are a fast-tier job. */
  model?: string;
  /** Shown when chat can't answer from the docs (scope.md "Truthfulness": "says when it doesn't
   * know, pointing to support"). Plain text or a mailto:/https: URL. */
  supportContact?: string;
  /** Product name the help chat introduces itself with, e.g. "Acme Events". Defaults to the brand
   * name the help app detected. */
  appName?: string;
  /** Origins allowed to call /api/chat cross-origin (the in-app widget's own origin) — the help
   * site's own origin is always allowed. Empty/unset: no cross-origin widget use. */
  allowedOrigins?: string[];
  /** Max pages (whole guides) retrieved per question. Default 4. */
  retrievalLimit?: number;
  /** Hard cap on input tokens sent to the model (retrieved context + question), so one long
   * question/history can't blow the budget. Default 8000. */
  maxInputTokens?: number;
  /** `max_tokens` for the chat completion. Default 1024. */
  maxOutputTokens?: number;
  /** Retrieval score below which an answer is treated as "don't know" and logged to the
   * unanswered-questions store. Default 0.01 (BM25 scores are unbounded; see chat/retrieve.ts). */
  unansweredScoreThreshold?: number;
  /** Requests allowed per IP per minute before /api/chat returns 429. Default 20. */
  rateLimitPerMinute?: number;
  /** Requests allowed across *all* clients per minute, independent of any one client's budget —
   * a floor under `rateLimitPerMinute` so many distinct (or spoofed) client IPs together still
   * can't run the owner's API key up without bound. Default 300. */
  globalRateLimitPerMinute?: number;
  /** Header name to trust as the client's IP, set by the deployment's own reverse proxy (e.g. a
   * load balancer in front of the host's platform headers). When unset, the client IP is taken
   * from the first present platform header among `x-vercel-forwarded-for`, `x-real-ip`,
   * `x-nf-client-connection-ip`, `cf-connecting-ip`, falling back to the *last* hop of
   * `X-Forwarded-For` (the hop the nearest proxy appended) — never the client-controlled first
   * hop. Only set this to a header you know your own infra sets; trusting an arbitrary header
   * here reopens the same spoofing the default avoids. */
  trustProxyHeader?: string;
}

/**
 * Theme colours. Values are any CSS colour (hex, `rgb()`, `hsl()`, `oklch()`) or a bare HSL
 * triplet like `235 55% 42%` (shadcn convention) — wrap with `toCssColor()` (src/theme/color.ts)
 * before use.
 */
export interface BrandColors {
  /** Main brand colour (buttons, links, active nav). */
  primary?: string;
  /** Text on `primary`. */
  primaryForeground?: string;
  /** Second brand colour (highlights, video gradients, badges). */
  accent?: string;
  /** Page canvas. */
  background?: string;
  /** Body text. */
  foreground?: string;
  /** Raised surfaces (cards, popovers). */
  card?: string;
  /** Muted fills. */
  muted?: string;
  /** Secondary text. */
  mutedForeground?: string;
  border?: string;
}

/** Help-app theme, guessed by `extractBrand()` (src/init/brand.ts) or set by hand. `aida theme`
 * and every `aida build` turn it into the help app's `app/brand.css`, `lib/brand.json` and
 * `public/brand/*` (src/theme/write.ts). */
export interface BrandConfig {
  /** Product name, e.g. "Acme Events". */
  name?: string;
  /** Main brand colour (same as `colors.primary`; wins when both are set). */
  primaryColor?: string;
  /** Second brand colour (same as `colors.accent`; wins when both are set). */
  accentColor?: string;
  /** Light theme colours. */
  colors?: BrandColors;
  /** Dark theme overrides; derived from the light theme when unset (never copied from it). */
  dark?: BrandColors;
  /** Path to a logo file, relative to the config file (usually under `public/`). */
  logo?: string;
  /** Logo for dark backgrounds (e.g. a white logo), relative to the config file. */
  logoDark?: string;
  /** Square mark / favicon source, relative to the config file. */
  icon?: string;
  /** Font family name, e.g. "Inter" or "Geist". */
  font?: string;
  /** Stylesheet URL that loads the font (e.g. a Google Fonts css2 URL). */
  fontUrl?: string;
  /** Heading font family name, when different from `font`. */
  headingFont?: string;
  /** Corner radius, e.g. "0.5rem" or "10px". */
  radius?: string;
}

/**
 * The app's own database, for capture safety (decisions #27; src/safety/database.ts). Capture
 * refuses to run when any database setting the app may start with isn't on this machine, unless
 * `throwaway` names that exact database.
 */
export interface AppDatabaseConfig {
  /**
   * The connection URL the capture server is started with (e.g. a demo script's local Postgres).
   * Checked along with the app's env files, not instead of them: see `ignoreEnv`. Read it from
   * the same env/default the start script uses. Never commit a password here.
   */
  url?: string | (() => string | Promise<string>);
  /**
   * Databases that are disposable copies (a Neon or Supabase branch made for capture): exact
   * hostnames, case-insensitive, no wildcards. `host/database` names one database on the host
   * (needed when the app's settings use several databases on it). On a host many customers
   * share (a Supabase pooler, PlanetScale, Prisma, Appwrite Cloud) write `user@host`, e.g.
   * `"postgres.<project-ref>@aws-0-us-east-1.pooler.supabase.com"`. A setting whose `options`
   * routes elsewhere needs that too: `"<host>?endpoint=<id>"` (Neon), `"<user>@<pooler>?reference=<ref>"`
   * (Supabase). `#<fingerprint>` (as the refusal prints it) names any of these without the
   * hostname. Also `AIDA_THROWAWAY_DATABASE_HOST` (comma-separated). Never carries over: any
   * other database is refused again.
   */
  throwaway?: string | string[];
  /**
   * Env settings the capture server doesn't use because it's started with `url` instead, each
   * bound to what it points at now: `file:VARIABLE@<host>` (`user@host` on a shared host) or
   * `file:VARIABLE#<fingerprint>` (as the refusal prints it; keeps the hostname out of a public
   * repo), e.g. `".env:DATABASE_URL#f864fef6bc"`, `"process.env:DATABASE_URL@db.example.com"`.
   * Only honoured together with `url`. Covers exactly those settings pointing at exactly those
   * databases: changing one to point elsewhere, or a new file or variable pointing off this
   * machine, is refused again. Also the acknowledgement for a secrets manager that injects
   * settings at run time (`"doppler.yaml#<fingerprint>"`, an op:// reference's setting).
   */
  ignoreEnv?: string[];
}

/** The shape a user's `aida.config.ts`/`.mjs` default-exports (via `defineConfig`). */
export interface AidaConfig {
  app: {
    baseUrl: string;
    /**
     * The app's own directory (where its `.env*` files and `.next/` live), relative to the config
     * file. Capture safety reads the app's database setting from here. Unset: `impact.app`, then
     * `impact.appRepo`, then the config file's parent directory when it has a package.json (the
     * `aida init` layout, `<app>/help/aida.config.ts`). See src/safety/database.ts.
     */
    dir?: string;
    /** The database the app captures against; see `AppDatabaseConfig`. */
    database?: AppDatabaseConfig;
    /**
     * Set to `"dry-run"` to confirm the app sends no real emails, texts or chat messages while
     * aida captures it (e.g. its email mode is set to block). Silences the outbound-sender
     * warning (src/safety/outbound.ts). Doesn't cover payments: see `allowLivePayments`.
     */
    outbound?: "dry-run";
    /**
     * Capture refuses when a live Stripe key (`sk_live_`, `rk_live_`) is set. Lists the exact
     * settings to allow anyway, each bound to the key it holds by a one-way fingerprint (as the
     * refusal prints it, never the key): `file:VARIABLE#<fingerprint>`
     * (`".env.local:STRIPE_SECRET_KEY#1a2b3c4d5e"`) or `process.env:VARIABLE#<fingerprint>`. Only
     * when the capture server doesn't use them, or capture really should run against live
     * payments. A different key in that setting is refused again.
     */
    allowLivePayments?: string[];
  };
  /** Directory of `*.yaml` walkthrough files, relative to the config file. */
  walkthroughsDir: string;
  /** Outline cards file (`aida outline`), relative to the config file. Default `outline.yaml`
   * next to `walkthroughsDir`. */
  outline?: string;
  /** The app brief (`aida brief`, decision 33): what the app is for, who uses it, its words and
   * rules. Relative to the config file. Default `app-brief.md` next to it. */
  brief?: string;
  /** Where rendered output (site, videos, pdfs) is written. Default `help/`. */
  outDir?: string;
  /** Where intermediate build artifacts (capture frames, manifests) are written. Default `.build`. */
  buildDir?: string;
  viewport?: Viewport;
  deviceScaleFactor?: number;
  locale?: string;
  timezone?: string;
  /** Default `"reduce"` — most real apps' CSS/JS honour it, which keeps captures still for crisper frames. */
  reducedMotion?: "no-preference" | "reduce";
  /**
   * ISO-8601 timestamp to pin `page.clock` to for the whole run. Unset by
   * default: only set this when the app under capture needs a fixed "now" to
   * produce deterministic output, and the fixture/seed data it reads is
   * itself fixed (not computed relative to the real wall clock at seed time,
   * which a pinned clock could drift out of sync with).
   */
  clock?: string;
  /** Allow write (click/type) steps to run against a non-local baseUrl. Default false. */
  allowWrites?: boolean;
  signIn?: SignInAdapterRef;
  database?: DatabaseAdapterRef;
  /**
   * Named data states (kebab-case) that walkthroughs `need`, `leave` and `clear` (decision 28),
   * with optional `setup`/`check` hooks. A state with no entry here can still be left by a
   * walkthrough; `aida order` shows the capture order these imply.
   */
  states?: Record<string, StateConfig>;
  voice?: VoiceSettings;
  models?: ModelTiers;
  budget?: BudgetConfig;
  /** Who the help site is written for, e.g. ["office-staff", "judges"]. Site-copy only. */
  readers?: string[];
  /**
   * What readers call each sign-in role. Keys are the role ids walkthroughs use in
   * `start.signed_in_as` / `start.persona.role`; values are the words pages, PDFs and procedures
   * print ("Sign in as **an organiser**"), either a string or `{ name }`:
   *
   *   roles: { admin: "an organiser", office_staff: { name: "office staff" } }
   *
   * Reader-facing only: capture still signs in with the role id. A role with no entry falls back
   * to a matching phrase in the walkthrough's `for:`, then a matching `readers` entry, then the id
   * with `_`/`-` turned into spaces.
   */
  roles?: Record<string, string | { name: string }>;
  /** Page-level masking before every screenshot; see `MaskConfig`. */
  mask?: MaskConfig;
  /** Help-app theme (colours/logo/font); see `BrandConfig`. */
  brand?: BrandConfig;
  /** Deploy target hint for `aida publish` / docs, e.g. "vercel", "netlify", "amplify". */
  host?: string;
  /**
   * Path to a Next.js help app (containing `content/docs` and `public/`), relative to the
   * config file. When set, `aida build`'s index stage copies each walkthrough's page into
   * `<helpApp>/content/docs/<id>/` and writes `search-index.json`/`llms.txt` into
   * `<helpApp>/public/`. Unset: pages/index artifacts stay under `outDir` only.
   */
  helpApp?: string;
  /** Frame-stabilization settings for capture; see `CaptureSettings`. */
  capture?: CaptureSettings;
  /** Printable-guide PDF settings (docs/scope.md "Printable guides"); see `PdfSettings`. */
  pdf?: PdfSettings;
  /** `aida publish --to <host>` settings; see `PublishConfig`. */
  publish?: PublishConfig;
  /** Help chat settings; see `ChatConfig`. */
  chat?: ChatConfig;
  /** `aida affected` settings; see `ImpactConfig`. */
  impact?: ImpactConfig;
  /** `aida ci` settings; see `CiConfig`. */
  ci?: CiConfig;
}

/** Settings for the `pdf` build stage / `aida pdf` command (src/pdf/**). */
export interface PdfSettings {
  /** Page size for every generated PDF. Default "A4". */
  paper?: "A4" | "Letter";
}

/** `AidaConfig` with adapters resolved to functions/objects and paths made absolute. */
export interface ResolvedConfig extends Omit<AidaConfig, "signIn" | "database" | "capture" | "states"> {
  /** Absolute path to the directory the config file lives in. */
  configDir: string;
  walkthroughsDir: string;
  outDir: string;
  buildDir: string;
  signIn?: SignInAdapter;
  database?: DatabaseAdapter;
  /** `states` with every hook loaded (see states/hooks.ts). */
  states?: Record<string, ResolvedStateConfig>;
  /**
   * `capture` with defaults resolved by `loadConfig()`. Left optional (rather than
   * `Required<CaptureSettings>`) so a `ResolvedConfig` built by hand (as several tests do,
   * without going through `loadConfig()`) still type-checks without it; call sites that need
   * concrete settings should go through `resolveCaptureSettings()` below.
   */
  capture?: CaptureSettings;
  /** `impact.appRepo`/`impact.app`, when set, resolved to absolute paths by `loadConfig()`. */
  impact?: ImpactConfig;
}

/** Fills in defaults for any settings `config.capture` left unset — use at capture call sites
 * instead of reading `config.capture` directly, since a hand-built `ResolvedConfig` (as in
 * several tests) may omit it entirely. */
export function resolveCaptureSettings(capture: CaptureSettings | undefined): ResolvedCaptureSettings {
  return {
    frameDiffThreshold: capture?.frameDiffThreshold ?? DEFAULT_CAPTURE_SETTINGS.frameDiffThreshold,
    frameDiffTolerance: capture?.frameDiffTolerance ?? DEFAULT_CAPTURE_SETTINGS.frameDiffTolerance,
    maxTypeMs: capture?.maxTypeMs ?? DEFAULT_CAPTURE_SETTINGS.maxTypeMs,
    ...(capture?.apiOrigins ? { apiOrigins: [...capture.apiOrigins] } : {}),
  };
}

export const DEFAULT_CAPTURE_SETTINGS: Required<Omit<CaptureSettings, "apiOrigins">> = {
  frameDiffThreshold: 0.001,
  frameDiffTolerance: 8,
  maxTypeMs: 1500,
};

export const DEFAULT_MODEL_TIERS: Required<ModelTiers> = {
  fast: "claude-haiku-4-5",
  standard: "claude-sonnet-5",
  deep: "claude-opus-5-5",
};
