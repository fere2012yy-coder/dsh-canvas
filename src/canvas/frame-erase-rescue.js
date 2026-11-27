/**
 * Frame-erase rescue — the eraser must erase ONLY the frame, never its
 * children.
 *
 * Engine fact (Excalidraw 0.18 `eraseElements`, verified in the shipped dev
 * bundle): on commit an element is deleted when it is pending erasure OR its
 * `frameId` points to a pending frame OR its `containerId` is pending. There
 * is no public hook before that commit (the pending set is private App
 * state), so the rescue runs one step AFTER it: onChange diffs the previous
 * scene against the new one; children that died together with an erased
 * frame are restored — frameless (`frameId: null`) — while the frame itself
 * stays deleted.
 *
 * The rescue is scoped to the ERASER only: a capture-phase `pointerup` arms a
 * short window when the active tool is the eraser, and only a scene change
 * inside that window is treated as an erase commit. Frame deletion through
 * the Delete key (the user's "select + Delete to wipe everything" path) or
 * canvas clearing is left untouched.
 *
 * Undo note: the engine's erase and this restore are two history entries, so
 * one Ctrl+Z after an erase lands on the intermediate "everything erased"
 * state and a second Ctrl+Z reaches the pre-erase state.
 */

/** id → element map of the scene as last seen by `rescueErasedFrames`. */
let prevById = null

/** Forget the previous scene (canvas switch / remount) — never diff across. */
export function resetFrameEraseTracker() {
  prevById = null
}

/**
 * Diff `elements` (the new scene, deleted elements included) against the
 * previously seen one. Returns a replacement elements array when frame
 * children must be resurrected, else null (and the tracker moves forward
 * either way). `fromEraser` gates the whole rescue on an eraser commit.
 */
export function rescueErasedFrames(elements, fromEraser) {
  let rescued = null
  if (fromEraser && prevById) {
    const byId = new Map(elements.map((e) => [e.id, e]))
    // Frames alive before, deleted (in place — the engine keeps erased
    // elements in the scene as isDeleted) now.
    const erasedFrameIds = new Set()
    for (const [id, prev] of prevById) {
      if (prev.type === 'frame' && !prev.isDeleted) {
        const now = byId.get(id)
        if (now && now.isDeleted) erasedFrameIds.add(id)
      }
    }
    if (erasedFrameIds.size) {
      // Children that were alive under those frames and died in this same
      // change (present-and-deleted, so a scene SWITCH can never false-positive).
      const toRescue = new Set()
      for (const [id, prev] of prevById) {
        if (!prev.isDeleted && prev.frameId && erasedFrameIds.has(prev.frameId)) {
          const now = byId.get(id)
          if (now && now.isDeleted) toRescue.add(id)
        }
      }
      if (toRescue.size) {
        rescued = elements.map((e) =>
          toRescue.has(e.id) ? { ...e, isDeleted: false, frameId: null } : e,
        )
      }
    }
  }
  prevById = new Map(elements.map((e) => [e.id, e]))
  return rescued
}
