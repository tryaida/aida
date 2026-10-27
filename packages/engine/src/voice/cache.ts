// Content-hash cache for synthesized narration clips. Unchanged lines never re-synthesize —
// see "Token efficiency" in docs/scope.md: capture/voice/render spend no model tokens and a
// re-run that changed nothing should cost nothing.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const DEFAULT_CACHE_DIR = '.aida-cache/voice'

export interface CacheKeyInput {
  providerId: string
  model?: string
  voice?: string
  speed?: number
  text: string
  pronunciationVersion: string
  /**
   * `provider.settingsKey(...)` — captures the provider's *resolved* effective settings
   * (defaults included: kokoro dtype, elevenlabs stability, minimax sample rate, etc.), so a
   * change to those defaults invalidates affected cache entries instead of silently reusing
   * stale clips synthesized under different settings.
   */
  settingsKey: string
}

/** sha256(provider id + model + voice + speed + text + pronunciation map version + settings), hex. */
export function cacheKey(input: CacheKeyInput): string {
  const payload = JSON.stringify([
    input.providerId,
    input.model ?? '',
    input.voice ?? '',
    input.speed ?? 1,
    input.text,
    input.pronunciationVersion,
    input.settingsKey,
  ])
  return createHash('sha256').update(payload).digest('hex')
}

interface CacheEntryMeta {
  durationMs: number
  ext: 'wav' | 'mp3'
}

function metaPath(cacheDir: string, key: string): string {
  return path.join(cacheDir, `${key}.json`)
}

/** Path a provider should write its audio to for cache entry `key`. Does not create the file. */
export function audioPathFor(cacheDir: string, key: string, ext: 'wav' | 'mp3'): string {
  return path.join(cacheDir, `${key}.${ext}`)
}

export interface CacheHit {
  audioPath: string
  durationMs: number
}

/** Returns the cached clip for `key`, or null on a miss (missing meta or missing audio file). */
export async function getCached(cacheDir: string, key: string): Promise<CacheHit | null> {
  try {
    const meta: CacheEntryMeta = JSON.parse(await readFile(metaPath(cacheDir, key), 'utf8'))
    const audioPath = audioPathFor(cacheDir, key, meta.ext)
    await readFile(audioPath) // throws if missing; cheap existence+readability check
    return { audioPath, durationMs: meta.durationMs }
  } catch {
    return null
  }
}

/** Ensures the cache dir exists, for providers about to write to `audioPathFor(...)`. */
export async function ensureCacheDir(cacheDir: string): Promise<void> {
  await mkdir(cacheDir, { recursive: true })
}

/** Records metadata for an already-written cache entry (audio file written by the caller). */
export async function writeCacheMeta(
  cacheDir: string,
  key: string,
  meta: CacheEntryMeta,
): Promise<void> {
  await writeFile(metaPath(cacheDir, key), JSON.stringify(meta))
}
