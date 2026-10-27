---
name: aida-discover
description: Map an app's routes, roles, on-screen labels, and likely user tasks before planning walkthroughs. Fans out one read-only subagent per app area (route group or feature) using AIDA digest. Use when AIDA's entry skill needs to understand a new app, or when re-scanning after big route changes.
---

# aida-discover

Model tier: **fast**. Short, structured, high-volume lookups — route summaries, label
extraction, glossary terms. Don't use a bigger model here; if results look thin, that's a sign to
narrow the area, not to upgrade the tier.

## What it does

Reads the target app's repo (never the running app yet — that's capture's job) and returns a
compact map an orchestrator or planner can act on without reading the whole codebase.

## How

1. Identify app areas: usually one per route group, top-level feature folder, or role-gated
   section (e.g. `/dashboard/competitors`, `/dashboard/entries`, admin vs. office-staff screens).
2. Launch **one read-only subagent per area**, in parallel. Each subagent:
   - Runs `aida digest --area <path>` (see `aida digest --help` for flags) to get that area's
     routes, roles, and on-screen labels without reading the whole repo.
   - Returns only the summary shape below, nothing else — no code excerpts, no reasoning.
3. Collect the summaries. Merge duplicate roles/labels across areas. Hand the merged map, not
   the raw per-area output, to `aida-understand` (it writes the app brief), then to `aida-plan`.
   Discover says what's on screen; understand says what it's for.

## Summary shape (what each subagent returns)

```yaml
area: dashboard/competitors
routes:
  - path: /dashboard/competitors
    role: office_staff          # who can reach it, if gated
  - path: /dashboard/competitors/[id]
    role: office_staff
labels:                          # on-screen strings worth naming a task after
  - "Add New Competitor"
  - "Search competitors..."
likely_tasks:
  - "Add a new competitor"
  - "Find an existing competitor"
notes: "Competitors are shared across shows — search before creating."
```

Keep each area's summary under roughly 200 tokens. If an area is big enough to blow that budget,
split it into two subagents rather than writing a longer summary.

## Token rules

See `references/tokens.md`. Never read a full file tree; never return source excerpts in the
summary — labels and task names only. One digest call (or targeted read) per area, not per route.

## Engine command this assumes

`aida digest --area <path>` — a compact map of routes, roles, and labels for one area. Run
`aida digest --help` for the exact flags.
