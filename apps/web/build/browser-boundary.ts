import type { Plugin } from 'vite'

const privatePackages = /(?:^|\/node_modules\/)(?:openai|hono|ws|@hono\/node-server|@openai\/codex(?:-sdk)?)(?:\/|$)/

/** Keep server implementation and private runtimes outside the browser graph. */
export function browserBoundary(): Plugin {
  return {
    name: 'dot-browser-boundary',
    apply: 'build',
    generateBundle() {
      for (const id of this.getModuleIds()) {
        const path = id.replaceAll('\\', '/')
        if (/(?:^|\/)apps\/server(?:\/|$)/.test(path) || privatePackages.test(path) || path.includes('node:')) {
          this.error(`Private server module reached the browser dependency graph: ${id}`)
        }
      }
    },
  }
}
