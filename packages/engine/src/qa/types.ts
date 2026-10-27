// Shared QA types. Every check function (video, captions, personal-data, secrets) returns
// a list of these — small, agent-readable, no raw tool output.
export interface QaCheckResult {
  /** Stable id, e.g. 'video:loudness' or 'secrets:aws'. */
  check: string
  ok: boolean
  /** One-line human-readable detail, shown even when ok. */
  details: string
  /** Short strings describing what's wrong. Empty when ok. Keep each under ~120 chars. */
  problems: string[]
  /** The file checked, when QA ran over a directory or a list of targets. */
  file?: string
}

export function qaCheck(check: string, ok: boolean, details: string, problems: string[] = []): QaCheckResult {
  return { check, ok, details, problems }
}
