import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = env.CODELAB_API_DEV_ORIGIN || 'http://127.0.0.1:8001'
  const jupyterTarget = env.CODELAB_JUPYTER_DEV_ORIGIN || 'http://127.0.0.1:8888'
  const platformCorePath = process.env.CODEOS_PLATFORM_CORE_PATH || resolve(__dirname, '../../../frontend/src/platform_core')
  return {
    base: env.VITE_BASE_PATH || '/',
    publicDir: resolve(platformCorePath, 'theme-public'),
    plugins: [react()],
    resolve: {
      alias: {
        '@codeos/platform-core': platformCorePath,
        react: resolve(__dirname, 'node_modules/react'),
        'react-dom': resolve(__dirname, 'node_modules/react-dom'),
        'lucide-react': resolve(__dirname, 'node_modules/lucide-react'),
      },
    },
    server: {
      port: Number(env.CODELAB_DEV_PORT || 8002),
      fs: { allow: [resolve(__dirname, '../../../')] },
      proxy: {
        '/api/codelab': {
          target: apiTarget,
          changeOrigin: true,
        },
        '/jupyter': {
          target: jupyterTarget,
          changeOrigin: true,
          ws: true,
        },
      },
    },
  }
})
