# Model tiers on agents that can't switch models

Claude Code reads the `model:` line in each file in this directory and runs that subagent on the
named tier (haiku/sonnet/opus). Codex and some other coding agents run every subagent on the same
single model the person picked — there's no per-subagent model switch.

That's fine. Nothing in AIDA's skills *requires* a tier change to work:

- The subagent boundaries (one per app area, one per walkthrough, a fresh context for review)
  still do their job of keeping each context small, even when every subagent happens to run on
  the same model.
- The tier label in each `SKILL.md` and agent file is a hint for hosts that can act on it, not a
  hard dependency. Treat "fast" as "keep this prompt short and the output compact" and "deep" as
  "this one deserves the most capable model you have" even when you can't literally switch.
- On a single-model host, the real savings still come from the token rules in
  `skills/references/tokens.md`: small inputs, engine commands instead of re-deriving their
  output, and subagents that never see more than their own slice of the job.

If your host agent exposes any way to request more or less effort per subagent (a reasoning-effort
flag, a cheaper/pricier model alias, a context-window hint), map fast/standard/deep onto that
instead of ignoring the tier line entirely.
