import { readFileSync } from 'node:fs'
import { it } from 'vitest'
import { verifyComfyRecovery } from '../media/fixtures/media-recovery.js'

const path = process.env.DSHPA_COMFYUI_LIVE_CONFIG

it.skipIf(!path)('recovers the original output after ComfyUI accepts a prompt and the submit receipt is lost', async () => {
  const evidence = await verifyComfyRecovery(JSON.parse(readFileSync(path!, 'utf8')))
  console.log('ComfyUI recovery evidence', JSON.stringify(evidence))
}, 13 * 60_000)
