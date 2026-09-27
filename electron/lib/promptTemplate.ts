/**
 * promptTemplate.ts
 *
 * Loads a `prompts/*.md` file and fills its `{{var}}` placeholders. Main
 * process only -- uses `app.getAppPath()` + Node's `fs`, neither of which is
 * available to the sandboxed renderer.
 *
 * Path resolution: `app.getAppPath()` returns the directory that contains
 * `package.json` -- the project root when running unpacked
 * (`npm run dev` / `electron-vite dev`), and the root of the asar archive (or
 * the unpacked app directory, if `asar: false`) in a packaged build. Both
 * cases resolve to the same relative layout, so `join(app.getAppPath(),
 * 'prompts', name)` finds the file either way, without hard-coding how many
 * directories deep `out/main/main.js` (the actual `__dirname` at runtime)
 * happens to sit relative to the project root -- that nesting is a build
 * output detail (`electron.vite.config.ts`'s `outDir`) that has no reason to
 * stay in sync with a path computed from `__dirname`. Node's `fs` can read
 * straight through an asar archive (Electron patches `fs` for this), so no
 * asar-aware branching is needed here.
 *
 * IMPORTANT: `electron-builder.yml`'s `files` list must include `prompts/**` for
 * this to resolve in a packaged build -- see that file.
 */
import { app } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const TEMPLATE_VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

async function loadPromptFile(name: string): Promise<string> {
  const filePath = join(app.getAppPath(), 'prompts', name)
  return readFile(filePath, 'utf-8')
}

/**
 * Replaces every `{{var}}` placeholder with `vars[var]`. A placeholder with
 * no matching key is left in place rather than throwing -- a missing/renamed
 * template variable should be visible (and debuggable) in the rendered
 * prompt text, not a hard crash at session-start time.
 */
function fillTemplate(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(TEMPLATE_VAR_RE, (match: string, key: string): string => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match
  })
}

/** Loads `prompts/<name>` and fills its `{{var}}` placeholders with `vars`. */
export async function renderPromptTemplate(name: string, vars: Readonly<Record<string, string>>): Promise<string> {
  const template = await loadPromptFile(name)
  return fillTemplate(template, vars)
}
