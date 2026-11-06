import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'

const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

const DEVELOPMENT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self' ws://localhost:* http://localhost:* ws://127.0.0.1:* http://127.0.0.1:*",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

/**
 * The renderer only ever displays local application code. In production we inject a
 * strict CSP into the generated HTML. Vite's dev server needs inline scripts + HMR
 * websockets, so development gets a slightly looser CSP and is never packaged.
 */
function contentSecurityPolicy(): Plugin {
  return {
    name: 'dondownload-csp',
    transformIndexHtml(html, context) {
      const policy = context.server ? DEVELOPMENT_CSP : PRODUCTION_CSP
      return {
        html,
        tags: [
          {
            tag: 'meta',
            attrs: {
              'http-equiv': 'Content-Security-Policy',
              content: policy
            },
            injectTo: 'head-prepend'
          }
        ]
      }
    }
  }
}

export default defineConfig({
  main: {
    // Runtime dependencies used by main are bundled into out/main because the
    // packaged app ships no node_modules (see electron-builder.yml). Anything
    // left external here must exist at runtime, so list every main dependency.
    plugins: [externalizeDepsPlugin({ exclude: ['htmlparser2'] })],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react(), tailwindcss(), contentSecurityPolicy()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    build: {
      rollupOptions: {
        // Only the real app entry ships. The dev-only `preview.html` fixture
        // route is never part of a production renderer build.
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    }
  }
})
