import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// Bundle the existing editor for the plain HTML design preview, without a second runtime.
export default defineConfig({
  publicDir: false,
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: '.design-editor',
    lib: { entry: resolve(__dirname, 'src/designReviewLiveEditor.ts'), name: 'CodeOSWriting', formats: ['iife'], fileName: () => 'writing-editor.js' },
  },
})
