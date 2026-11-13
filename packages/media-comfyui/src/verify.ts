import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { mediaOutputSchema, type MediaOutput } from '@mosbot-ai/dshpa-plugin-api'
import { z } from 'zod'
import { BackendError } from './http.js'

const run = promisify(execFile)
const formats = {
  'image/png': 'png_pipe',
  'image/jpeg': 'jpeg_pipe',
  'image/webp': 'webp_pipe',
  'video/mp4': 'mov',
  'video/webm': 'matroska',
} as const
export type SupportedMime = keyof typeof formats

const probeSchema = z.object({
  streams: z.array(z.object({ width: z.int().positive(), height: z.int().positive(), codec_name: z.string() })).length(1),
  format: z.object({ duration: z.coerce.number().positive().optional() }),
})

export function identify(bytes: Buffer): SupportedMime | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4'
  if (bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])) && bytes.subarray(0, 64).includes('webm')) return 'video/webm'
  return undefined
}

export async function verifyOutput(bytes: Buffer, assetId: string, signal: AbortSignal): Promise<MediaOutput> {
  if (signal.aborted) throw new BackendError('cancelled')
  const mediaType = identify(bytes)
  if (!mediaType) throw new BackendError('invalid_result')
  let directory: string | undefined
  try {
    directory = await mkdtemp(join(tmpdir(), 'dshpa-media-'))
    const file = join(directory, 'output')
    await writeFile(file, bytes, { mode: 0o600 })
    const options = { signal, timeout: 30_000, maxBuffer: 64 * 1024 }
    const input = ['-max_alloc', '268435456', '-protocol_whitelist', 'file', '-f', formats[mediaType], '-i', file]
    const { stdout } = await run('ffprobe', ['-v', 'error', ...input, '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,codec_name:format=duration', '-of', 'json'], options)
    const probe = probeSchema.parse(JSON.parse(stdout))
    const { width, height, codec_name } = probe.streams[0]!
    const expectedCodec = { 'image/png': 'png', 'image/jpeg': 'mjpeg', 'image/webp': 'webp' }
    if (mediaType in expectedCodec && codec_name !== expectedCodec[mediaType as keyof typeof expectedCodec]) {
      throw new BackendError('invalid_result')
    }
    const durationMs = mediaType.startsWith('video/') ? Math.round((probe.format.duration ?? 0) * 1000) : undefined
    const result = mediaOutputSchema.parse({
      assetId, contentHash: createHash('sha256').update(bytes).digest('hex'),
      mediaType, sizeBytes: bytes.length, width, height, durationMs,
    })
    // Decode the stream. Headers alone do not establish that an output is usable.
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-threads', '1', ...input,
      '-map', '0:v:0', '-f', 'null', '-'], options)
    return result
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
    if (code === 'ENOSPC' || code === 'EDQUOT') throw new BackendError('busy')
    if (code === 'ENOENT') throw new BackendError('provider_unavailable')
    throw new BackendError('invalid_result')
  } finally {
    // Cleanup must not replace the verified result or the primary failure.
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    if (signal.aborted) throw new BackendError('cancelled')
  }
}
