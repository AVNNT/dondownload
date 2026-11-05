import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * Renderer-only dev server for the browser fixture preview.
 *
 * This intentionally does not use electron-vite's `--rendererOnly` flag: that
 * command still starts Electron after opening the renderer server. Plain Vite
 * keeps the preview free of Electron, preload and native IPC entirely.
 */
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false
  }
})
