import type { HttpBindings } from '@hono/node-server'
import { createApp } from './app.ts'
import { loadServerConfig } from './config.ts'
import { createRuntime } from './runtime.ts'
import { createBackendServer } from './server.ts'

async function main() {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args[0] !== undefined && !/^--mode=(development|production)$/.test(args[0]))) {
    throw new Error('Use --mode=development or --mode=production.')
  }
  const config = loadServerConfig({ mode: args[0]?.slice('--mode='.length) })
  const runtime = createRuntime(config)
  let backend: ReturnType<typeof createBackendServer> | undefined
  try {
    const app = createApp(runtime.handlers, { frontendOrigins: config.frontendOrigins, mode: config.mode })
    backend = createBackendServer(config, runtime, (request, bindings) => app.fetch(request, bindings as HttpBindings))
    const shutdown = () => { void backend?.close().catch(() => { process.exitCode = 1 }) }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
    await backend.listen()
    console.log(`HTTP API listening on http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${config.port}`)
  } catch (error) {
    await (backend?.close() ?? runtime.close())
    throw error
  }
}

main().catch(error => {
  // Runtime configuration and bind failures have curated, secret-free messages.
  console.error(error instanceof Error ? error.message : 'Could not start the backend.')
  process.exitCode = 1
})
