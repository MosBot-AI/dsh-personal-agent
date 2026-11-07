import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isAbsolute, join } from 'node:path'

const [operation, directory, argument, ...extra] = process.argv.slice(2)
if (!['live', 'ready', 'inspect', 'backup', 'audit', 'owner-url'].includes(operation)
  || typeof directory !== 'string' || !isAbsolute(directory) || extra.length > 0
  || (argument !== undefined && (operation !== 'audit' || !/^\d+$/u.test(argument) || !Number.isSafeInteger(Number(argument))))) {
  process.stderr.write('Usage: ops.mjs live|ready|inspect|backup|audit|owner-url /absolute/inbox-storage [after-sequence]\n')
  process.exit(64)
}

function readOwnerLink() {
  const path = join(directory, 'resident-owner.json')
  const state = lstatSync(directory)
  const file = lstatSync(path)
  const uid = process.getuid?.()
  if (!state.isDirectory() || !file.isFile() || file.nlink !== 1 || file.size > 4096
    || (uid !== undefined && (state.uid !== uid || file.uid !== uid || (state.mode & 0o777) !== 0o700 || (file.mode & 0o777) !== 0o600))) {
    throw new Error('unsafe owner link')
  }
  const data = JSON.parse(readFileSync(path, 'utf8'))
  if (data.version !== 1 || !Number.isSafeInteger(data.pid) || data.pid < 1 || typeof data.url !== 'string'
    || typeof data.instance !== 'string' || !/^[a-f0-9-]{36}$/u.test(data.instance)) throw new Error('invalid owner link')
  const url = new URL(data.url)
  if (!['127.0.0.1', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)
    || url.pathname !== '/' || !url.search || url.username || url.password || url.hash) throw new Error('invalid owner link')
  return { url, instance: data.instance }
}

function localRequest(url, { method = 'GET', headers, body, timeout = 5_000 } = {}) {
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    // A one-shot direct socket avoids ambient HTTP proxy and redirect policies.
    const outgoing = send(url, { method, headers, agent: false, signal: AbortSignal.timeout(timeout) }, response => {
      const parts = []
      let size = 0
      response.on('data', chunk => {
        size += chunk.length
        if (size > 1_048_576) response.destroy(new Error('resident response is too large'))
        else parts.push(chunk)
      })
      response.once('error', reject)
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(parts).toString('utf8') }))
    })
    outgoing.once('error', reject)
    outgoing.end(body)
  })
}

async function probe(url, instance, kind) {
  const response = await localRequest(new URL(`/dshpa/${kind}`, url.origin))
  const value = JSON.parse(response.body)
  if (value.instance !== instance) throw new Error('resident instance changed')
  return { ok: response.status === 200, value }
}

async function ownerRpc(url, payload) {
  const auth = await localRequest(url)
  const cookie = auth.headers['set-cookie']?.[0]?.split(';', 1)[0]
  if (auth.status !== 303 || !cookie) throw new Error('owner authentication unavailable')
  const method = 'dshpa/inbox'
  const rpcId = randomUUID()
  const body = JSON.stringify({ type: 'client-request', rpcId, method, payload })
  const response = await localRequest(new URL(`/api/${method}`, url.origin), {
    method: 'POST', timeout: operation === 'backup' ? 120_000 : 5_000,
    headers: { cookie, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, body,
  })
  if (response.status !== 200) throw new Error('operations unavailable')
  const envelope = JSON.parse(response.body)
  if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId || envelope.result?.ok !== true) throw new Error('operations unavailable')
  const value = envelope.result.value
  if (value?.ok === false && typeof value.code === 'string' && /^[a-z_]+$/u.test(value.code)) return value
  if (value?.ok !== true || value.kind !== 'resident') throw new Error('operations unavailable')
  return value.value
}

try {
  const { url, instance } = readOwnerLink()
  if (operation === 'owner-url') {
    if (!(await probe(url, instance, 'live')).ok) throw new Error('resident unavailable')
    process.stdout.write(`${url.href}\n`)
  } else if (operation === 'live' || operation === 'ready') {
    const { ok, value } = await probe(url, instance, operation)
    process.stdout.write(JSON.stringify(value) + '\n')
    if (!ok) process.exitCode = 1
  } else {
    if (!(await probe(url, instance, 'live')).ok) throw new Error('resident unavailable')
    const type = { inspect: 'resident_status', backup: 'resident_backup', audit: 'resident_audit' }[operation]
    const value = await ownerRpc(url, { type, ...(argument === undefined ? {} : { afterSequence: Number(argument) }) })
    process.stdout.write(JSON.stringify(value) + '\n')
    if (value?.ok === false) process.exitCode = 1
  }
} catch {
  process.stderr.write('Resident host or its private owner link is unavailable.\n')
  process.exitCode = 1
}
