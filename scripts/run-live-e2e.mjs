import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (!process.env.DEEPSEEK_API_KEY?.trim()) {
  console.log('SKIPPED live E2E: DEEPSEEK_API_KEY is unavailable. No live acceptance was recorded.')
} else {
  const vitest = fileURLToPath(new URL('./vitest.mjs', import.meta.resolve('vitest/package.json')))
  const result = spawnSync(process.execPath, [vitest, 'run', 'tests/e2e'], {
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}
