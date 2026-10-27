import { describe, expect, it } from 'vitest'
import { getProvider, listProviders } from '../../src/voice/registry.js'

describe('registry', () => {
  it('lists the known providers', () => {
    expect(listProviders().sort()).toEqual(['elevenlabs', 'kokoro', 'minimax', 'silent'])
  })

  it('returns a provider with the matching id', () => {
    expect(getProvider('silent').id).toBe('silent')
    expect(getProvider('minimax').id).toBe('minimax')
    expect(getProvider('elevenlabs').id).toBe('elevenlabs')
  })

  it('throws on an unknown provider name', () => {
    expect(() => getProvider('nope')).toThrow(/Unknown voice provider/)
  })
})

describe('provider availability without keys', () => {
  it('minimax reports unavailable when MINIMAX_API_KEY is unset', async () => {
    const original = process.env.MINIMAX_API_KEY
    delete process.env.MINIMAX_API_KEY
    try {
      const result = await getProvider('minimax').available()
      expect(result.available).toBe(false)
      expect(result.reason).toMatch(/MINIMAX_API_KEY/)
    } finally {
      if (original !== undefined) process.env.MINIMAX_API_KEY = original
    }
  })

  it('elevenlabs reports unavailable when ELEVENLABS_API_KEY is unset', async () => {
    const original = process.env.ELEVENLABS_API_KEY
    delete process.env.ELEVENLABS_API_KEY
    try {
      const result = await getProvider('elevenlabs').available()
      expect(result.available).toBe(false)
      expect(result.reason).toMatch(/ELEVENLABS_API_KEY/)
    } finally {
      if (original !== undefined) process.env.ELEVENLABS_API_KEY = original
    }
  })

  it('neither available() check throws', async () => {
    expect(await getProvider('minimax').available()).toBeDefined()
    expect(await getProvider('elevenlabs').available()).toBeDefined()
  })
})
