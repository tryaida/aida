// A `{{data}}` placeholder left raw in a reader-facing file (M35): the last line of defence behind
// `aida validate`'s unresolved-placeholder error and the output builders' display resolution
// (walkthrough/display.ts). Matches the MDX-escaped form (`\{\{x\}\}`) pages write too.
import { qaCheck, type QaCheckResult } from './types.js'

const RAW = /\\?\{\\?\{\s*([\w.]+)\s*\\?\}\\?\}/g

export function checkPlaceholders(content: string): QaCheckResult {
  const found = [...new Set([...content.matchAll(RAW)].map((m) => `{{${m[1]}}}`))]
  if (found.length === 0) return qaCheck('text:placeholder', true, 'no raw {{placeholders}}')
  return qaCheck(
    'text:placeholder',
    false,
    `${found.length} raw placeholder(s) printed as written`,
    found.slice(0, 5).map((p) => `${p} printed as written: give it a value under the walkthrough's \`data:\``),
  )
}
