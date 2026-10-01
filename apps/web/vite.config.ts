import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig, loadEnv } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

/** Proxy only API traffic; retain the browser Origin for the server policy. */
export function createApiProxy(target = 'http://127.0.0.1:3000') {
  const url = new URL(target)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.includes('?') || url.href.includes('#') || url.pathname !== '/') {
    throw new Error('API_PROXY_TARGET must be an HTTP(S) origin without credentials, path, query or fragment.')
  }
  return { '/api': { target: url.origin, changeOrigin: false } }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'API_PROXY_TARGET')
  const proxy = createApiProxy(env.API_PROXY_TARGET || undefined)
  return {
    server: { proxy },
    preview: { proxy },
    plugins: [
      react(),
      babel({ presets: [reactCompilerPreset()] }),
      tailwindcss(),
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
  }
})
