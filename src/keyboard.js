/**
 * Keybind engine — project-graph 蓝本的骨架件（交互范式复刻，代码自写）。
 *
 * Registry shape mirrors project-graph's shortcutKeysRegister:
 *   { id, defaultKey, onPress, onRelease?, when?, isContinuous? }
 * - defaultKey: normalized token(s). A chord is "c-f" (Ctrl+F); a sequence is
 *   space-separated chords ("q f"). Tokens are lowercase; modifiers sorted
 *   C- A- S- (Ctrl / Alt / Shift).
 * - isContinuous: onPress fires once per animation frame while the key is
 *   held (keydown deduped; keyup or blur ends the hold) — the WASD camera
 *   pattern.
 * - when: context guard; the engine additionally refuses EVERYTHING while
 *   getContext().isEditing is true (text typing must never trigger tools)
 *   and when the event originates from an editable DOM element.
 * - Sequence rules: a chord that extends a registered sequence parks in the
 *   buffer (flushed after SEQUENCE_TIMEOUT_MS or on a non-matching chord,
 *   which then ALSO processes normally as a single chord). Continuous binds
 *   bypass the buffer and start immediately.
 */

const SEQUENCE_TIMEOUT_MS = 800

/** "KeyF"→"f", "ArrowUp"→"arrowup", "Digit1"→"1", "Space"→"space", … */
export function eventToken(e) {
  const code = e.code
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^Arrow/.test(code)) return code.slice(5).toLowerCase()
  if (code === 'Space') return 'space'
  if (code === 'Escape') return 'escape'
  if (code === 'Enter') return 'enter'
  if (code === 'Tab') return 'tab'
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6)
  return e.key.toLowerCase()
}

/** Normalize an event into the registry's chord string, e.g. "c-a-arrowup". */
function eventChord(e) {
  const base = eventToken(e)
  if (!base) return null
  let chord = base
  if (e.shiftKey) chord = 's-' + chord
  if (e.altKey) chord = 'a-' + chord
  if (e.ctrlKey || e.metaKey) chord = 'c-' + chord
  return chord
}

/** Parse a spec chord ("c-a-arrowup") into {mods, base} for comparison. */
function parseChord(spec) {
  const parts = spec.toLowerCase().split('-')
  const base = parts[parts.length - 1]
  const mods = new Set(parts.slice(0, -1))
  return { mods, base }
}

function chordMatches(e, spec) {
  const { mods, base } = parseChord(spec)
  if (eventToken(e) !== base) return false
  if (mods.has('c') !== (e.ctrlKey || e.metaKey)) return false
  if (mods.has('a') !== e.altKey) return false
  if (mods.has('s') !== e.shiftKey) return false
  return true
}

/** A registered sequence's chord list, e.g. "q f" → ["q", "f"]. */
function sequenceOf(bind) {
  return bind.defaultKey.includes(' ') ? bind.defaultKey.split(' ') : null
}

function isEditableTarget(e) {
  const el = e.target
  if (!(el instanceof Element)) return false
  if (el.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return true
  return false
}

export function createKeyboardEngine({ getContext }) {
  const binds = []
  let sequenceBuffer = [] // chords parked while they extend a registered sequence
  let sequenceTimer = null
  const held = new Map() // chord → continuous bind currently held

  const ctx = () => getContext()

  function flushSequence() {
    sequenceBuffer = []
    clearTimeout(sequenceTimer)
    sequenceTimer = null
  }

  function startHold(bind, chord, e) {
    if (held.has(chord)) return
    e.preventDefault()
    held.set(chord, bind)
    bind.onPress?.(ctx())
  }

  return {
    register(bind) {
      binds.push(bind)
      return () => {
        const i = binds.indexOf(bind)
        if (i >= 0) binds.splice(i, 1)
      }
    },

    handleKeyDown(e) {
      if (isEditableTarget(e) || ctx().isEditing) return
      const chord = eventChord(e)
      if (!chord) return
      if (held.has(chord)) return // OS auto-repeat: hold loop already running

      // 1) Sequence buffer first (never for continuous/single-fire dupes).
      const buffer = [...sequenceBuffer, chord]
      const seqCandidates = binds.filter((b) => {
        const seq = sequenceOf(b)
        return seq && seq.length >= buffer.length && seq.slice(0, buffer.length).join(' ') === buffer.join(' ')
      })
      if (seqCandidates.length > 0) {
        const complete = seqCandidates.find((b) => sequenceOf(b).length === buffer.length)
        if (complete && !complete.isContinuous) {
          flushSequence()
          e.preventDefault()
          complete.onPress?.(ctx())
          return
        }
        // Still a prefix (or continuous sequences unsupported): park it.
        sequenceBuffer = buffer
        clearTimeout(sequenceTimer)
        sequenceTimer = setTimeout(flushSequence, SEQUENCE_TIMEOUT_MS)
        return
      }
      flushSequence() // chord breaks every sequence: fall through to singles

      // 2) Continuous hold (WASD camera) — starts immediately, no buffering.
      const continuous = binds.find((b) => b.isContinuous && chordMatches(e, b.defaultKey))
      if (continuous) {
        if (!continuous.when || continuous.when(ctx())) startHold(continuous, chord, e)
        return
      }

      // 3) Plain single chord.
      const single = binds.find((b) => !sequenceOf(b) && !b.isContinuous && chordMatches(e, b.defaultKey))
      if (single && (!single.when || single.when(ctx()))) {
        e.preventDefault()
        single.onPress?.(ctx())
      }
    },

    handleKeyUp(e) {
      const chord = eventChord(e)
      if (chord && held.has(chord)) {
        const bind = held.get(chord)
        held.delete(chord)
        bind.onRelease?.(ctx())
      }
    },

    /** Per-frame tick: drives every held continuous bind. Call from rAF. */
    tick() {
      for (const [, bind] of held) bind.onPress?.(ctx())
    },

    releaseAll() {
      for (const [, bind] of held) bind.onRelease?.(ctx())
      held.clear()
      flushSequence()
    },
  }
}
