/**
 * monacoSetup.ts
 *
 * Configures Monaco (via `@monaco-editor/react`) to run entirely
 * same-origin, before any `<Editor>` mounts. Two separate CDN dependencies
 * have to be defeated for this to work under this app's CSP
 * (`script-src 'self'`, `worker-src 'self'`, no external origins anywhere):
 *
 *  1. `@monaco-editor/react`'s DEFAULT loader (`@monaco-editor/loader`)
 *     fetches the whole monaco-editor AMD bundle from a CDN
 *     (cdn.jsdelivr.net) at runtime by injecting a `<script src="https://...">`
 *     tag -- `script-src 'self'` blocks that outright, and the editor would
 *     never load at all (silently, or with a CSP violation logged to the
 *     console, depending on Chromium version). `loader.config({ monaco })`
 *     below points the loader at the copy of `monaco-editor` this app
 *     already bundles into its own renderer build instead, so it never
 *     touches the network.
 *  2. Monaco's own worker bootstrapping (`self.MonacoEnvironment`) has no
 *     default that works under this CSP either -- left unconfigured, Monaco
 *     falls back to running its worker logic on the main thread with a
 *     console warning (not a hard failure, but not what we want). Wiring
 *     `getWorker` to a real, same-origin worker file (bundled the same way
 *     src/audio/pcm-worklet.js is -- see electron.vite.config.ts's
 *     `assetsInlineLimit: 0` comment, which applies here too) keeps the
 *     editor's tokenization/bracket-matching/folding work off the main
 *     thread, same as it would get in a normal (CDN-connected) Monaco setup.
 *
 * Two workers are registered: the generic editor worker (tokenization,
 * bracket matching, folding -- all that Python/Java/C++ get, since none of
 * them ships a dedicated Monaco language-service worker) and the TypeScript
 * language worker, which Monaco's `javascript` AND `typescript` languages both
 * use for their language features (completions, diagnostics, hover). Handing
 * those labels the plain editor worker instead makes the JS/TS language
 * service fail with console errors when the editor asks it for a service
 * that worker doesn't implement. Both are same-origin bundled files, so this
 * stays within `worker-src 'self'` -- no CDN.
 */
import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker'

let configured = false

/** Idempotent -- safe to call from every mount of the coding-round page, but only actually wires things up once per renderer lifetime. */
export function configureMonaco(): void {
  if (configured) return
  configured = true

  self.MonacoEnvironment = {
    getWorker: (_workerId: string, label: string): Worker => (label === 'typescript' || label === 'javascript' ? new TsWorker() : new EditorWorker())
  }
  loader.config({ monaco })
}
