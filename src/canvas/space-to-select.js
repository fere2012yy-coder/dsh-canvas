/**
 * Space → selection tool — pressing SPACE switches to the default (selection)
 * tool, replacing Excalidraw's stock hold-space-to-pan gesture.
 *
 * Interception happens in the capture phase BEFORE the engine sees the key:
 * the engine's own Space handling (temporary hand tool) is stopped, and the
 * public setActiveTool switches to selection instead.
 *
 * Guards (the key passes through untouched when any applies):
 * - text editing active / writable element focused (typing spaces must work)
 * - view mode
 * - key repeat (held key fires once, not a stream)
 */

const isWritableFocused = () => {
  const ae = document.activeElement
  if (!ae) return false
  return ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.isContentEditable === true
}

export function installSpaceToSelect({ getApi } = {}) {
  const onKeyDown = (e) => {
    if (e.code !== 'Space' || e.repeat) return
    const api = getApi?.()
    if (!api) return
    const st = api.getAppState?.()
    if (!st || st.editingTextElement || st.viewModeEnabled) return
    if (isWritableFocused()) return
    e.preventDefault()
    e.stopImmediatePropagation()
    try {
      api.setActiveTool?.({ type: 'selection' })
    } catch {
      /* ignore */
    }
  }

  const onKeyUp = (e) => {
    if (e.code !== 'Space') return
    // swallow the release too: the engine's keyup bookkeeping for its own
    // space gesture must never observe a keydown it never saw
    const st = getApi?.()?.getAppState?.()
    if (st?.editingTextElement) return
    if (isWritableFocused()) return
    e.preventDefault()
    e.stopImmediatePropagation()
  }

  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keyup', onKeyUp, true)
  return () => {
    window.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('keyup', onKeyUp, true)
  }
}
