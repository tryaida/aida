import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatQaReport, runQa, toJson } from '../../src/qa/run.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'aida-qa-run-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('runQa', () => {
  it('scans a single clean text file and passes', async () => {
    const file = path.join(dir, 'README.md')
    await writeFile(file, 'Contact jane@example.com or call 0491 570 156.', 'utf8')
    const report = await runQa(file, { video: false, captions: false })
    expect(report.ok).toBe(true)
  })

  it('fails when a directory contains a real email and a secret, across its reader-facing deliverables', async () => {
    await writeFile(path.join(dir, 'README.md'), 'Contact jane.doe@gmail.com for help.', 'utf8')
    await writeFile(path.join(dir, 'search-index.json'), '{"AWS_SECRET_KEY": "AKIAABCDEFGHIJKLMNOP"}', 'utf8')
    const report = await runQa(dir, { video: false, captions: false })
    expect(report.ok).toBe(false)
    const failing = report.checks.filter((c) => !c.ok)
    expect(failing.length).toBeGreaterThanOrEqual(2)
  })

  it('ignores internal bookkeeping json/sidecar files, even when they contain epoch ids', async () => {
    await writeFile(path.join(dir, 'index.mdx'), 'Nothing sensitive, jane@example.com', 'utf8')
    // A page's hash sidecar, a render file-hash cache, and a capture manifest — all arbitrary
    // extension-wise (.json) but never reader-facing; `capturedAt`-style epoch ms numbers in
    // them used to get flagged as phone numbers and fail an otherwise-clean page.
    await writeFile(
      path.join(dir, 'index.mdx.aida.json'),
      JSON.stringify({ header: '9f8c7a6b5e4d3c2b1a0f9e8d7c6b5a49', capturedAtMs: 1771234567890 }),
      'utf8',
    )
    await writeFile(path.join(dir, '.aida-hash-cache.json'), JSON.stringify({ 'frame-0001.png': '1703123456789' }), 'utf8')
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ capturedAtMs: 1703123456789 }), 'utf8')
    const report = await runQa(dir, { video: false, captions: false })
    expect(report.ok).toBe(true)
  })

  it('reports no-input for a directory with nothing scannable', async () => {
    await writeFile(path.join(dir, 'notes.txt'), 'irrelevant extension', 'utf8')
    const report = await runQa(dir, {})
    expect(report.ok).toBe(false)
    expect(report.checks[0].check).toBe('qa:no-input')
  })

  it('skips node_modules and .git when scanning a directory', async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(path.join(dir, 'node_modules'), { recursive: true })
    await writeFile(path.join(dir, 'node_modules', 'secret.md'), 'AKIAABCDEFGHIJKLMNOP', 'utf8')
    await writeFile(path.join(dir, 'ok.md'), 'Nothing sensitive, jane@example.com', 'utf8')
    const report = await runQa(dir, { video: false, captions: false })
    expect(report.ok).toBe(true)
  })
})

describe('formatQaReport', () => {
  it('formats a passing report with no problem lines', () => {
    const text = formatQaReport({
      ok: true,
      target: 'x',
      checks: [{ check: 'secrets:scan', ok: true, details: 'no findings', problems: [] }],
    })
    expect(text).toContain('QA PASSED')
    expect(text).toContain('pass — secrets:scan')
  })

  it('indents problems under a failing check', () => {
    const text = formatQaReport({
      ok: false,
      target: 'x',
      checks: [{ check: 'secrets:scan', ok: false, details: '1 finding(s)', problems: ['AWS access key id: AKIA…MNOP'] }],
    })
    expect(text).toContain('FAIL — secrets:scan')
    expect(text).toContain('    - AWS access key id')
  })

  it('caps output at maxLines', () => {
    const problems = Array.from({ length: 100 }, (_, i) => `problem ${i}`)
    const text = formatQaReport(
      { ok: false, target: 'x', checks: [{ check: 'c', ok: false, details: 'd', problems }] },
      { maxLines: 10 },
    )
    expect(text.split('\n').length).toBeLessThanOrEqual(11)
    expect(text).toContain('truncated')
  })

  it('produces valid JSON via toJson', () => {
    const report = { ok: true, target: 'x', checks: [] }
    expect(JSON.parse(toJson(report))).toEqual(report)
  })
})
