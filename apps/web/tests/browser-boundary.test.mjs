import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'vite'
import { browserBoundary } from '../build/browser-boundary.ts'

// Use the real Vite module graph without filesystem fixtures or provider imports.
async function graph(module, { unused = false, external = false } = {}) {
  return build({
    configFile: false,
    logLevel: 'silent',
    plugins: [browserBoundary(), {
      name: 'graph-fixture',
      resolveId(id) {
        if (id === 'virtual:entry') return id
        if (id === 'fixture-dependency') return { id: module, external }
      },
      load(id) {
        if (id === 'virtual:entry') return `import { value } from 'fixture-dependency'; ${unused ? 'console.log("browser")' : 'console.log(value)'}`
        if (id === module) return 'export const value = "fixture"'
      },
    }],
    build: { write: false, rollupOptions: { input: 'virtual:entry' } },
  })
}

test('the browser graph permits frontend, contracts and public voice SDK modules', async () => {
  for (const module of ['/fixture/apps/web/src/lib/api-url.ts', '/fixture/packages/contracts/dist/index.js',
    '/fixture/node_modules/@elevenlabs/client/dist/index.js']) {
    await graph(module)
  }
})

test('the browser build rejects server implementation and private runtime packages', async () => {
  for (const module of ['/fixture/apps/server/src/runtime.ts', '/fixture/apps/server/dist/codex-provider.js',
    '/fixture/node_modules/.pnpm/openai@6/node_modules/openai/index.js',
    '/fixture/node_modules/hono/dist/index.js', '/fixture/node_modules/@hono/node-server/dist/index.js',
    '/fixture/node_modules/ws/index.js', '/fixture/node_modules/@openai/codex/dist/index.js',
    '/fixture/node_modules/@openai/codex-sdk/dist/index.js', '__vite-browser-external:node:fs']) {
    await assert.rejects(graph(module), /Private server module reached the browser dependency graph/)
  }
})

test('tree shaking and externalization cannot hide private graph dependencies', async () => {
  await assert.rejects(graph('/fixture/apps/server/src/config.ts', { unused: true }), /Private server module/)
  for (const module of ['openai', 'hono', '@hono/node-server', 'ws', '@openai/codex-sdk', 'node:child_process']) {
    await assert.rejects(graph(module, { external: true }), /Private server module/)
  }
})
