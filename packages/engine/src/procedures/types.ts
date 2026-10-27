// Shared types for the engine's procedures builder (scope.md "Agent connector (MCP server)":
// `get_procedure` "returns structured steps an agent can follow"; build-plan.md M15 step 1).
// A procedure is the structured, agent-readable form of one published walkthrough.

export interface ProcedureStep {
  n: number;
  title: string;
  /** Plain text instruction for this step — the walkthrough's `page_text` (markdown stripped) or,
   * failing that, its `caption`. */
  instruction: string;
  /** URL to this step's annotated screenshot, relative to the help app's site root
   * (e.g. "/screenshots/add-competitor/step-01.png"), when one was captured. */
  screenshot?: string;
  /** Seconds into the walkthrough's rendered video this step begins, when a render exists. */
  videoTimeSec?: number;
}

/**
 * Another way to do the task (decisions 34, 37): where it starts, its own steps, and the main step
 * it joins — or none, for a way that runs to its own end. Only paths whose capture passed are
 * listed.
 */
export interface ProcedurePath {
  id: string;
  /** e.g. "From the attendee's page". */
  title: string;
  /** One plain sentence: when to use this way. */
  when: string;
  start: {
    /** Path this way starts on, e.g. "/attendees/[id]" or "/payments". */
    page: string;
  };
  /** The path's own steps, numbered from 1: its opening steps, or every step when it runs alone. */
  steps: ProcedureStep[];
  /** The main step (`Procedure.steps[].n`) to continue from once these are done; absent when
   * this way runs to its own end (its steps are the whole task). */
  joinsAt?: number;
  /** That main step's title (absent with `joinsAt`). */
  joinsTitle?: string;
  /** The writer's note, when capture found this way saves differently (validation `pathDiffs`). */
  note?: string;
}

export interface Procedure {
  id: string;
  title: string;
  /** The walkthrough page's site URL, e.g. "/how-do-i/payments/record-a-payment"
   * (walkthrough/placement.ts). Missing from a procedures.json written before pages were nested —
   * readers fall back to `/<id>`. */
  url?: string;
  /** Who the walkthrough is for (Walkthrough.for), when set. */
  for?: string;
  start: {
    /** Path the walkthrough starts on, e.g. "/competitors". */
    page?: string;
    /** The persona's role id to sign in as (`start.persona.role` / `signed_in_as`), e.g.
     * "office_staff". Stable: agent connectors match on it. */
    role?: string;
    /** The same role in readers' words (config `roles`), e.g. "office staff" — what to show a
     * person. Missing from a procedures.json written before M26: fall back to `role`. */
    roleName?: string;
  };
  steps: ProcedureStep[];
  /** Unique URL paths this walkthrough's steps touched during capture (`StepImpact.urls`,
   * origin stripped) — chat's currentPath boost matches against these in addition to
   * `start.page` (docs/scope.md "Help chat": "boosts docs whose walkthrough start.page or
   * impact routes match"). */
  impactRoutes?: string[];
  /** ISO timestamp this procedure's page was last checked against the real app. */
  lastChecked?: string;
  /** Other ways to start this task, each joining `steps` part-way (decision 34). */
  paths?: ProcedurePath[];
}

export interface BuildProceduresResult {
  procedures: Procedure[];
  /** Absolute path written to, when `outFile` was given. */
  outFile?: string;
}
