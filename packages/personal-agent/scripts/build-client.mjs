import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'

const bundle = await rolldown({
  input: fileURLToPath(new URL('../src/client/index.tsx', import.meta.url)),
  external: ['react', 'react/jsx-runtime'],
  platform: 'browser',
  experimental: { attachDebugInfo: 'none' },
})

try {
  await bundle.write({
    file: fileURLToPath(new URL('../lib/client.js', import.meta.url)),
    format: 'cjs',
    banner: 'window.__ModuleLoader__.load({ id: "@mosbot-ai/dshpa", factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  })
} finally {
  await bundle.close()
}
