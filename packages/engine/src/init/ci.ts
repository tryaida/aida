// Writes `.github/workflows/aida.yml` into the app repo (`aida init --ci`; build-plan.md
// M18). No model, no API keys (decisions #22): the workflow starts the app, then hands straight
// off to the `aida` composite action (action.yml at the aida repo root), which runs
// `aida ci`. Never overwrites an existing workflow file — same no-clobber rule as every other
// `aida init` template file (see copy-template.ts, write-config.ts).
//
// Security (orchestrator review of M18):
//   - Trigger is `pull_request` only, never `pull_request_target` — the latter runs with the
//     base repo's permissions/secrets even for a PR from a fork, which is exactly the "untrusted
//     code with secrets" pattern GitHub's own docs warn against. `pull_request` naturally gets a
//     read-only token for fork PRs, so there's nothing dangerous to opt out of.
//   - Fork PRs: `is-fork` is computed once per run and passed through to the action, which skips
//     the push-to-`aida-previews`/post-comment step and uploads the diff as an Actions artifact
//     instead (see commands/ci.ts `forkPr`). Pruning on close only runs for same-repo PRs, for
//     the same reason — a fork PR's token can't push to `aida-previews` either way.
//   - `permissions:` is minimal and scoped per job: the default job only needs `contents: read`
//     to check out; the push+comment step additionally asks for `contents: write`/
//     `pull-requests: write`, which GitHub silently downgrades back to read-only for a fork PR
//     regardless of this block, so declaring it is safe and only takes effect for same-repo PRs.
//   - Every `uses:` is pinned to a major version tag (`@v4`), never a branch or `@master`.
//   - Nothing is fetched by bare package name at run time: the app wait is an inline Node fetch
//     loop (not `npx --yes wait-on`), and the help app's packages install from its own lockfile
//     via init/help-install.ts, which refuses a registry `aida` (decisions #29). The config's
//     own `import ... from "aida"` always loads the aida being run (config/pin-aida.ts).
//   - No secrets beyond the workflow's own automatic `GITHUB_TOKEN` — nothing to add in repo
//     settings.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface WriteCiWorkflowOptions {
  /** App repo root — the workflow goes at `<appRepo>/.github/workflows/aida.yml`. */
  appRepo: string;
  /** Path to the aida config, relative to the app repo root (or to `.aida-docs/` when
   * `docsRepo` is set). Default "help/aida.config.ts" (same-repo) or
   * ".aida-docs/help/aida.config.ts" (`docsRepo` set). */
  configPath?: string;
  /** Command that starts the app for capture, e.g. "npm run dev". Default "npm run dev". */
  startCommand?: string;
  /** URL the workflow polls (inline Node fetch loop) before capture starts. Default "http://localhost:3000". */
  waitOnUrl?: string;
  /** `owner/repo@ref` for the `uses:` line. Default "tryaida/aida@main" (decisions #25 — the
   * public default, always configurable). */
  uses?: string;
  /** Adds a `services: postgres: ...` block when the app needs a local database to start. */
  postgres?: boolean;
  /**
   * `owner/repo` of a separate docs repo (`aida init --ci --docs-repo <owner/repo>`;
   * build-plan.md M19 item 3). When set, the workflow checks out that repo to `.aida-docs`
   * with `secrets.AIDA_DOCS_TOKEN` (a fine-grained PAT or a GitHub App installation token —
   * see docs/ci.md) alongside the app repo, and `configPath` defaults to a path inside it. The
   * default same-repo setup (`docsRepo` unset) stays the default either way.
   */
  docsRepo?: string;
}

export interface WriteCiWorkflowResult {
  file: string;
  written: boolean;
}

function postgresService(): string {
  return `    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: app
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
`;
}

/** `owner/repo` and `ref` out of a `uses:`-style string (e.g. "tryaida/aida@main"). */
function parseUsesRef(uses: string): { repo: string; ref: string } {
  const at = uses.lastIndexOf("@");
  return at === -1 ? { repo: uses, ref: "main" } : { repo: uses.slice(0, at), ref: uses.slice(at + 1) };
}

/** Checks out the separate docs repo to `.aida-docs` (build-plan.md M19 item 3; docs/ci.md has
 * the token setup). Only added when `docsRepo` is set — same-repo docs (the default) need no
 * extra checkout. */
function docsRepoCheckoutStep(docsRepo: string): string {
  return `      - name: Check out docs repo (${docsRepo})
        uses: actions/checkout@v4
        with:
          repository: ${docsRepo}
          token: \${{ secrets.AIDA_DOCS_TOKEN }}
          path: .aida-docs

`;
}

/**
 * Polls the app URL with Node's own fetch until it answers (any status below 500) or 60 s pass.
 * Replaces `npx --yes wait-on`, which fetched an unpinned package from the registry on every run.
 */
function waitForAppStep(url: string): string {
  return `      - name: Wait for the app to come up
        env:
          AIDA_WAIT_URL: ${JSON.stringify(url)}
        run: |
          node -e '
            const url = process.env.AIDA_WAIT_URL, end = Date.now() + 60000;
            (async () => {
              for (;;) {
                try { if ((await fetch(url)).status < 500) return; } catch {}
                if (Date.now() > end) { console.error("timed out waiting for " + url); process.exit(1); }
                await new Promise((r) => setTimeout(r, 1000));
              }
            })();
          '
`;
}

/** Writes the workflow. No-ops (and reports `written: false`) when the file already exists. */
export function writeCiWorkflow(opts: WriteCiWorkflowOptions): WriteCiWorkflowResult {
  const file = join(opts.appRepo, ".github", "workflows", "aida.yml");
  if (existsSync(file)) {
    return { file, written: false };
  }

  const defaultConfigPath = opts.docsRepo ? ".aida-docs/help/aida.config.ts" : "help/aida.config.ts";
  const configPath = opts.configPath ?? defaultConfigPath;
  const startCommand = opts.startCommand ?? "npm run dev";
  const waitOnUrl = opts.waitOnUrl ?? "http://localhost:3000";
  const uses = opts.uses ?? "tryaida/aida@main";
  const { repo: aidaRepo, ref: aidaRef } = parseUsesRef(uses);
  const docsRepoStep = opts.docsRepo ? docsRepoCheckoutStep(opts.docsRepo) : "";
  const waitStep = waitForAppStep(waitOnUrl);

  const content = `# Written by \`aida init --ci\`. Deterministic PR check — no model, no API keys
# (docs/decisions.md #22-25): affected -> capture -> screenshot diff -> one PR comment. Broken or
# new walkthroughs are flagged with the exact repair command to run locally in Claude Code. On a
# push to main (a merged PR), \`aida-publish\` re-captures whatever that merge affected and
# commits refreshed screenshots/pages straight to main with the workflow's own GITHUB_TOKEN —
# the "cosmetic changes... publish on merge" half of docs/scope.md "Three kinds of change"
# (build-plan.md M19). No video render in CI either way.
#
# Security: pull_request only (never pull_request_target — see init/ci.ts); fork PRs get a
# read-only token automatically, so the push/comment step is skipped for them (is-fork input) and
# the diff is uploaded as an artifact instead; permissions are minimal and scoped per job; every
# action is pinned to a major version; no packages fetched by bare name at run time (the wait
# loop is inline Node, and the help app's packages install from its lockfile with aida as a
# vendored tarball); no secrets beyond the automatic GITHUB_TOKEN${opts.docsRepo ? ", plus secrets.AIDA_DOCS_TOKEN to check out the separate docs repo (docs/ci.md)" : ""}.
name: aida

on:
  pull_request:
    types: [opened, synchronize, reopened, closed]
  push:
    branches: [main]

permissions: {}

jobs:
  aida-ci:
    if: github.event_name == 'pull_request' && github.event.action != 'closed'
    runs-on: ubuntu-latest
    permissions:
      contents: write # downgraded to read-only by GitHub for fork PRs regardless of this line
      pull-requests: write # same — only takes effect for same-repo PRs
${opts.postgres ? postgresService() : ""}    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

${docsRepoStep}      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Install app dependencies
        run: npm ci

      - name: Start the app
        run: ${startCommand} &

${waitStep}
      - name: Check whether this PR is from a fork
        id: fork
        run: echo "is-fork=\${{ github.event.pull_request.head.repo.full_name != github.repository }}" >> "$GITHUB_OUTPUT"

      - uses: ${uses}
        with:
          config: ${configPath}
          app-url: ${waitOnUrl}
          base: \${{ github.event.pull_request.base.sha }}
          head: \${{ github.sha }}
          pr-number: \${{ github.event.pull_request.number }}
          is-fork: \${{ steps.fork.outputs.is-fork }}
          github-token: \${{ secrets.GITHUB_TOKEN }}

  aida-prune-previews:
    # Only for same-repo PRs — a fork PR's token can't push to aida-previews either way, and
    # pull_request (never pull_request_target) means this always runs with a read-only token for
    # a fork PR regardless.
    if: github.event_name == 'pull_request' && github.event.action == 'closed' && github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
        with:
          ref: aida-previews
      - name: Remove this PR's preview folder
        run: |
          rm -rf "pr-\${{ github.event.pull_request.number }}"
          git add -A
          git diff --cached --quiet || git -c user.email=aida-ci@users.noreply.github.com -c user.name=aida-ci commit -m "prune previews for closed PR #\${{ github.event.pull_request.number }}"
          git push origin aida-previews

  aida-publish:
    # Merge-behaviour hook (build-plan.md M19): runs once per push to main, never for a PR — by
    # the time code is on main it's already reviewed, so this needs no comment/approval, just a
    # refresh of what's already published. Installs aida from its own pinned checkout
    # (.aida-src), same as the action.yml composite action does from github.action_path —
    # calling the composite action itself only works from inside a pull_request job, not here.
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2

${docsRepoStep}      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Check out aida (${uses})
        uses: actions/checkout@v4
        with:
          repository: ${aidaRepo}
          ref: ${aidaRef}
          path: .aida-src

      - name: Install aida
        run: |
          cd .aida-src
          npm ci
          npm run build --workspace packages/engine
          npx playwright install --with-deps chromium

      - name: Install the help app's packages
        run: node .aida-src/packages/engine/dist/init/help-install.js ${configPath}

      - name: Install app dependencies
        run: npm ci

      - name: Start the app
        run: ${startCommand} &

${waitStep}
      - name: Refresh published screenshots/pages (aida ci --publish)
        run: |
          node .aida-src/packages/engine/dist/cli.js ci --publish \\
            --config ${configPath} \\
            --base \${{ github.event.before }} \\
            --head \${{ github.sha }} \\
            --app-url ${waitOnUrl}

      - name: Commit refreshed docs
        run: |
          # Only the docs folder: never the .aida-src checkout or anything else the run created.
          git add -- ${posixDirname(configPath)}
          git diff --cached --quiet || git -c user.email=aida-ci@users.noreply.github.com -c user.name=aida-ci commit -m "aida: refresh published screenshots/pages"
          git push origin main
`;

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
  return { file, written: true };
}

export interface WriteClaudeRepairWorkflowOptions {
  /** App repo root — the workflow goes at `<appRepo>/.github/workflows/aida-repair.yml`. */
  appRepo: string;
  /** Trigger phrase for a PR comment. Default "@claude". */
  triggerPhrase?: string;
  /** Label that also triggers a repair/draft run when applied to a PR. Default "docs:repair". */
  labelTrigger?: string;
}

export interface WriteClaudeRepairWorkflowResult {
  file: string;
  written: boolean;
}

/**
 * Writes `.github/workflows/aida-repair.yml` (`aida init --ci --claude`; build-plan.md M19
 * item 2; docs/decisions.md #22 "Optional: the Claude Code GitHub Action on the user's
 * subscription repairs on request"). Strictly opt-in and separate from `aida.yml` — the base
 * CI workflow stays keyless either way.
 *
 * Uses `anthropics/claude-code-action` authenticated with `claude_code_oauth_token:
 * ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}` (from running `claude setup-token` on the Pro/Max
 * account that should pay for repairs) — never an API key, so this never requires a separate
 * Anthropic billing account on top of the person's existing Claude subscription.
 *
 * Security:
 *   - Triggers are `issue_comment` (a PR comment containing the trigger phrase) and `pull_request`
 *     `labeled` — never `pull_request_target`, which would hand untrusted fork-PR code the base
 *     repo's secrets. Both triggers run the standard `pull_request`/`issue_comment` permission
 *     model, so a fork PR's checkout still only gets a read-only `GITHUB_TOKEN`, same as the main
 *     `aida.yml` workflow.
 *   - A `check-access` job runs first and queries the GitHub API for the comment/label author's
 *     repo permission; the `claude` job only runs when that's `admin`/`write`/`maintain` — a
 *     random commenter on a public repo can't spend the repo owner's Claude usage.
 *   - `CLAUDE_CODE_OAUTH_TOKEN` is the only secret this workflow needs beyond the automatic
 *     `GITHUB_TOKEN` (used only to check the author's permission and to let the action push its
 *     commit) — see docs/ci.md for how to mint it.
 */
export function writeClaudeRepairWorkflow(opts: WriteClaudeRepairWorkflowOptions): WriteClaudeRepairWorkflowResult {
  const file = join(opts.appRepo, ".github", "workflows", "aida-repair.yml");
  if (existsSync(file)) {
    return { file, written: false };
  }

  const triggerPhrase = opts.triggerPhrase ?? "@claude";
  const labelTrigger = opts.labelTrigger ?? "docs:repair";

  const content = `# Written by \`aida init --ci --claude\`. Optional, opt-in (docs/decisions.md #22; see
# docs/ci.md "Optional: Claude Code repair"): the base \`aida.yml\` workflow never calls a
# model — this one does, on request, through the user's own Claude subscription
# (\`claude_code_oauth_token\`, never an API key). Triggered by a "${triggerPhrase}" PR comment or
# the "${labelTrigger}" label; loads the aida-repair or aida-write skill and commits the fix.
#
# Security: issue_comment / pull_request(labeled) only, never pull_request_target — see
# init/ci.ts's module doc. check-access gates the actual run on the commenter/labeller having
# write access to this repo, via the GitHub API, before anything runs Claude.
name: aida repair (optional)

on:
  issue_comment:
    types: [created]
  pull_request:
    types: [labeled]

permissions: {}

jobs:
  check-access:
    if: >-
      (github.event_name == 'issue_comment' && github.event.issue.pull_request != null && contains(github.event.comment.body, '${triggerPhrase}')) ||
      (github.event_name == 'pull_request' && github.event.label.name == '${labelTrigger}')
    runs-on: ubuntu-latest
    permissions:
      pull-requests: read
    outputs:
      has-access: \${{ steps.check.outputs.has-access }}
      pr-number: \${{ steps.check.outputs.pr-number }}
    steps:
      - name: Check the commenter/labeller has write access to this repo
        id: check
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          ACTOR: \${{ github.event.comment.user.login || github.event.sender.login }}
          PR_NUMBER: \${{ github.event.issue.number || github.event.pull_request.number }}
        run: |
          perm=$(gh api "repos/\${{ github.repository }}/collaborators/$ACTOR/permission" --jq .permission || echo "none")
          # Never run Claude (with this repo's token and secrets) on a fork's code.
          head_repo=$(gh api "repos/\${{ github.repository }}/pulls/$PR_NUMBER" --jq .head.repo.full_name || echo "")
          echo "pr-number=$PR_NUMBER" >> "$GITHUB_OUTPUT"
          if [ "$head_repo" != "\${{ github.repository }}" ]; then
            echo "PR head is $head_repo, not this repo: refusing to run on fork code."
            echo "has-access=false" >> "$GITHUB_OUTPUT"
          elif [ "$perm" = "admin" ] || [ "$perm" = "write" ] || [ "$perm" = "maintain" ]; then
            echo "has-access=true" >> "$GITHUB_OUTPUT"
          else
            echo "has-access=false" >> "$GITHUB_OUTPUT"
          fi

  claude:
    needs: check-access
    if: needs.check-access.outputs.has-access == 'true'
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      issues: read
    steps:
      - uses: actions/checkout@v4
        with:
          ref: refs/pull/\${{ needs.check-access.outputs.pr-number }}/head
          fetch-depth: 0

      - uses: anthropics/claude-code-action@v1
        with:
          claude_code_oauth_token: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          trigger_phrase: "${triggerPhrase}"
          prompt: |
            Load the aida-repair skill (for a broken walkthrough) or the aida-write skill
            (for a new walkthrough — label the PR \`docs:new\`) matching what this PR's
            "${triggerPhrase}" comment or "${labelTrigger}" label asked for. Fix or draft exactly
            the walkthrough(s) named there, validate, re-run \`aida capture\` for just that
            walkthrough, then commit the result to this PR branch.
`;

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
  return { file, written: true };
}

/** Directory part of a POSIX path as written into a workflow ("help/aida.config.ts" -> "help"). */
function posixDirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "." : p.slice(0, i);
}
