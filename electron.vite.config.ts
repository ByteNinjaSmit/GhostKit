import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/**
 * index.html ships a strict CSP meta tag (script-src 'self', connect-src
 * 'none', ...) -- correct and required for the packaged app, but it also
 * blocks two things `electron-vite dev` depends on: @vitejs/plugin-react's
 * inline "preamble" script (React Fast Refresh bootstrap) and the Vite HMR
 * websocket. With the tag left in as-is, both are blocked, the preamble
 * never installs, and every component module throws on load ("can't detect
 * preamble") -- the renderer never mounts anything, in dev only.
 *
 * Rather than stripping the tag (which would also drop `connect-src 'none'`
 * -- the control that exists specifically to catch a renderer accidentally
 * talking to the network directly, which matters once Phase 2 puts a Gemini
 * API key in this app), this substitutes a narrow dev-only policy that keeps
 * every directive except the two Vite genuinely needs relaxed. It uses a
 * `localhost:*` port wildcard rather than electron/main.ts's exact dev
 * origin, since this plugin runs before electron-vite has settled on a port;
 * electron/main.ts's response-header CSP (which does know the exact origin)
 * is enforced alongside this one, so the browser applies the intersection --
 * this tag is defense-in-depth, not the binding policy.
 *
 * `apply: 'serve'` scopes this to `electron-vite dev` exclusively; a
 * production `electron-vite build` never runs this plugin, so the packaged
 * app's CSP is untouched -- see electron/main.ts, which likewise only
 * installs the narrower DEV_CSP (never no CSP at all) in dev.
 */
function devCspPlugin(): Plugin {
  const DEV_META_CSP = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' http://localhost:*",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "worker-src 'self'", // src/audio/pcm-worklet.js's AudioWorklet + Phase 5's Monaco editor worker -- see electron/main.ts's CSP for the fuller comment
    'connect-src http://localhost:* ws://localhost:*',
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "form-action 'none'"
  ].join('; ')

  const CSP_META_RE = /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*("\s*\/?>)/i

  return {
    name: 'mockpilot-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      const replaced = html.replace(CSP_META_RE, `$1${DEV_META_CSP}$2`)
      if (replaced === html) {
        // Fail loud, not with a silent blank screen: if index.html's CSP
        // meta tag ever changes shape, this matcher needs updating too.
        throw new Error('mockpilot-dev-csp: CSP <meta> tag not found in index.html -- update CSP_META_RE')
      }
      return replaced
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'electron/main.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: {
          preload: resolve(__dirname, 'electron/preload.ts')
        },
        output: {
          // Electron's sandboxed preload loader only supports CommonJS
          // (it rejects `import`/`export` with "Cannot use import statement
          // outside a module"), so force CJS output here even though the
          // main process build above is ESM. The .cjs extension keeps this
          // unambiguous despite package.json's "type": "module".
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    root: '.',
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src')
      }
    },
    plugins: [react(), devCspPlugin()],
    build: {
      outDir: 'out/renderer',
      // Vite inlines small assets (<4kb, the default) as base64 `data:` URLs.
      // src/audio/pcm-worklet.js is referenced via
      // `new URL('./pcm-worklet.js', import.meta.url)` and loaded with
      // `audioWorklet.addModule()` -- a `data:` script source would be
      // blocked by this app's CSP (`script-src 'self'`, no `data:`, and no
      // relaxing that for one file), so force every asset to always be
      // emitted as a real, same-origin file instead.
      assetsInlineLimit: 0,
      rollupOptions: {
        input: resolve(__dirname, 'index.html')
      }
    }
  }
})
