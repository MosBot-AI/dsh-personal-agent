import { afterEach, expect, it, vi } from 'vitest'
import { prepareIsolatedBranch } from '../../packages/personal-agent/src/connectors/github-branch.js'

const capture = vi.hoisted(() => ({ calls: [] as { args: string[]; env: NodeJS.ProcessEnv }[] }))
vi.mock('node:child_process', () => ({
  execFile(_file: string, args: string[], options: { env: NodeJS.ProcessEnv }, done: (error: Error | null, stdout: string) => void) {
    capture.calls.push({ args, env: options.env })
    queueMicrotask(() => done(args.includes('fetch') ? new Error('private transport detail') : null, ''))
    return { stdin: { on() {}, end() {} } }
  },
}))
afterEach(() => { vi.unstubAllEnvs(); capture.calls.length = 0 })

it('preserves configured proxy and CA trust while isolating Git options and credentials', async () => {
  vi.stubEnv('HTTPS_PROXY', 'http://proxy.example.test:3128')
  vi.stubEnv('NO_PROXY', 'localhost,127.0.0.1')
  vi.stubEnv('GIT_SSL_CAINFO', '/fixture/trusted-ca.pem')
  vi.stubEnv('GIT_CONFIG_COUNT', '99')
  vi.stubEnv('GIT_CONFIG_KEY_0', 'credential.helper')
  vi.stubEnv('GIT_SSL_NO_VERIFY', '1')
  vi.stubEnv('UNRELATED_SERVICE_TOKEN', 'unrelated-fixture-secret')
  const token = 'fixture-github-credential'
  await expect(prepareIsolatedBranch({ base: 'main', baseSha: 'a'.repeat(40), head: 'dshpa-draft/test',
    path: 'draft.md', content: 'Test', preparedAt: '2026-11-09T00:00:00.000Z' }, {
    kind: 'github', token, binding: { account: { id: 17, login: 'TestOwner' },
      repository: { id: 42, owner: 'TestOrg', name: 'DedicatedTest' } },
  }, AbortSignal.timeout(1000))).rejects.toThrow('Isolated Git operation failed')
  const fetch = capture.calls.find(call => call.args.includes('fetch'))!
  expect(fetch.env).toMatchObject({ HTTPS_PROXY: 'http://proxy.example.test:3128', NO_PROXY: 'localhost,127.0.0.1',
    GIT_SSL_CAINFO: '/fixture/trusted-ca.pem', GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })
  expect(fetch.env.GIT_SSL_NO_VERIFY).toBeUndefined()
  expect(fetch.env.UNRELATED_SERVICE_TOKEN).toBeUndefined()
  expect(fetch.args.join(' ')).not.toContain(token)
  expect(fetch.args).toContain('http.followRedirects=false')
  expect(capture.calls[0]!.env.GIT_CONFIG_VALUE_0).toBeUndefined()
})
