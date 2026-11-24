// Screen geometry: level offsets, the canvas-drawn scrollbar and the text area.
// `view` is {width, height, columnWidth, levelHeights, levelOffsets}.

export const SB_WIDTH = 10
export const SB_RIGHT_MARGIN = 4
const SB_MIN_THUMB = 30

// Screen point -> content coordinates of a level drawn at `offsets` in the
// centred column. `pointer` is {x, y, screenWidth}.
export function toContent(pointer, offsets, columnWidth) {
  const baseLeftX = (pointer.screenWidth - columnWidth) / 2
  return {
    contentX: pointer.x - baseLeftX - offsets.x,
    contentY: pointer.y - offsets.y,
    baseLeftX,
  }
}

export function defaultOffset(view, level) {
  return { x: 0, y: (view.height - (view.levelHeights[level] || 0)) / 2 }
}

export function clampOffset(view, level, off) {
  const screenH = view.height, contentH = view.levelHeights[level] || 0, pad = 40
  const y = Math.max(-contentH + pad, Math.min(screenH - pad, off.y))
  const x = Math.max(-view.columnWidth, Math.min(view.columnWidth, off.x))
  return { x, y }
}

// The thumb reflects how much of the level's content is visible and where the
// viewport sits in it. Null when the content fits on screen.
export function getScrollbarGeom(view, level) {
  const screenH = view.height, screenW = view.width
  const contentH = view.levelHeights[level] || 0
  if (contentH <= screenH) return null
  const trackX = screenW - SB_RIGHT_MARGIN - SB_WIDTH
  const trackY = 0
  const trackH = screenH
  const scrollRange = contentH - screenH
  const thumbH = Math.max(SB_MIN_THUMB, (screenH * screenH) / contentH)
  const off = view.levelOffsets[level] ?? defaultOffset(view, level)
  // off.y = 0 → top of content at top of screen. off.y = -(contentH-screenH) → bottom.
  const frac = Math.max(0, Math.min(1, -off.y / scrollRange))
  const thumbY = trackY + frac * (trackH - thumbH)
  return { trackX, trackY, trackH, thumbY, thumbH, scrollRange }
}

export function isOnScrollbarThumb(view, x, y, level) {
  const g = getScrollbarGeom(view, level); if (!g) return false
  return x >= g.trackX && x <= g.trackX + SB_WIDTH && y >= g.thumbY && y <= g.thumbY + g.thumbH
}

export function isOnScrollbarTrack(view, x, y, level) {
  const g = getScrollbarGeom(view, level); if (!g) return false
  return x >= g.trackX && x <= g.trackX + SB_WIDTH && y >= g.trackY && y <= g.trackY + g.trackH
}

export function isInTextArea(view, x, y) {
  const bx = (view.width - view.columnWidth) / 2
  if (x >= view.width - SB_RIGHT_MARGIN - SB_WIDTH - 4) return false
  return x >= bx - 20 && x <= bx + view.columnWidth + 20 && y >= 0 && y <= view.height
}
