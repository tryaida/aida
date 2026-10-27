import { describe, expect, it } from 'vitest'
import { checkSecrets, scanSecrets } from '../../src/qa/secrets.js'

describe('scanSecrets', () => {
  it('flags an AWS access key', () => {
    expect(scanSecrets('key = AKIAABCDEFGHIJKLMNOP')).toHaveLength(1)
  })

  it('flags an Anthropic key', () => {
    expect(scanSecrets('ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789')).toHaveLength(1)
  })

  it('flags an OpenAI key', () => {
    expect(scanSecrets('OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789')).toHaveLength(1)
  })

  it('flags a GitHub token', () => {
    expect(scanSecrets('token: ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toHaveLength(1)
  })

  it('flags a JWT-like token', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    expect(scanSecrets(jwt)).toHaveLength(1)
  })

  it('flags a generic high-entropy KEY= assignment', () => {
    expect(scanSecrets('STRIPE_SECRET_KEY=zQ8pL2vN9xR4tK7mB1cW6fH3jD0sA5e')).toHaveLength(1)
  })

  it('does not flag plain prose or low-entropy placeholder values', () => {
    expect(scanSecrets('This paragraph talks about API keys and secret tokens, in general terms.')).toEqual([])
    expect(scanSecrets('API_KEY=your-api-key-here')).toEqual([])
  })

  it('respects an allowlist', () => {
    expect(scanSecrets('key = AKIAABCDEFGHIJKLMNOP', { allowlist: ['AKIAABCDEFGHIJKLMNOP'] })).toEqual([])
  })

  it('redacts the value in the problem string', () => {
    const [problem] = scanSecrets('key = AKIAABCDEFGHIJKLMNOP')
    expect(problem).not.toContain('AKIAABCDEFGHIJKLMNOP')
  })
})

describe('checkSecrets', () => {
  it('passes clean text', () => {
    expect(checkSecrets('Nothing sensitive here.').ok).toBe(true)
  })

  it('fails text with a secret', () => {
    expect(checkSecrets('AKIAABCDEFGHIJKLMNOP').ok).toBe(false)
  })
})

describe('scanSecrets: tokens that reach failure reports', () => {
  it('flags Stripe secret, restricted and test keys', () => {
    expect(scanSecrets('sk_live_abcdefghij1234567890')).toHaveLength(1)
    expect(scanSecrets('rk_live_abcdefghij1234567890')).toHaveLength(1)
    expect(scanSecrets('sk_test_abcdefghij1234567890')).toHaveLength(1)
  })

  it('flags a Bearer token but not the phrase "Bearer token"', () => {
    expect(scanSecrets('Authorization: Bearer abcdefghijklmnop1234567890')).toHaveLength(1)
    expect(scanSecrets('Send a Bearer token in the header.')).toEqual([])
  })

  it('flags the password in a connection string, not placeholders', () => {
    const [problem] = scanSecrets('DATABASE=postgresql://owner:hunter2secret@db.local:5432/app')
    expect(problem).toMatch(/password in a connection string/)
    expect(problem).not.toContain('hunter2secret')
    expect(scanSecrets('postgresql://owner:****@db.local/app')).toEqual([])
    expect(scanSecrets('postgresql://owner:<password>@db.local/app')).toEqual([])
  })
})

describe('scanSecrets: more credential shapes (security review)', () => {
  const hit = (text: string): void => expect(scanSecrets(text, { minEntropy: 99 })).toHaveLength(1)
  const miss = (text: string): void => expect(scanSecrets(text)).toEqual([])

  it('flags password assignments, not placeholders or prose', () => {
    hit('DB_PASSWORD=hunter2')
    hit('https://app.test/login?user=ada&password=hunter2')
    hit('ADMIN_PASSWORD: "hunter2"')
    miss('DB_PASSWORD=***')
    miss('DB_PASSWORD=${DB_PASSWORD}')
    miss('password=<your password>')
    miss('Password: at least 8 characters, one number.')
    miss('Forgot your password? Reset it from the sign-in page.')
  })

  it('flags Basic auth credentials, not "Basic" in prose', () => {
    hit('Authorization: Basic YWRhOmh1bnRlcjI=')
    hit('sent Basic dXNlcjpwYXNzd29yZDE=')
    miss('Basic information about your club')
    miss('Choose the Basic plan to start.')
  })

  it('flags Cookie and Set-Cookie header values, not the word cookie', () => {
    hit('Cookie: session=abc123; theme=dark')
    hit('set-cookie: sid=s%3Aabcdef; Path=/; HttpOnly')
    miss('We use a cookie to remember you.')
    miss('Cookie: preferences')
  })

  it('flags Supabase secret, Google, Slack, GitHub fine-grained and AWS keys', () => {
    hit('sb_secret_AbCdEf0123456789xyzQRS')
    hit('AIzaSyA1234567890abcdefghijklmnopqrstuv')
    hit('xoxb-1234567890-abcdefghij')
    hit('github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuv')
    hit('ASIAABCDEFGHIJKLMNOP')
  })

  it('does not flag a Supabase publishable key or near-misses', () => {
    miss('sb_publishable_AbCdEf0123456789xyzQRS')
    miss('AIza is a prefix')
    miss('xoxo-hugs')
  })
})
