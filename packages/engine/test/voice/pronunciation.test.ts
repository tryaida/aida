import { describe, expect, it } from 'vitest'
import { applyPronunciation } from '../../src/voice/pronunciation.js'

describe('applyPronunciation', () => {
  it('replaces whole-word matches with their spoken form', () => {
    const map = { version: '1', replacements: { ShopKit: 'Shop Kit' } }
    expect(applyPronunciation('Welcome to ShopKit!', map)).toBe('Welcome to Shop Kit!')
  })

  it('does not touch substrings that are not whole-word matches', () => {
    const map = { version: '1', replacements: { Shop: 'Shoppe' } }
    expect(applyPronunciation('ShopKit is great', map)).toBe('ShopKit is great')
  })

  it('prefers longer keys over shorter overlapping ones', () => {
    const map = { version: '1', replacements: { Shop: 'nope', ShopKit: 'Shop Kit' } }
    expect(applyPronunciation('ShopKit', map)).toBe('Shop Kit')
  })

  it('returns text unchanged with an empty or missing map', () => {
    expect(applyPronunciation('hello', { version: '1', replacements: {} })).toBe('hello')
    expect(applyPronunciation('hello', undefined)).toBe('hello')
  })

  it('replaces every occurrence', () => {
    const map = { version: '1', replacements: { foo: 'bar' } }
    expect(applyPronunciation('foo and foo again', map)).toBe('bar and bar again')
  })
})
