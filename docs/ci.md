# Keeping docs current in CI

Companion to docs/scope.md "Keeping docs current" -> "Three kinds of change" and
docs/decisions.md #8, #22-25. This is the practical setup guide; those docs are the agreed design.

## The base workflow (always keyless)

`aida init --ci` writes `.github/workflows/aida.yml` into the app repo. It never calls a
model and never needs a secret beyond the workflow's own automatic `GITHUB_TOKEN`:

```
aida init --ci \
  --ci-start-command "npm run dev" \
  --ci-uses tryaida/aida@main
```

Three jobs:

- **`aida-ci`** (every PR push): maps the diff to affected walkthroughs (`aida affected`),
  re-captures them, diffs the new screenshots against what's already published, and posts/updates
  one PR comment. Each affected walkthrough is tiered:
  - **cosmetic** — capture passed, whether or not the screenshot moved. The comment says it needs
    no action; it refreshes and publishes automatically once the PR merges.
  - **broken** — a step's locator or a check failed. The comment shows the trimmed failure and
    the exact command to fix it locally:
    ```
    claude -p "load the aida-repair skill and fix the 'add-entry' walkthrough (--config help/aida.config.ts); its failure report is at .build/add-entry/ci/capture/failure.json"
    ```
  - **new** — a page route added in this diff that no walkthrough's manifest visits yet. The
    comment lists the route with the `aida-write` command to draft a walkthrough for it,
    labelled `docs:new`:
    ```
    claude -p "load the aida-write skill and draft a walkthrough for the new page at /sponsors (--config help/aida.config.ts); label the PR docs:new"
    ```

  By default a broken walkthrough does **not** fail the check (`ci.failOnBroken: false` in
  `aida.config.ts`) — a docs check shouldn't block an app merge unless the repo owner wants it
  to. Set `ci: { failOnBroken: true }` to make it a hard gate.

- **`aida-prune-previews`** (PR closed, same repo only): removes that PR's folder from the
  `aida-previews` branch the screenshot diffs were pushed to.

- **`aida-publish`** (push to `main` — a merged PR): re-captures whatever that push affected and
  republishes the refreshed screenshots/pages straight into the help app's `content/docs/`/
  `public/`, then commits with the workflow's own `GITHUB_TOKEN`. No video render here — that's a
  `aida build` concern, run locally or in its own job, not a CI concern (decisions #22: "CI does
  deterministic work only"). This is the "cosmetic... publishes on merge" half of the three-tier
  design; nobody is asked, because nothing semantic changed.

Security (see `packages/engine/src/init/ci.ts`'s module doc for the full rationale): triggers are
`pull_request` and `push`, never `pull_request_target`; fork PRs always get a read-only token from
GitHub regardless of the `permissions:` block, so the push/comment step is skipped for them and
the diff is uploaded as an Actions artifact instead; every `uses:` is pinned to a major version.

## Optional: Claude Code repair (`--claude`)

```
aida init --ci --claude
```

Writes a **second**, separate workflow, `.github/workflows/aida-repair.yml`. The base workflow
above stays keyless either way — this one is opt-in, and runs on the repo owner's own Claude
subscription, not a shared API key (decisions #22).

**Setup:**

1. On a machine with Claude Code and a Pro/Max plan: `claude setup-token`. This prints an OAuth
   token (not an API key).
2. Add it as a repository secret named `CLAUDE_CODE_OAUTH_TOKEN` (repo Settings -> Secrets and
   variables -> Actions).

**How it triggers:** an `@claude` comment on a PR (or the `docs:repair` label — both
configurable via `--claude-trigger-phrase`/`--claude-label`, or `writeClaudeRepairWorkflow`'s
options). A `check-access` job runs first and checks, via the GitHub API, that the commenter or
labeller has write access to the repo — a random commenter on a public repo can't spend the
owner's Claude usage. Only then does the `claude` job check out the PR branch and run
[`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action), prompted to
load the `aida-repair` skill (for a broken walkthrough) or `aida-write` (for a new one,
labelled `docs:new`), fix/draft it, and commit to the PR branch.

Never triggers on `pull_request_target` — only `issue_comment` and `pull_request: labeled`, both
of which keep GitHub's normal read-only token for fork PRs.

## Optional: a separate docs repo (`--docs-repo`)

```
aida init --ci --docs-repo acme/aida-docs
```

For a team that keeps walkthroughs/the help app in their own repo instead of inside the app repo.
The generated `aida.yml` checks out that repo to `.aida-docs` in every job that needs it, and
`--config` defaults to `.aida-docs/help/aida.config.ts`. `aida.config.ts` itself also gets
`ci: { docsRepo: "acme/aida-docs" }` so the CLI's own output reflects the setup.

**Token setup** (either works — `secrets.AIDA_DOCS_TOKEN`):

- **Fine-grained personal access token**: GitHub Settings -> Developer settings -> Fine-grained
  tokens -> scope it to just the docs repo, with Contents: Read and write (and Pull requests:
  Read and write if the Claude Code repair workflow also targets the docs repo). Add it as
  `AIDA_DOCS_TOKEN` in the **app repo's** secrets (that's where the workflow runs).
- **GitHub App installation token**: create a minimal GitHub App installed only on the docs repo
  (Contents: Read & write), generate an installation access token in a prior step (e.g.
  `actions/create-github-app-token`), and pass that as `AIDA_DOCS_TOKEN` instead of a long-lived
  PAT — rotates automatically per run, the usual trade-off against a PAT's simplicity.

Same-repo docs (the default, no `--docs-repo`) needs neither of these — it uses the automatic
`GITHUB_TOKEN` throughout.

## `aida ci` flags reference

| Flag | Does |
| --- | --- |
| `--config <path>` | aida.config.ts/.mjs — works whether it's in the app repo or a checked-out docs repo (`.aida-docs/...`) |
| `--base <ref>` / `--head <ref>` | Git refs to diff |
| `--pr <number>` | Posts/updates the PR comment |
| `--publish` | Merge-behaviour hook: re-capture + republish what `--base..--head` affected, no PR/comment (what `aida-publish` runs) |
| `--fork-pr` | Skip push/comment, write a local artifact instead (the generated workflow sets this automatically for fork PRs) |
| `--dry-run` | Write the comment + images to a local dir instead of calling GitHub |
| `--baseline disk\|git` | Where "before" screenshots come from — the checkout on disk (default) or `git show <base>:...` |

`config.ci` (in `aida.config.ts`):

| Field | Default | Does |
| --- | --- | --- |
| `failOnBroken` | `false` | Exit non-zero when any walkthrough is tier "broken" |
| `claudeAction` | `false` | Shows the `@claude` comment shortcut alongside the local repair/draft command |
| `docsRepo` | unset | `owner/repo` of a separate docs repo, for the CLI's own output only — the workflow's checkout step is what actually fetches it |
