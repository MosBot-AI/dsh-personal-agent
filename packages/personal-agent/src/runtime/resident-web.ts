import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'

export const RESIDENT_OWNER_FILE = 'resident-owner.json'
const MAX_OWNER_LINK_BYTES = 4_096

export interface ResidentListener {
  readonly host: '127.0.0.1' | '::1'
  getOrigin(): string
  register(route: { kind: 'exact'; path: string; handler(request: IncomingMessage, response: ServerResponse): void }): () => void
}

export interface ResidentAppReady {
  onReady(callback: () => void): () => void
}

function privateOwnerPath(path: string, kind: 'directory' | 'file'): boolean {
  const entry = lstatSync(path, { throwIfNoEntry: false })
  if (!entry) return false
  if (!(kind === 'directory' ? entry.isDirectory() : entry.isFile() && entry.nlink === 1 && entry.size <= MAX_OWNER_LINK_BYTES)
    || (process.getuid !== undefined && (entry.uid !== process.getuid()
      || (entry.mode & 0o777) !== (kind === 'directory' ? 0o700 : 0o600)))) {
    throw new Error('Resident owner access requires an owner-private path')
  }
  return true
}

function publishOwnerLink(directory: string, origin: string, authenticatedUrl: string, instance: string): () => void {
  const url = new URL(authenticatedUrl)
  if (url.origin !== origin || url.pathname !== '/' || !url.search || url.username || url.password || url.hash) {
    throw new Error('Invalid native resident owner link')
  }
  if (!privateOwnerPath(directory, 'directory')) throw new Error('Resident state directory is unavailable')
  const path = join(directory, RESIDENT_OWNER_FILE)
  privateOwnerPath(path, 'file')
  const bytes = JSON.stringify({ version: 1, pid: process.pid, instance, url: url.href }) + '\n'
  if (Buffer.byteLength(bytes) > MAX_OWNER_LINK_BYTES) throw new Error('Invalid native resident owner link')
  const temporary = join(directory, `.resident-owner-${randomUUID()}.tmp`)
  try {
    const file = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(file, bytes)
      fsyncSync(file)
    } finally {
      closeSync(file)
    }
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
  return () => {
    if (privateOwnerPath(path, 'file') && readFileSync(path, 'utf8') === bytes) rmSync(path)
  }
}

export function attachResidentWeb(options: {
  readonly directory: string
  readonly listener: ResidentListener
  readonly appReady: ResidentAppReady
  readonly authenticatedUrl: (origin: string) => string
  readonly liveness: () => { readonly live: true }
  readonly readiness: () => { readonly ready: boolean; readonly phase: string }
  readonly ready: () => void
  readonly unavailable: () => void
}): () => void {
  const { listener } = options
  const instance = randomUUID()
  let origin: URL | undefined
  let unpublish: (() => void) | undefined
  const detach: (() => void)[] = []

  function expose(path: string, project: () => object, status: (body: object) => number) {
    detach.push(listener.register({ kind: 'exact', path, handler(request, response) {
      response.setHeader('Cache-Control', 'no-store')
      const bound = origin ?? new URL(listener.getOrigin())
      if (request.headers.host !== bound.host || (request.headers.origin !== undefined && request.headers.origin !== bound.origin)) {
        response.writeHead(403).end()
        return
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.setHeader('Allow', 'GET, HEAD')
        response.writeHead(405).end()
        return
      }
      const body = { ...project(), instance }
      response.writeHead(status(body), { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify(body))
    } }))
  }

  try {
    expose('/dshpa/live', options.liveness, () => 200)
    expose('/dshpa/ready', options.readiness, body => 'ready' in body && body.ready === true ? 200 : 503)
    detach.push(options.appReady.onReady(() => {
      try {
        origin = new URL(listener.getOrigin())
        if (origin.hostname !== '127.0.0.1' && origin.hostname !== '[::1]') throw new Error('Expected loopback')
        unpublish = publishOwnerLink(options.directory, origin.origin, options.authenticatedUrl(origin.origin), instance)
        options.ready()
      } catch {
        options.unavailable()
      }
    }))
  } catch (error) {
    for (const remove of detach.reverse()) remove()
    throw error
  }
  return () => {
    for (const remove of detach.reverse()) remove()
    unpublish?.()
  }
}
