import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const prepApi = env.PREP_API_DEV_ORIGIN || 'http://127.0.0.1:8102'
  const mentorApi = env.MENTOR_API_DEV_ORIGIN || 'http://127.0.0.1:8103'
  const codelabApi = env.CODELAB_API_DEV_ORIGIN || 'http://127.0.0.1:8001'
  const platformCorePath = process.env.CODEOS_PLATFORM_CORE_PATH || resolve(__dirname, '../../../frontend/src/platform_core')
  const writingAsset = resolve(__dirname, '.design-editor/writing-editor.js')
  return {
    base: env.VITE_BASE_PATH || '/',
    publicDir: resolve(platformCorePath, 'theme-public'),
    resolve: { alias: { '@codeos/platform-core': platformCorePath, react: resolve(__dirname, 'node_modules/react'), 'react-dom': resolve(__dirname, 'node_modules/react-dom'), 'lucide-react': resolve(__dirname, 'node_modules/lucide-react') } },
    plugins: [react(), {
      name: 'writing-design-preview-asset',
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          const path = new URL(request.url || '/', 'http://localhost').pathname
          if (!['/design-review/writing-editor.js', '/learning/design-review/writing-editor.js'].includes(path)) return next()
          try {
            const source = await readFile(writingAsset)
            response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' })
            response.end(source)
          } catch {
            response.writeHead(503, { 'Content-Type': 'text/plain' })
            response.end('Writing preview asset unavailable. Run npm run build:writing-preview in the Learning frontend.')
          }
        })
      },
      async generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'design-review/writing-editor.js', source: await readFile(writingAsset) })
      },
    }, {
      name: 'learning-canonical-routes',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url || '/', 'http://localhost')
          const paths: Record<string, string> = {
            '/learning/mentor': '/learning/mentor/',
            '/learning/prep': '/learning/prep/',
            '/learning/library': '/learning/notes/',
            '/learning/library/': '/learning/notes/',
          }
          const target = paths[url.pathname]
          if (!target) return next()
          response.writeHead(308, { Location: target + url.search })
          response.end()
        })
      },
    }],
    server: {
      fs: { allow: [__dirname, platformCorePath] },
      // The resident Compose stack exposes every product Vite server on 8080.
      // Tests and direct local runs may still override this with Vite's CLI flag.
      port: Number(env.VITE_DEV_PORT || '8080'),
      watch: { usePolling: true, interval: 250 },
      proxy: {
        '/api/codelab': { target: codelabApi, changeOrigin: true },
        '/api/prep': { target: prepApi, changeOrigin: true },
        '/api/mentor': { target: mentorApi, changeOrigin: true },
      },
    },
  }
})
