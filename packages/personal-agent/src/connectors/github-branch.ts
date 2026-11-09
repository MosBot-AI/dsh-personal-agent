import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectorBinding } from './registry.js'

export interface DraftBranchInput {
  readonly base: string
  readonly baseSha: string
  readonly head: string
  readonly path: string
  readonly content: string
  readonly preparedAt: string
}
export interface PreparedBranch {
  readonly sha: string
  publish(signal: AbortSignal): Promise<void>
  close(): void
}
// Preserve the host's network route and certificate trust without inheriting
// arbitrary Git options, credential helpers, TLS bypasses or unrelated secrets.
const networkEnvironment = ['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH', 'GIT_PROXY_SSL_CAINFO', 'SSL_CERT_FILE', 'SSL_CERT_DIR'] as const

type Remote = { kind: 'github'; binding: ConnectorBinding; token: string } | { kind: 'local'; directory: string; binding: ConnectorBinding }

function git(directory: string, args: string[], signal: AbortSignal, env: NodeJS.ProcessEnv, text?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'http.followRedirects=false',
      '-c', 'protocol.ext.allow=never', '-c', 'protocol.ssh.allow=never', '-c', 'protocol.git.allow=never', ...args], {
      cwd: directory, env, maxBuffer: 512 * 1024, signal, timeout: 30_000, encoding: 'utf8',
    }, (error, stdout) => error ? reject(new Error('Isolated Git operation failed')) : resolve(stdout.trim()))
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(text)
  })
}

/** A private bare Git repository uses an index and object plumbing, with no working-tree hooks or filters. */
export async function prepareIsolatedBranch(input: DraftBranchInput, remote: Remote, signal: AbortSignal): Promise<PreparedBranch> {
  const directory = mkdtempSync(join(tmpdir(), 'dshpa-draft-'))
  const close = () => rmSync(directory, { recursive: true, force: true })
  const { account, repository } = remote.binding
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: account.login, GIT_COMMITTER_NAME: account.login,
    GIT_AUTHOR_EMAIL: `${account.id}+${account.login}@users.noreply.github.com`,
    GIT_COMMITTER_EMAIL: `${account.id}+${account.login}@users.noreply.github.com`,
    GIT_AUTHOR_DATE: input.preparedAt, GIT_COMMITTER_DATE: input.preparedAt,
  }
  const url = remote.kind === 'github' ? `https://github.com/${repository.owner}/${repository.name}.git` : remote.directory
  const networkTrust = Object.fromEntries(networkEnvironment.flatMap(key =>
    process.env[key] === undefined ? [] : [[key, process.env[key]]]))
  const network = remote.kind === 'github' ? { ...env, ...networkTrust, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${account.login}:${remote.token}`).toString('base64')}` } : env
  const transport = ['-c', `protocol.file.allow=${remote.kind === 'local' ? 'always' : 'never'}`, '-c', 'protocol.http.allow=never']
  const run = (args: string[], text?: string) => git(directory, args, signal, env, text)
  try {
    await run(['init', '--bare', '--object-format=sha1'])
    await git(directory, [...transport, 'fetch', '--no-tags', '--depth=1', '--no-recurse-submodules', '--',
      url, `refs/heads/${input.base}:refs/dshpa/base`], signal, network)
    if (await run(['rev-parse', 'refs/dshpa/base']) !== input.baseSha) throw new Error('The selected base changed')
    if (await run(['ls-tree', input.baseSha, '--', input.path])) throw new Error('The draft path already exists')
    await run(['read-tree', input.baseSha])
    const blob = await run(['hash-object', '-w', '--stdin'], input.content)
    await run(['update-index', '--add', '--cacheinfo', `100644,${blob},${input.path}`])
    const tree = await run(['write-tree'])
    const sha = await run(['commit-tree', tree, '-p', input.baseSha], 'chore: prepare reviewed dshpa test draft\n')
    const head = `refs/heads/${input.head}`
    await run(['update-ref', head, sha])
    return { sha, close, async publish(writeSignal) {
      await git(directory, [...transport, 'push', '--no-verify', '--porcelain', `--force-with-lease=${head}:`, '--', url,
        `${sha}:${head}`], writeSignal, network)
    } }
  } catch (error) {
    close()
    throw error
  }
}
