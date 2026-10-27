import type { VoiceProvider } from './types.js'
import { createSilentProvider } from './providers/silent.js'
import { createKokoroProvider } from './providers/kokoro.js'
import { createMiniMaxProvider } from './providers/minimax.js'
import { createElevenLabsProvider } from './providers/elevenlabs.js'

export type ProviderName = 'silent' | 'kokoro' | 'minimax' | 'elevenlabs'

const factories: Record<ProviderName, () => VoiceProvider> = {
  silent: () => createSilentProvider(),
  kokoro: () => createKokoroProvider(),
  minimax: () => createMiniMaxProvider(),
  elevenlabs: () => createElevenLabsProvider(),
}

/** Looks up a provider by id. Throws on an unknown name (typo'd config is a build error). */
export function getProvider(name: string): VoiceProvider {
  const factory = factories[name as ProviderName]
  if (!factory) {
    throw new Error(`Unknown voice provider "${name}". Known: ${Object.keys(factories).join(', ')}`)
  }
  return factory()
}

export function listProviders(): ProviderName[] {
  return Object.keys(factories) as ProviderName[]
}
