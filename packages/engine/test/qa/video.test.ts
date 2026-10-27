// Generates tiny real fixtures with ffmpeg (testsrc + sine tone, and a black clip) in a temp dir,
// then runs the video QA checks against them. Needs ffmpeg/ffprobe on PATH; see src/qa/ffmpeg.ts.
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkVideo } from '../../src/qa/video.js'

const execFileAsync = promisify(execFile)

let dir: string
let goodClip: string
let blackClip: string
let silentClip: string

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'aida-qa-video-'))
  goodClip = path.join(dir, 'good.mp4')
  blackClip = path.join(dir, 'black.mp4')
  silentClip = path.join(dir, 'silent.mp4')

  // ~2s, 320x240 @ 25fps, yuv420p, tv range, with a -16 LUFS-ish sine tone.
  await execFileAsync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
    '-pix_fmt', 'yuv420p', '-color_range', 'tv',
    '-c:v', 'libx264', '-c:a', 'aac',
    goodClip,
  ], { timeout: 60_000 })

  // All-black video, same duration, with audio (so black-frame detection has something to flag).
  await execFileAsync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:size=320x240:duration=2:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-pix_fmt', 'yuv420p', '-color_range', 'tv',
    '-c:v', 'libx264', '-c:a', 'aac',
    blackClip,
  ], { timeout: 60_000 })

  // Video with no audio track at all.
  await execFileAsync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=25',
    '-pix_fmt', 'yuv420p', '-color_range', 'tv',
    '-c:v', 'libx264',
    silentClip,
  ], { timeout: 60_000 })
}, 60_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('checkVideo', () => {
  it('passes resolution, colour, duration and audio-present on the good clip', async () => {
    const results = await checkVideo(goodClip, {
      expectedWidth: 320,
      expectedHeight: 240,
      expectedFps: 25,
      expectedPixFmt: 'yuv420p',
      minDurationSec: 1,
      maxDurationSec: 5,
    })
    const byCheck = Object.fromEntries(results.map((r) => [r.check, r]))
    expect(byCheck['video:resolution-fps'].ok).toBe(true)
    expect(byCheck['video:colour'].ok).toBe(true)
    expect(byCheck['video:duration'].ok).toBe(true)
    expect(byCheck['video:audio-present'].ok).toBe(true)
  })

  it('reports loudness close to the -16 LUFS target', async () => {
    const results = await checkVideo(goodClip, { targetLufs: -16, loudnessToleranceLufs: 3 })
    const loudness = results.find((r) => r.check === 'video:loudness')
    expect(loudness?.ok).toBe(true)
  })

  it('flags black frames in the black clip', async () => {
    const results = await checkVideo(blackClip, { blackMinDurationSec: 0.1 })
    const black = results.find((r) => r.check === 'video:black-frames')
    expect(black?.ok).toBe(false)
    expect(black?.problems.length).toBeGreaterThan(0)
  })

  it('does not flag black frames in the good clip', async () => {
    const results = await checkVideo(goodClip, {})
    const black = results.find((r) => r.check === 'video:black-frames')
    expect(black?.ok).toBe(true)
  })

  it('flags a missing audio stream when required', async () => {
    const results = await checkVideo(silentClip, { requireAudio: true })
    const audio = results.find((r) => r.check === 'video:audio-present')
    expect(audio?.ok).toBe(false)
  })

  it('does not run the loudness check when audio is required=false and absent', async () => {
    const results = await checkVideo(silentClip, { requireAudio: false })
    expect(results.find((r) => r.check === 'video:loudness')).toBeUndefined()
  })

  it('reports a clear failure for a missing file', async () => {
    const results = await checkVideo(path.join(dir, 'nope.mp4'))
    expect(results).toHaveLength(1)
    expect(results[0].ok).toBe(false)
    expect(results[0].check).toBe('video:exists')
  })

  it('flags duration outside the configured range', async () => {
    const results = await checkVideo(goodClip, { minDurationSec: 10, maxDurationSec: 20 })
    const dur = results.find((r) => r.check === 'video:duration')
    expect(dur?.ok).toBe(false)
  })
})
