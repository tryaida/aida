import path from 'node:path'
import { audioPathFor, cacheKey, ensureCacheDir, getCached, writeCacheMeta, DEFAULT_CACHE_DIR } from './cache.js'
import { applyPronunciation, EMPTY_PRONUNCIATION } from './pronunciation.js'
import type { NarrateOptions, NarrateReport, NarrateResult, NarrationLine, VoiceProvider } from './types.js'

/**
 * Narrate a batch of lines with `provider`, skipping synthesis for any line whose content
 * hash is already cached. This is the main entry point providers/* are used through.
 */
export async function narrate(
  lines: NarrationLine[],
  provider: VoiceProvider,
  opts: NarrateOptions = {},
): Promise<NarrateReport> {
  const cacheDir = path.resolve(opts.cacheDir ?? DEFAULT_CACHE_DIR)
  const pronunciation = opts.pronunciation ?? EMPTY_PRONUNCIATION
  await ensureCacheDir(cacheDir)

  const results: NarrateResult[] = []
  let synthesized = 0
  let cached = 0
  let charsBilled = 0

  for (const line of lines) {
    const text = applyPronunciation(line.text, pronunciation)
    const model = line.model ?? opts.model
    const voice = line.voice ?? opts.voice
    const speed = line.speed ?? opts.speed

    const key = cacheKey({
      providerId: provider.id,
      model,
      voice,
      speed,
      text,
      pronunciationVersion: pronunciation.version,
      settingsKey: provider.settingsKey({ model, voice, speed }),
    })

    if (!opts.force) {
      const hit = await getCached(cacheDir, key)
      if (hit) {
        cached++
        results.push({ id: line.id, audioPath: hit.audioPath, durationMs: hit.durationMs, cached: true, text })
        continue
      }
    }

    const outPath = audioPathFor(cacheDir, key, provider.ext)
    const synthesizedResult = await provider.synthesize({ text, voice, speed, model, outPath })
    await writeCacheMeta(cacheDir, key, { durationMs: synthesizedResult.durationMs, ext: provider.ext })

    synthesized++
    charsBilled += text.length
    results.push({ id: line.id, audioPath: synthesizedResult.audioPath, durationMs: synthesizedResult.durationMs, cached: false, text })
  }

  return { results, summary: { synthesized, cached, charsBilled } }
}
