import { describe, expect, it } from 'vitest'
import { checkPersonalData, scanEmails, scanPhones } from '../../src/qa/pii.js'

describe('scanEmails', () => {
  it('allows example.com/.org/.net addresses', () => {
    expect(scanEmails('contact alice@example.com or bob@example.org or carol@example.net')).toEqual([])
  })

  it('flags a real-looking domain', () => {
    const problems = scanEmails('contact jane.doe@gmail.com for help')
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/jane.doe@gmail.com/)
  })

  it('respects an allowlist', () => {
    expect(scanEmails('contact ok@realcorp.test for help', { allowlistEmails: ['ok@realcorp.test'] })).toEqual([])
  })
})

describe('scanPhones', () => {
  it('allows the ACMA reserved Australian mobile fiction range', () => {
    expect(scanPhones('call 0491 570 156 for support')).toEqual([])
    expect(scanPhones('call 0491570159 for support')).toEqual([])
  })

  it('allows the ACMA reserved Australian landline fiction range', () => {
    expect(scanPhones('call (02) 5550 1234 for support')).toEqual([])
    expect(scanPhones('call 07 7010 4321 for support')).toEqual([])
  })

  it('allows the NANP 555-01xx fiction range', () => {
    expect(scanPhones('call (555) 555-0199 or 555-0123')).toEqual([])
  })

  it('allows the Ofcom UK drama fiction range (07700 900000-900999)', () => {
    expect(scanPhones('call 07700 900123 for support')).toEqual([])
    expect(scanPhones('call +44 7700 900999 for support')).toEqual([])
  })

  it('flags a real-looking phone number', () => {
    const problems = scanPhones('call 0412 345 678 now')
    expect(problems).toHaveLength(1)
  })

  it('ignores a pure unformatted 13+ digit run (millisecond epoch timestamp)', () => {
    expect(scanPhones('capturedAtMs: 1703123456789')).toEqual([])
    expect(scanPhones('id 1703123456789012')).toEqual([])
  })

  it('still flags a 13-digit number if it is actually formatted like a phone number', () => {
    // Spaces/dashes mean it was written as a phone number, not a raw epoch/id — still flag it.
    const problems = scanPhones('call +61 491 234 567 89 now')
    expect(problems.length).toBeGreaterThanOrEqual(1)
  })

  it('ignores a UUID even though it contains a phone-shaped digit run', () => {
    expect(scanPhones('request id 9f8c7a6b-1234-4a2b-8c3d-123456789012')).toEqual([])
  })

  it('ignores a long hex hash fragment (sha/git-style id)', () => {
    expect(scanPhones('hash 9f8c7a6b5e4d3c2b1a0f9e8d7c6b5a49')).toEqual([])
  })
})

describe('checkPersonalData', () => {
  it('passes safe fake data', () => {
    const result = checkPersonalData('Email jane@example.com or call 0491 570 156.')
    expect(result.ok).toBe(true)
    expect(result.problems).toEqual([])
  })

  it('fails on a real email and phone number together', () => {
    const result = checkPersonalData('Email jane.doe@gmail.com or call 0412 345 678.')
    expect(result.ok).toBe(false)
    expect(result.problems.length).toBeGreaterThanOrEqual(2)
  })
})
