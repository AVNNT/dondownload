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

/**
 * Opt-in module-size report. Run `DONDOWNLOAD_BUNDLE_REPORT=1 npm run build`
 * to see the largest modules in each output chunk without adding a dependency
 * or a permanent visualization artifact.
 */
function bundleReport(): Plugin {
  return {
    name: 'dondownload-bundle-report',
    apply: 'build',
    generateBundle(_options, bundle) {
      if (process.env.DONDOWNLOAD_BUNDLE_REPORT !== '1') return
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== 'chunk') continue
        const modules = Object.entries(output.modules)
          .map(([id, info]) => ({ id, size: info.renderedLength }))
          .sort((left, right) => right.size - left.size)
        console.log(`[bundle-report] ${fileName} ${output.code.length} bytes`)
        for (const module of modules.slice(0, 20)) {
          console.log(
            `[bundle-report]   ${module.size} bytes ${module.id.replace(
              __dirname,
              '<root>'
            )}`
          )
        }
      }
    }
  }
}

// electron-vite sets this before loading the config for both `dev` and `build`.
// Keeping the config a plain object (rather than a function) lets tests and
// tooling import it directly, as they already did.
const production = process.env.NODE_ENV_ELECTRON_VITE === 'production'

// electron-vite derives the output target from the installed Electron version
// (Node for main/preload, Chromium for the renderer), so no hand-maintained
// target can drift from the runtime.
const buildTuning = production
  ? {
      // Main and preload are parsed before the first window exists, so minify
      // them too (electron-vite otherwise leaves them readable).
      minify: true,
      // Never ship inline sourcemaps in production; electron-builder also
      // excludes maps, but keeping them out of `out` avoids dead weight and
      // accidental disclosure in unpacked builds.
      sourcemap: false
    }
  : {}

export default defineConfig({
  main: {
    // Runtime dependencies used by main are bundled into out/main because the
    // packaged app ships no node_modules (see electron-builder.yml). Anything
    // left external here must exist at runtime, so list every main dependency.
    plugins: [
      externalizeDepsPlugin({ exclude: ['htmlparser2'] }),
      bundleReport()
    ],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    build: buildTuning
  },
  preload: {
    // Electron is the only external dependency preload needs.
    plugins: [externalizeDepsPlugin(), bundleReport()],
    build: buildTuning
  },
  renderer: {
    plugins: [react(), tailwindcss(), contentSecurityPolicy(), bundleReport()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    build: {
      ...buildTuning,
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
