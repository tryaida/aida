// Minimal WAV helpers: enough to generate silent clips and read back duration without ffprobe.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface WavOptions {
  sampleRate?: number
  channels?: number
  bitsPerSample?: number
}

/** Build a PCM16 WAV buffer of pure silence, `durationMs` long. */
export function silentWavBuffer(durationMs: number, opts: WavOptions = {}): Buffer {
  const sampleRate = opts.sampleRate ?? 24000
  const channels = opts.channels ?? 1
  const bitsPerSample = opts.bitsPerSample ?? 16
  const blockAlign = (channels * bitsPerSample) / 8
  const byteRate = sampleRate * blockAlign
  const numFrames = Math.max(1, Math.round((durationMs / 1000) * sampleRate))
  const dataSize = numFrames * blockAlign

  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16) // fmt chunk size
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(bitsPerSample, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataSize, 40)
  // PCM data left zeroed = silence.
  return buffer
}

/** Parse a WAV buffer's header to compute duration in ms, without external tools. */
export function wavDurationMs(buffer: Buffer): number {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE buffer')
  }
  let offset = 12
  let byteRate = 0
  let dataSize = 0
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4)
    const chunkSize = buffer.readUInt32LE(offset + 4)
    if (chunkId === 'fmt ') {
      byteRate = buffer.readUInt32LE(offset + 16)
    } else if (chunkId === 'data') {
      dataSize = chunkSize
    }
    offset += 8 + chunkSize + (chunkSize % 2)
  }
  if (!byteRate) throw new Error('WAV missing fmt chunk')
  return (dataSize / byteRate) * 1000
}

// --- Pure-JS MP3 duration parsing (no ffprobe required) ---------------------------------

const MPEG1_BITRATES_KBPS: Record<number, number[]> = {
  1: [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], // Layer I
  2: [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], // Layer II
  3: [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], // Layer III
}
const MPEG2_BITRATES_KBPS: Record<number, number[]> = {
  1: [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256], // Layer I
  2: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], // Layer II
  3: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], // Layer III
}
// Keyed by the 2-bit version field: 0b00 = MPEG2.5, 0b10 = MPEG2, 0b11 = MPEG1 (0b01 reserved).
const SAMPLE_RATES_HZ: Record<number, number[]> = {
  0: [11025, 12000, 8000],
  2: [22050, 24000, 16000],
  3: [44100, 48000, 32000],
}

interface Mp3FrameHeader {
  frameLength: number
  samplesPerFrame: number
  sampleRate: number
}

/** Parses one MPEG audio frame header at `offset`, or returns null if it isn't a valid one. */
function parseMp3FrameHeader(buf: Buffer, offset: number): Mp3FrameHeader | null {
  if (offset + 4 > buf.length) return null
  const b1 = buf[offset + 1]
  const b2 = buf[offset + 2]
  if (buf[offset] !== 0xff || (b1 & 0xe0) !== 0xe0) return null // 11-bit frame sync

  const versionBits = (b1 >> 3) & 0x3
  const layerBits = (b1 >> 1) & 0x3
  if (versionBits === 1 || layerBits === 0) return null // reserved

  const bitrateIndex = (b2 >> 4) & 0xf
  const sampleRateIndex = (b2 >> 2) & 0x3
  const padding = (b2 >> 1) & 0x1
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null

  const layer = layerBits === 3 ? 1 : layerBits === 2 ? 2 : 3 // 11->I, 10->II, 01->III
  const isMpeg1 = versionBits === 3
  const bitrateKbps = (isMpeg1 ? MPEG1_BITRATES_KBPS : MPEG2_BITRATES_KBPS)[layer][bitrateIndex - 1]
  const sampleRate = SAMPLE_RATES_HZ[versionBits]?.[sampleRateIndex]
  if (!bitrateKbps || !sampleRate) return null
  const bitrate = bitrateKbps * 1000

  let samplesPerFrame: number
  let frameLength: number
  if (layer === 1) {
    samplesPerFrame = 384
    frameLength = (Math.floor((12 * bitrate) / sampleRate) + padding) * 4
  } else {
    samplesPerFrame = layer === 2 || isMpeg1 ? 1152 : 576
    const factor = isMpeg1 ? 144 : 72
    frameLength = Math.floor((factor * bitrate) / sampleRate) + padding
  }
  if (frameLength < 4) return null
  return { frameLength, samplesPerFrame, sampleRate }
}

/** Bytes to skip for a leading ID3v2 tag, or 0 if there isn't one. */
function skipId3v2Tag(buffer: Buffer): number {
  if (buffer.length >= 10 && buffer.toString('ascii', 0, 3) === 'ID3') {
    const size =
      ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f)
    return 10 + size
  }
  return 0
}

/**
 * If the first frame carries a Xing/Info (LAME) or VBRI (Fraunhofer) VBR header, returns the
 * authoritative total frame count it reports — more accurate than scanning (handles encoder
 * delay/padding) and lets us skip scanning the whole file.
 */
function readVbrFrameCount(buffer: Buffer, frameStart: number, frameLength: number): number | null {
  const end = Math.min(buffer.length, frameStart + frameLength)
  for (const marker of ['Xing', 'Info']) {
    const idx = buffer.indexOf(marker, frameStart, 'ascii')
    if (idx !== -1 && idx < end) {
      if (idx + 8 > buffer.length) return null
      const flags = buffer.readUInt32BE(idx + 4)
      if ((flags & 0x1) === 0 || idx + 12 > buffer.length) return null
      return buffer.readUInt32BE(idx + 8)
    }
  }
  const vbriIdx = buffer.indexOf('VBRI', frameStart, 'ascii')
  if (vbriIdx !== -1 && vbriIdx < end && vbriIdx + 18 <= buffer.length) {
    return buffer.readUInt32BE(vbriIdx + 14)
  }
  return null
}

/** Parse an MP3 buffer's duration in ms by scanning MPEG audio frame headers — no ffprobe. */
export function mp3DurationMs(buffer: Buffer): number {
  let offset = skipId3v2Tag(buffer)
  let totalMs = 0
  let frameCount = 0
  let vbrOverrideMs: number | null = null

  while (offset + 4 <= buffer.length) {
    const header = parseMp3FrameHeader(buffer, offset)
    if (!header) {
      offset += 1
      continue
    }
    if (frameCount === 0) {
      const vbrFrames = readVbrFrameCount(buffer, offset, header.frameLength)
      if (vbrFrames !== null) {
        vbrOverrideMs = (vbrFrames * header.samplesPerFrame / header.sampleRate) * 1000
      }
    }
    totalMs += (header.samplesPerFrame / header.sampleRate) * 1000
    frameCount += 1
    offset += header.frameLength
  }

  if (frameCount === 0) {
    throw new Error('no MPEG audio frames found in buffer')
  }
  return vbrOverrideMs ?? totalMs
}

function looksLikeMp3(buffer: Buffer): boolean {
  if (buffer.length >= 3 && buffer.toString('ascii', 0, 3) === 'ID3') return true
  return parseMp3FrameHeader(buffer, skipId3v2Tag(buffer)) !== null
}

/** Duration of a word-based estimate, used by the silent provider. */
export function estimateSpokenDurationMs(text: string, wordsPerMinute = 150): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length
  const minutes = words / wordsPerMinute
  return Math.max(300, Math.round(minutes * 60_000))
}

async function ffprobeDurationMs(filePath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      filePath,
    ])
    const seconds = Number(stdout.trim())
    if (!Number.isFinite(seconds)) return null
    return seconds * 1000
  } catch {
    return null
  }
}

/**
 * Probe a media file's duration: prefers `ffprobe` from PATH (works for mp3/wav alike),
 * falls back to parsing the file directly (WAV header, or a pure-JS MPEG frame scan for mp3)
 * when ffprobe is unavailable. The pure-JS fallback matters: mp3 providers (elevenlabs,
 * minimax) have already billed the API call by the time this runs, so this must not throw
 * for a well-formed mp3 just because `ffprobe` isn't on PATH.
 */
export async function probeDurationMs(filePath: string, fileBuffer?: Buffer): Promise<number> {
  const viaFfprobe = await ffprobeDurationMs(filePath)
  if (viaFfprobe !== null) return viaFfprobe
  const buffer = fileBuffer ?? (await (await import('node:fs/promises')).readFile(filePath))
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE') {
    return wavDurationMs(buffer)
  }
  if (looksLikeMp3(buffer) || /\.mp3$/i.test(filePath)) {
    return mp3DurationMs(buffer)
  }
  return wavDurationMs(buffer)
}
