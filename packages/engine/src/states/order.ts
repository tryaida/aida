// Capture order for walkthroughs that change data (decision 28). One pure function,
// `planCaptureRun`, decides which walkthroughs run, in what order, how each need is met and where
// the database may be reset; `aida capture`, `build`, `ci` and `order` all use it, so the order
// lives in the walkthrough files instead of whoever runs the capture.
//
// Rules:
// - A need whose config state has a `setup` hook is met by the hook: no ordering edge.
// - Otherwise every walkthrough in the run that `leaves` it runs before the one that needs it,
//   and the needer runs before anything in the run that `clears` it.
// - A need with no hook and no provider in the run is an error naming the candidates; with
//   `withDeps`, providers are pulled in (transitively) from `all`. A need whose state has only a
//   `check` and no provider is met by the check at run time (data the app already has).
// - Cycles are an error that prints the cycle.
// - A walkthrough no order works for (a need nothing provides, a cycle) is `blocked`: it stays in
//   the plan with the reason, never runs, and the rest of the run still goes ahead.
// - With `withDeps`, a provider that would itself undo the needer's data (it clears one of the
//   needer's needs, or needs data the needer leaves) is only pulled in when no other one exists.
// - Unrelated walkthroughs keep the input order. A dependency chain runs together, starting where
//   its first member was listed, so an unrelated walkthrough never sits inside a chain where a
//   reset would have to be skipped.
// - A database reset never falls between a provider and a walkthrough relying on its data: it
//   happens at most before the first walkthrough of a chain.

/** The fields of a walkthrough the planner reads. */
export interface PlanInput {
  walkthrough: string;
  needs?: string[];
  leaves?: string[];
  clears?: string[];
  validate?: { database?: unknown[] };
}

/** The part of the config the planner reads: which states have hooks. */
export interface PlanConfig {
  states?: Record<string, { setup?: unknown; check?: unknown }>;
}

/**
 * When the database is reset:
 * - `database-checks`: before walkthroughs with `validate.database` checks (local `capture`/`build`)
 * - `every`: before every walkthrough (`aida ci`)
 * - `none`: never (`--no-reset`, or no database adapter)
 * Either way a reset only ever happens at the start of a dependency chain.
 */
export type ResetPolicy = "database-checks" | "every" | "none";

export interface PlanOptions {
  /** Pull in walkthroughs that leave a needed state, transitively, from `all`. */
  withDeps?: boolean;
  /** Default `none`. */
  reset?: ResetPolicy;
}

/** How one need is met: a config setup hook, earlier walkthroughs in the run, or a check of existing data. */
export interface PlannedNeed {
  state: string;
  metBy: "hook" | "walkthrough" | "check" | "nothing";
  /** For `walkthrough`: the walkthroughs in this run that leave it, all of which run first. */
  providers: string[];
}

export interface PlannedWalkthrough<W extends PlanInput = PlanInput> {
  walkthrough: W;
  id: string;
  /** `selected`: asked for. `dependency`: pulled in by `withDeps`. */
  reason: "selected" | "dependency";
  /** For a dependency: which walkthrough needed which state it leaves. */
  pulledInFor: { walkthrough: string; state: string }[];
  needs: PlannedNeed[];
  resetBefore: boolean;
  /** Why the reset is or isn't where the policy alone would put it. */
  resetNote?: string;
  /** Set when no order works for it (a need nothing provides, a cycle): the problem's message.
   * A blocked walkthrough never runs; anything relying on its data is skipped in turn. */
  blocked?: string;
}

export interface PlanProblem {
  kind: "missing-provider" | "cycle";
  message: string;
  /** The walkthroughs involved: the needer, or every walkthrough on the cycle. */
  walkthroughs: string[];
  state?: string;
  /** For `missing-provider`: walkthroughs anywhere in `all` that leave the state. */
  candidates?: string[];
}

export interface CapturePlan<W extends PlanInput = PlanInput> {
  /** Run order, blocked walkthroughs included (marked `blocked`; walkthroughs on a cycle last). */
  walkthroughs: PlannedWalkthrough<W>[];
  problems: PlanProblem[];
}

interface Edge {
  from: string;
  to: string;
  /** Plain-words reason, used when printing a cycle. */
  why: string;
}

/**
 * Plans a capture run: `selected` in the order given, `all` every walkthrough that could be
 * pulled in as a dependency. Pure and deterministic: the same inputs give the same plan.
 */
export function planCaptureRun<W extends PlanInput>(
  selected: W[],
  all: W[],
  config: PlanConfig,
  opts: PlanOptions = {},
): CapturePlan<W> {
  const states = config.states ?? {};
  const hasSetup = (state: string): boolean => Boolean(states[state]?.setup);
  const hasCheck = (state: string): boolean => Boolean(states[state]?.check);
  const leavesOf = (w: PlanInput): string[] => w.leaves ?? [];

  // 1. The run set: selected (deduped by id), then dependencies in the order they're pulled in.
  const run: W[] = [];
  const meta = new Map<string, { index: number; reason: "selected" | "dependency"; pulledInFor: { walkthrough: string; state: string }[] }>();
  const add = (w: W, reason: "selected" | "dependency"): boolean => {
    if (meta.has(w.walkthrough)) return false;
    meta.set(w.walkthrough, { index: run.length, reason, pulledInFor: [] });
    run.push(w);
    return true;
  };
  for (const w of selected) add(w, "selected");

  // A provider that undoes the needer's own data can never run before it: it clears one of the
  // needer's needs (so it must run after it), or needs data the needer leaves.
  const undoesNeeder = (p: PlanInput, w: PlanInput): boolean => {
    const needs = (w.needs ?? []).filter((s) => !hasSetup(s));
    if ((p.clears ?? []).some((s) => needs.includes(s))) return true;
    return (p.needs ?? []).some((s) => !hasSetup(s) && leavesOf(w).includes(s));
  };

  if (opts.withDeps) {
    for (let i = 0; i < run.length; i++) {
      const w = run[i];
      for (const state of w.needs ?? []) {
        if (hasSetup(state)) continue;
        if (run.some((p) => p.walkthrough !== w.walkthrough && leavesOf(p).includes(state))) continue;
        const candidates = all.filter((p) => p.walkthrough !== w.walkthrough && leavesOf(p).includes(state));
        // First one (in `all` order) that works; else the first, and the cycle is reported below.
        const candidate = candidates.find((p) => !undoesNeeder(p, w)) ?? candidates[0];
        if (!candidate) continue;
        add(candidate, "dependency");
        meta.get(candidate.walkthrough)!.pulledInFor.push({ walkthrough: w.walkthrough, state });
      }
    }
  }

  // 2. How each need is met, and the ordering edges that implies.
  const problems: PlanProblem[] = [];
  const needsById = new Map<string, PlannedNeed[]>();
  const edges: Edge[] = [];
  for (const w of run) {
    const planned: PlannedNeed[] = [];
    for (const state of w.needs ?? []) {
      if (hasSetup(state)) {
        planned.push({ state, metBy: "hook", providers: [] });
        continue;
      }
      const providers = run.filter((p) => p.walkthrough !== w.walkthrough && leavesOf(p).includes(state)).map((p) => p.walkthrough);
      if (providers.length > 0) {
        planned.push({ state, metBy: "walkthrough", providers });
        for (const p of providers) edges.push({ from: p, to: w.walkthrough, why: `${w.walkthrough} needs ${state}, which ${p} leaves` });
      } else if (hasCheck(state)) {
        planned.push({ state, metBy: "check", providers: [] });
      } else {
        planned.push({ state, metBy: "nothing", providers: [] });
        const candidates = all.filter((p) => p.walkthrough !== w.walkthrough && leavesOf(p).includes(state)).map((p) => p.walkthrough);
        const leavesItself = leavesOf(w).includes(state);
        problems.push({
          kind: "missing-provider",
          state,
          walkthroughs: [w.walkthrough],
          candidates,
          message:
            candidates.length > 0
              ? `${w.walkthrough} needs ${state}, but nothing else in this run leaves it: add ${orList(candidates)} to the run, or use --with-deps`
              : leavesItself
                ? bothNeedsAndLeaves(w.walkthrough, state)
                : `${w.walkthrough} needs ${state}, but no walkthrough leaves it and config states has no setup or check for it`,
        });
      }
      // Whatever is met without a setup hook can be undone by a walkthrough that clears it, so
      // the needer goes first.
      for (const k of run) {
        if (k.walkthrough !== w.walkthrough && (k.clears ?? []).includes(state)) {
          edges.push({ from: w.walkthrough, to: k.walkthrough, why: `${k.walkthrough} clears ${state}, which ${w.walkthrough} needs` });
        }
      }
    }
    needsById.set(w.walkthrough, planned);
  }

  // 3. Chains: walkthroughs joined by "relies on data from" edges (not clears edges, which only
  // order things). Each chain is ranked by its earliest member so it runs where it was listed.
  const chainOf = unionFind(run.map((w) => w.walkthrough));
  for (const e of edges) if (isRelianceEdge(e, needsById)) chainOf.union(e.from, e.to);
  const chainRank = new Map<string, number>();
  for (const w of run) {
    const root = chainOf.find(w.walkthrough);
    const idx = meta.get(w.walkthrough)!.index;
    chainRank.set(root, Math.min(chainRank.get(root) ?? Infinity, idx));
  }

  // 4. Topological order (Kahn), ties broken by (chain rank, own index). A cycle's members are
  // blocked and set aside (last in the plan); everything else is still ordered and runs.
  const key = (id: string): number[] => [chainRank.get(chainOf.find(id))!, meta.get(id)!.index];
  const allIds = run.map((w) => w.walkthrough);
  const blocked = new Map<string, string>();
  const onCycle = new Set<string>();
  let order = topoSort(allIds, edges, key);
  while (!order.ok) {
    const message = `these walkthroughs need each other's data, so no order works: ${order.cycle.map((e) => e.why).join("; ")}. Give one of the states a setup hook in config states, or split a walkthrough`;
    problems.push({ kind: "cycle", walkthroughs: order.cycle.map((e) => e.from), message });
    for (const e of order.cycle) {
      onCycle.add(e.from);
      if (!blocked.has(e.from)) blocked.set(e.from, message);
    }
    order = topoSort(
      allIds.filter((id) => !onCycle.has(id)),
      edges.filter((e) => !onCycle.has(e.from) && !onCycle.has(e.to)),
      key,
    );
  }
  for (const p of problems) {
    if (p.kind === "missing-provider") for (const id of p.walkthroughs) if (!blocked.has(id)) blocked.set(id, p.message);
  }
  const compareKeys = (a: string, b: string): number => {
    const ka = key(a);
    const kb = key(b);
    return ka[0] - kb[0] || ka[1] - kb[1];
  };
  const orderIds = [...order.ids, ...allIds.filter((id) => onCycle.has(id)).sort(compareKeys)];

  // 5. Resets: at most before the first walkthrough of a chain, never between a provider and a
  // walkthrough relying on its data. Worked out over the walkthroughs that will run, so a blocked
  // one never takes its chain's reset with it.
  const liveEdges = edges.filter((e) => !blocked.has(e.from) && !blocked.has(e.to) && isRelianceEdge(e, needsById));
  const liveChainOf = unionFind(allIds);
  for (const e of liveEdges) liveChainOf.union(e.from, e.to);
  const pos = new Map(orderIds.map((id, i) => [id, i]));
  const protectedBy = new Map<number, { provider: string; consumer: string }>();
  for (const e of liveEdges) {
    for (let i = pos.get(e.from)! + 1; i <= pos.get(e.to)!; i++) {
      if (!protectedBy.has(i)) protectedBy.set(i, { provider: e.from, consumer: e.to });
    }
  }
  const policy = opts.reset ?? "none";
  const wants = (w: PlanInput): boolean =>
    policy === "every" ? true : policy === "database-checks" ? Boolean(w.validate?.database?.length) : false;
  const byId = new Map(run.map((w) => [w.walkthrough, w]));
  const chainMembers = new Map<string, string[]>();
  for (const id of orderIds) {
    if (blocked.has(id)) continue;
    const root = liveChainOf.find(id);
    chainMembers.set(root, [...(chainMembers.get(root) ?? []), id]);
  }

  const walkthroughs = orderIds.map((id, i): PlannedWalkthrough<W> => {
    const w = byId.get(id)!;
    const m = meta.get(id)!;
    const why = blocked.get(id);
    if (why !== undefined) {
      return { walkthrough: w, id, reason: m.reason, pulledInFor: m.pulledInFor, needs: needsById.get(id) ?? [], resetBefore: false, blocked: why };
    }
    const members = chainMembers.get(liveChainOf.find(id))!;
    const isFirst = members[0] === id;
    const chainWants = members.filter((m) => wants(byId.get(m)!));
    let resetBefore = false;
    let resetNote: string | undefined;
    const guard = protectedBy.get(i);
    if (isFirst && chainWants.length > 0) {
      if (guard) {
        resetNote = `no reset: runs between ${guard.provider} and ${guard.consumer}, which rely on the same data`;
      } else {
        resetBefore = true;
        if (!wants(w)) resetNote = `reset moved here, the start of its chain, for ${orList(chainWants, "and")}`;
      }
    } else if (!isFirst && wants(w)) {
      const reliedOn = (needsById.get(id) ?? []).flatMap((n) => n.providers);
      resetNote = `no reset: keeps the data ${reliedOn.length > 0 ? orList(reliedOn, "and") : orList(members.slice(0, members.indexOf(id)), "and")} left`;
    }
    return {
      walkthrough: w,
      id,
      reason: m.reason,
      pulledInFor: m.pulledInFor,
      needs: needsById.get(id) ?? [],
      resetBefore,
      ...(resetNote ? { resetNote } : {}),
    };
  });

  return { walkthroughs, problems };
}

/** A provider -> needer edge (data reliance), as opposed to a needer -> clearer edge (order only). */
function isRelianceEdge(e: Edge, needsById: Map<string, PlannedNeed[]>): boolean {
  return (needsById.get(e.to) ?? []).some((n) => n.metBy === "walkthrough" && n.providers.includes(e.from));
}

/** The message for a walkthrough that needs a state only it leaves (shared with `aida validate`). */
export function bothNeedsAndLeaves(walkthrough: string, state: string): string {
  return `${walkthrough} both needs and leaves ${state}: it can't make its own starting data, and no other walkthrough leaves it; give config states.${state} a setup hook (or a check, if the demo data already has it), or write a walkthrough that leaves it`;
}

function orList(items: string[], word = "or"): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${word} ${items[items.length - 1]}`;
}

function unionFind(ids: string[]): { find(id: string): string; union(a: string, b: string): void } {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  return {
    find,
    union(a, b) {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(rb, ra);
    },
  };
}

type TopoResult = { ok: true; ids: string[] } | { ok: false; cycle: Edge[] };

function topoSort(ids: string[], edges: Edge[], key: (id: string) => number[]): TopoResult {
  const indegree = new Map(ids.map((id) => [id, 0]));
  const out = new Map<string, Edge[]>(ids.map((id) => [id, []]));
  for (const e of edges) {
    indegree.set(e.to, indegree.get(e.to)! + 1);
    out.get(e.from)!.push(e);
  }
  const compare = (a: string, b: string): number => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
  };
  const ready = ids.filter((id) => indegree.get(id) === 0);
  const result: string[] = [];
  while (ready.length > 0) {
    ready.sort(compare);
    const id = ready.shift()!;
    result.push(id);
    for (const e of out.get(id)!) {
      indegree.set(e.to, indegree.get(e.to)! - 1);
      if (indegree.get(e.to) === 0) ready.push(e.to);
    }
  }
  if (result.length === ids.length) return { ok: true, ids: result };
  return { ok: false, cycle: findCycle(ids.filter((id) => !result.includes(id)), edges) };
}

/** One cycle among `remaining` (every one of which is on or behind a cycle), as its edges. */
function findCycle(remaining: string[], edges: Edge[]): Edge[] {
  const inRemaining = new Set(remaining);
  const out = new Map<string, Edge[]>();
  for (const e of edges) {
    if (inRemaining.has(e.from) && inRemaining.has(e.to)) out.set(e.from, [...(out.get(e.from) ?? []), e]);
  }
  // Every node Kahn couldn't place still has an incoming edge from another unplaced node, so
  // walking backwards along incoming edges always comes back to a node already seen.
  const incoming = new Map<string, Edge>();
  for (const [, list] of out) for (const e of list) if (!incoming.has(e.to)) incoming.set(e.to, e);
  const seen: string[] = [];
  let at = remaining[0];
  while (!seen.includes(at)) {
    seen.push(at);
    at = incoming.get(at)!.from;
  }
  // `at` is on the cycle: collect it going backwards, then reverse into forward order.
  const cycle: Edge[] = [];
  let cur = at;
  do {
    const e = incoming.get(cur)!;
    cycle.push(e);
    cur = e.from;
  } while (cur !== at);
  return cycle.reverse();
}

/** Thrown by commands that can't start a run because no capture order works. */
export class CapturePlanError extends Error {
  constructor(public readonly problems: PlanProblem[]) {
    super(problems.map((p) => `error: ${p.message}`).join("\n"));
    this.name = "CapturePlanError";
  }
}

/** Why a walkthrough in a run can't be captured, and whose failure it comes from. */
export interface BlockedInfo {
  /** `blocked: <plan problem>` or `skipped: needs <state>, which <provider> didn't leave`. */
  reason: string;
  /** The providers in this run whose failure blocks it; empty for a plan problem. */
  providers: string[];
  /** Walkthroughs whose failure looked like an app bug (decision 30) this block comes from,
   * directly or through a chain of dependants. A dependant inherits the provider's app tier. */
  appBugIn: string[];
}

/**
 * Tracks outcomes during a run so a walkthrough whose provider failed is skipped with a reason
 * instead of capturing a screen built on missing data.
 */
export class CaptureRunTracker {
  private readonly outcomes = new Map<string, { ok: boolean; appBugIn: string[] }>();

  /**
   * Records whether a walkthrough succeeded; a skipped one counts as not succeeded. `category` is
   * the failure's suspected owner (a provider failing as "app" passes that on to its dependants);
   * `appBugIn` records a blocked walkthrough's inherited app bug.
   */
  record(id: string, ok: boolean, opts: { category?: string; appBugIn?: string[] } = {}): void {
    const appBugIn = ok ? [] : (opts.appBugIn ?? (opts.category === "app" ? [id] : []));
    this.outcomes.set(id, { ok, appBugIn });
  }

  /** Why `item` can't run (a plan problem, or a provider that failed), or undefined when it can. */
  blocked(item: Pick<PlannedWalkthrough, "needs" | "blocked">): BlockedInfo | undefined {
    if (item.blocked) return { reason: `blocked: ${item.blocked}`, providers: [], appBugIn: [] };
    for (const need of item.needs) {
      if (need.metBy !== "walkthrough") continue;
      if (need.providers.some((p) => this.outcomes.get(p)?.ok === true)) continue;
      const failed = need.providers.filter((p) => this.outcomes.get(p)?.ok === false);
      const providers = failed.length > 0 ? failed : need.providers;
      const appBugIn = [...new Set(providers.flatMap((p) => this.outcomes.get(p)?.appBugIn ?? []))];
      return { reason: `skipped: needs ${need.state}, which ${orList(providers)} didn't leave`, providers, appBugIn };
    }
    return undefined;
  }

  /** `blocked(item)?.reason`. */
  skipReason(item: Pick<PlannedWalkthrough, "needs" | "blocked">): string | undefined {
    return this.blocked(item)?.reason;
  }
}

/** "blocked by a possible app bug in <provider>": the line a dependant of an app-bug failure gets. */
export function appBugBlockReason(appBugIn: string[]): string {
  return `blocked by a possible app bug in ${orList(appBugIn, "and")}`;
}
