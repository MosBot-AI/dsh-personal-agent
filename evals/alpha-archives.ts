import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export function packageArchive(directory: string, checkout: string, destination: string) {
  const cwd = join(checkout, 'packages', directory)
  const { name, version } = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { name: string; version: string }
  const path = join(destination, `${name.slice(1).replace('/', '-')}-${version}.tgz`)
  return { cwd, name, version, path, spec: 'file:' + path }
}

export function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function readAlphaArchives(checkout: string, directory: string) {
  const bundle = packageArchive('personal-agent', checkout, directory)
  const pluginApi = packageArchive('plugin-api', checkout, directory)
  const routing = packageArchive('model-routing', checkout, directory)
  const manifest = readFileSync(join(directory, 'SHA256SUMS'))
  const checksums = new Map<string, string>()
  for (const line of manifest.toString('utf8').trim().split(/\r?\n/u)) {
    const entry = /^([0-9a-f]{64}) [ *](?:\.\/)?([^/\\]+)$/u.exec(line)
    assert.ok(entry && !checksums.has(entry[2]!) && entry[2] !== '..' && entry[2] !== '.', 'Invalid alpha checksum manifest')
    checksums.set(entry[2]!, entry[1]!)
  }
  for (const file of [bundle.path, pluginApi.path, routing.path, join(directory, 'LICENSE')]) {
    assert.ok(checksums.has(basename(file)), `Archive checksum missing for ${basename(file)}`)
  }
  for (const [name, expected] of checksums) {
    assert.equal(sha256(readFileSync(join(directory, name))), expected, `Archive checksum mismatch for ${name}`)
  }
  const releaseSource = readFileSync(join(directory, 'source-commit.txt'), 'utf8').trim()
  assert.match(releaseSource, /^[0-9a-f]{40}$/u, 'The release source commit is missing')
  return { bundle, pluginApi, routing, manifest, releaseSource, archiveManifestSha256: sha256(manifest) }
}

export function alphaWorkspaceSettings(defaults: string, api: { name: string; spec: string }, routing: { name: string; spec: string }) {
  assert.match(defaults, /^nodeLinker: hoisted$/m)
  assert.match(defaults, /^autoInstallPeers: false$/m)
  return defaults + `\noverrides:
  ${JSON.stringify(api.name)}: ${JSON.stringify(api.spec)}
  ${JSON.stringify(routing.name)}: ${JSON.stringify(routing.spec)}
allowBuilds:
  koffi: true
`
}
