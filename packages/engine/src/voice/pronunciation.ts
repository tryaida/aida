import type { PronunciationMap } from './types.js'

export const EMPTY_PRONUNCIATION: PronunciationMap = { version: '0', replacements: {} }

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Apply word -> spoken-form replacements before synthesis (e.g. "ShopKit" -> "Shop Kit").
 * Matches whole words only, longest keys first so multi-word keys aren't shadowed by
 * shorter overlapping ones, and is case-sensitive (callers that want case-insensitive
 * matching should provide variants explicitly).
 */
export function applyPronunciation(text: string, map: PronunciationMap | undefined): string {
  if (!map || !map.replacements || Object.keys(map.replacements).length === 0) return text
  const keys = Object.keys(map.replacements).sort((a, b) => b.length - a.length)
  const pattern = new RegExp(`\\b(?:${keys.map(escapeRegExp).join('|')})\\b`, 'g')
  return text.replace(pattern, (match) => map.replacements[match] ?? match)
}
