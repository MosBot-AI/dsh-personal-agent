import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream } from 'node:stream/web'
import { z } from 'zod'
import { readBounded } from '../../../packages/media-comfyui/src/http.js'

async function submissionBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > 1024 * 1024) throw new Error('The acceptance submission exceeded one MiB')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, bytes).toString('utf8')
}

const receiptSchema = z.object({ prompt_id: z.uuidv4() })

/** Forwards one prepared render, drops its successful receipt and observes the returned bytes. */
export async function openMediaRecoveryRelay(upstreamOrigin: string, preparedId: (body: string) => string) {
  let submissions = 0
  let acceptedId: string | undefined
  let failure: string | undefined
  const outputs = new Map<string, { contentHash: string; sizeBytes: number }>()
  const server = createServer(async (request, response) => {
    const path = request.url ?? ''
    try {
      const options = { redirect: 'error', signal: AbortSignal.timeout(60_000) } as const
      if (request.method === 'POST' && path === '/prompt') {
        if (++submissions !== 1) throw new Error('The caller attempted a second submission')
        const body = await submissionBody(request)
        const promptId = preparedId(body)
        const accepted = await fetch(upstreamOrigin + path, {
          ...options, method: 'POST', body, headers: { 'Content-Type': 'application/json' },
        })
        if (!accepted.ok) {
          await accepted.body?.cancel()
          throw new Error('ComfyUI rejected the acceptance submission with HTTP ' + accepted.status)
        }
        const receipt = receiptSchema.safeParse(JSON.parse((await readBounded(accepted, 64 * 1024)).toString('utf8')))
        if (!receipt.success || receipt.data.prompt_id !== promptId) throw new Error('Unexpected ComfyUI prompt receipt')
        acceptedId = promptId
        response.destroy()
        return
      }
      if (request.method !== 'GET' || !/^\/(?:system_stats|queue|object_info\/[^/?]+|history\/[a-f0-9-]+|view\?.+)$/.test(path)) {
        response.writeHead(404).end()
        return
      }
      const upstream = await fetch(upstreamOrigin + path, options)
      response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream' })
      if (!upstream.body) { response.end(); return }
      const source = Readable.fromWeb(upstream.body as ReadableStream<Uint8Array>)
      if (upstream.ok && path.startsWith('/view?')) {
        const hash = createHash('sha256')
        let sizeBytes = 0
        const tap = new Transform({
          transform(chunk: Buffer, _encoding, done) { sizeBytes += chunk.length; hash.update(chunk); done(null, chunk) },
        })
        await pipeline(source, tap, response)
        outputs.set(path, { contentHash: hash.digest('hex'), sizeBytes })
      } else {
        await pipeline(source, response)
      }
    } catch (error) {
      if (request.method === 'POST') failure = error instanceof Error ? error.message : 'The acceptance submission failed'
      if (response.headersSent) response.destroy()
      else response.writeHead(502).end()
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a loopback relay address')
  return {
    origin: `http://127.0.0.1:${address.port}`, outputs,
    get submissions() { return submissions },
    get acceptedId() { return acceptedId },
    get failure() { return failure },
    async close() {
      const closed = new Promise<void>(resolve => server.close(() => resolve()))
      server.closeAllConnections()
      await closed
    },
  }
}
