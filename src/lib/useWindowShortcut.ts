import { useEffect, useLayoutEffect, useRef } from 'react'

/**
 * Window-scoped keyboard shortcut (Phase 7). This is a plain `keydown`
 * listener on `window`, so it can only ever fire while the MockPilot window is
 * focused -- deliberately NOT `globalShortcut` (a global registration steals
 * the chord from every other application; see the Phase 5 hotkey history in
 * electron/main.ts).
 *
 * Guards, all of which make the shortcut a silent no-op:
 *  - `event.repeat`: a held key must not toggle repeatedly.
 *  - The keystroke originates in a text-entry control (input / textarea /
 *    select / contenteditable) or anywhere inside a Monaco editor
 *    (`.monaco-editor`, which includes its hidden `textarea.inputarea`).
 *    Monaco has its own keybinding system (Ctrl+Shift+Space is its "trigger
 *    parameter hints"), so while the editor has focus the chord belongs to it.
 *  - Extra modifiers (Alt/Meta) -- the chord must match exactly.
 *
 * `handler` is read through a ref so it always sees the latest render's state
 * (the pages' start/stop/hint handlers close over component state) while the
 * listener itself is attached exactly once per mount and removed on unmount --
 * StrictMode's mount/unmount/mount leaves exactly one live listener.
 * A matching `keyup` is swallowed (preventDefault) so a focused <button> is not
 * ALSO click-activated by the Space release.
 */
export interface ShortcutChord {
  /** `KeyboardEvent.code`, e.g. 'Space', 'KeyH'. Ctrl+Shift is always required. */
  code: string
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest('.monaco-editor') !== null) return true
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target instanceof HTMLElement && target.isContentEditable
}

function matches(event: KeyboardEvent, code: string): boolean {
  return event.code === code && event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey
}

export function useWindowShortcut(chord: ShortcutChord, handler: () => void): void {
  const handlerRef = useRef(handler)
  useLayoutEffect(() => {
    handlerRef.current = handler
  })

  const code = chord.code
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!matches(event, code) || isEditableTarget(event.target)) return
      event.preventDefault()
      if (event.repeat) return
      handlerRef.current()
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (matches(event, code) && !isEditableTarget(event.target)) event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [code])
}
