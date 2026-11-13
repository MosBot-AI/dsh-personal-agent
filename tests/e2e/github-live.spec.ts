import { describe, expect, it } from 'vitest'
import { DRAFT_TOKEN, githubDraftConfigSchema } from '../../packages/personal-agent/src/connectors/github-draft-model.js'
import { draftView, makeDraftHarness, waitForDraftReceipt } from '../connectors/github-draft-harness.js'

// Operator opt-in is the explicit authorization for one branch and draft in the supplied test repository.
const enabled = process.env.DSHPA_GITHUB_DRAFT_LIVE === '1'

describe.skipIf(!enabled)('authorized live GitHub test draft', () => {
  it('publishes and reads back one approved draft in the configured dedicated test repository', async () => {
    if (!process.env[DRAFT_TOKEN] || !process.env.DSHPA_GITHUB_DRAFT_LIVE_CONFIG) {
      throw new Error('Explicit test repository configuration and a test-only write credential are required')
    }
    const config = githubDraftConfigSchema.parse(JSON.parse(process.env.DSHPA_GITHUB_DRAFT_LIVE_CONFIG))
    const { repository } = config.binding
    if (repository.id === 1448962460 || `${repository.owner}/${repository.name}`.toLowerCase() === 'mosbot-ai/dsh-personal-agent') {
      throw new Error('The project repository is outside live test scope')
    }
    const h = await makeDraftHarness(config)
    try {
      const prepared = draftView(await h.request({ type: 'github_draft_prepare', taskId: h.taskId,
        expectedVersion: h.version(), commandId: 'live-test-draft', draft: {
          title: 'chore(test): verify approved draft readback',
          body: 'This draft is the explicitly authorized PA-017 test operation.',
          content: '# PA-017 test draft\n\nOne approved test file.\n',
        } }))
      expect(await h.approve(prepared)).toMatchObject({ ok: true })
      const dispatch = await h.request({ type: 'github_draft_dispatch', taskId: h.taskId,
        operationId: prepared.payload.operationId, expectedVersion: h.version() })
      expect(dispatch).toMatchObject({ ok: true })
      const receipt = await waitForDraftReceipt(h, prepared.payload.operationId)
      expect(receipt).toMatch(/^https:\/\/github\.com\//u)
      process.stdout.write(`PA-017_LIVE_DRAFT_RECEIPT=${receipt}\n`)
    } finally { await h.close() }
  }, 180_000)
})
