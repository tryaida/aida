// One persona everywhere (build-plan.md M26). A walkthrough may say who it signs in as with the
// `start.signed_in_as` shorthand, a full `start.persona`, or both. The loader merges them once,
// in memory, so every command (capture, ci, build, inspect, pages, procedures) reads the same
// `start.persona` object instead of each picking its own precedence. Never written back to YAML:
// `aida edit` and the Studio edit the raw document, not this normalised form.
import type { Persona, Start } from "./types.js";

/** Both fields set and naming different roles: the walkthrough doesn't say who to sign in as. */
export interface PersonaConflict {
  signedInAs: string;
  role: string;
}

export function personaConflict(start: Start | undefined): PersonaConflict | undefined {
  const signedInAs = start?.signed_in_as;
  const role = start?.persona?.role;
  if (signedInAs === undefined || role === undefined || signedInAs === role) return undefined;
  return { signedInAs, role };
}

/**
 * Merges `signed_in_as` and `persona.role` into one answer:
 * - only `signed_in_as`: `persona = { role }`
 * - only `persona.role`: `signed_in_as = role`
 * - both: left as they are (the loader rejects a conflict before this runs)
 *
 * Returns a new `Start`; never mutates its input.
 */
export function normaliseStart(start: Start | undefined): Start | undefined {
  if (!start) return start;
  const role = start.persona?.role ?? start.signed_in_as;
  if (role === undefined) return start;
  const persona: Persona = { ...start.persona, role };
  return { ...start, signed_in_as: role, persona };
}

/** The role a walkthrough signs in as, after normalisation. */
export function personaRole(start: Start | undefined): string | undefined {
  return start?.persona?.role ?? start?.signed_in_as;
}
