import { measureLevel } from './text-layout.js'
import { createRenderer } from './renderer.js'
import * as anchoring from './anchoring.js'
import * as vp from './viewport.js'
import { drawHUD, drawScrollbar, drawWordHighlight, spawnZoomIndicator, updateAndDrawParticles } from './hud.js'

const FONT = '18px Georgia, serif'
const LINE_HEIGHT = 28
const COLUMN_WIDTH = 640
const NODE_GAP = 24
let MAX_LEVEL = 9
const TRANSITION_SPEED = 0.12
const DRAG_PAN_THRESHOLD = 5

let treeData = null
let concepts = []
let measuredLevels = {}
let levelHeights = {}
let currentLevel = 0
let displayLevel = 0
let mouseX = 0
let mouseY = 0
let levelOffsets = {}

let offsetsLocked = false
let lockTimer = 0

// Scrollbar state (right-gutter, canvas-drawn)
let sbHover = false
let sbDragging = false
let sbDragStartY = 0
let sbDragStartOffsetY = 0

let hoveredConcept = null
let hoveredWord = null
let phrasesAtLevel = {}
let trackedConcept = null    // locked during a continuous click-zoom session; cleared on mousemove/scroll
let trackedWord = null       // the exact word the user is hovering; preferred landing target at every zoom level

const canvas = document.getElementById('viewport')
const renderer = createRenderer(canvas)

const view = {
  get width() { return renderer.width },
  get height() { return renderer.height },
  get levelHeights() { return levelHeights },
  get levelOffsets() { return levelOffsets },
  columnWidth: COLUMN_WIDTH,
}

let doc = makeDoc()

// Snapshot of the loaded corpus for the anchoring functions. Rebuilt whenever
// the tree or the concepts change, which also resets its per-load caches.
function makeDoc() {
  return anchoring.createDoc({
    treeData, concepts, measuredLevels, phrasesAtLevel,
    measureText: text => renderer.measureText(text, FONT),
    columnWidth: COLUMN_WIDTH,
    lineHeight: LINE_HEIGHT,
  })
}

const pointer = () => ({ x: mouseX, y: mouseY, screenWidth: renderer.width })
const tracking = () => ({ concept: trackedConcept, word: trackedWord })

function measureAllLevels(tree) {
  const measured = {}, heights = {}
  for (let i = 0; i <= MAX_LEVEL; i++) {
    const ld = tree.levels[String(i)]
    if (!ld) continue
    measured[i] = measureLevel(ld.nodes, FONT, COLUMN_WIDTH, LINE_HEIGHT, NODE_GAP)
    const nodes = measured[i]
    heights[i] = nodes.length > 0 ? nodes[nodes.length - 1].y + nodes[nodes.length - 1].height : 0
  }
  return { measured, heights }
}

// Bindings of the anchoring and viewport functions to the live state. These
// keep the signatures window._sz has always exposed.
const findConceptAtCursor = (level, offsets) => anchoring.findConceptAtCursor(doc, level, offsets, pointer(), tracking())
const hitTestWord = (level, offsets) => anchoring.hitTestWord(doc, level, offsets, pointer())
const findPhraseAtCursor = (level, contentY, contentX) => anchoring.findPhraseAtCursor(doc, level, contentY, contentX)
const getConceptPosition = (concept, level) => anchoring.getConceptPosition(doc, concept, level)
const getConceptCenterPosition = (concept, level) => anchoring.getConceptCenterPosition(doc, concept, level)
const getConceptWordPosition = (concept, level, word, hintChar) => anchoring.getConceptWordPosition(doc, concept, level, word, hintChar)
const defaultOffset = level => vp.defaultOffset(view, level)
const clampOffset = (level, off) => vp.clampOffset(view, level, off)
const getScrollbarGeom = level => vp.getScrollbarGeom(view, level)
const isOnScrollbarThumb = (x, y, level) => vp.isOnScrollbarThumb(view, x, y, level)
const isOnScrollbarTrack = (x, y, level) => vp.isOnScrollbarTrack(view, x, y, level)
const isInTextArea = (x, y) => vp.isInTextArea(view, x, y)
const offsetOf = level => levelOffsets[level] ?? defaultOffset(level)

let mouseDown = false, cursorInTextArea = false
let viewDragArmed = false
let viewDragging = false
let lastPressWasDrag = false
let viewDragStartX = 0
let viewDragStartY = 0
let viewDragStartOffset = { x: 0, y: 0 }

// Ends the click-zoom session so the next zoom re-acquires what is under the cursor.
function clearTracking() { trackedConcept = null; trackedWord = null }

function isFrozen() { return mouseDown || sbDragging || viewDragging || !cursorInTextArea }

function updateCanvasCursor() {
  if (viewDragging || sbDragging) canvas.style.cursor = 'grabbing'
  else if (sbHover) canvas.style.cursor = 'pointer'
  else if (cursorInTextArea) canvas.style.cursor = 'grab'
  else canvas.style.cursor = 'default'
}

function updateHoverAtCursor() {
  const off = offsetOf(currentLevel)
  hoveredWord = cursorInTextArea ? hitTestWord(currentLevel, off) : null
  hoveredConcept = cursorInTextArea ? findConceptAtCursor(currentLevel, off) : null
}

function zoomAtCursor(direction) {
  if (!cursorInTextArea || sbDragging) return false
  if (Math.abs(displayLevel - currentLevel) > 0.5) return false

  const prevLevel = currentLevel
  if (direction > 0 && currentLevel < MAX_LEVEL) currentLevel++
  else if (direction < 0 && currentLevel > 0) currentLevel--
  else return false

  const zoomingIn = currentLevel > prevLevel
  spawnZoomIndicator(mouseX, mouseY, zoomingIn ? 1 : -1)

  // Two cooperating mechanisms:
  //   Concept track — stable identity across a continuous zoom session.
  //   Phrase chain  — per-phrase matchIn/matchOut from embedding similarity,
  //                   used to (a) pick among multiple word occurrences
  //                   inside the concept's anchor and (b) place the cursor
  //                   when the tracked concept has no anchor at the new
  //                   level (e.g. above its min_visible_level).
  const oldOff = offsetOf(prevLevel)
  const { contentX: srcContentX, contentY: srcContentY, baseLeftX } = vp.toContent(pointer(), oldOff, COLUMN_WIDTH)
  let placed = false

  // Phrase-chain projection: follow matchIn/matchOut one step to the new
  // level. Used both as a disambiguation hint and as a fallback placement.
  const srcPhrase = findPhraseAtCursor(prevLevel, srcContentY, srcContentX)
  const targetIdx = zoomingIn ? srcPhrase?.matchIn : srcPhrase?.matchOut
  const projected = (targetIdx != null && targetIdx >= 0)
    ? phrasesAtLevel[currentLevel]?.[targetIdx] ?? null
    : null
  let placedWord = null

  if (!trackedConcept) {
    trackedConcept = findConceptAtCursor(prevLevel, oldOff)
    const hit = hitTestWord(prevLevel, oldOff)
    trackedWord = hit?.word ?? null
  }

  let targetConcept = trackedConcept
  // If the tracked concept has no anchor at the new level, use the
  // phrase-chain projection to place the cursor. Only re-acquire identity
  // when the concept is intentionally invisible at that level; if the data
  // is missing an anchor for a concept that should be visible, keep the
  // lock so it can snap back when the anchor reappears on the next level.
  if (targetConcept && !targetConcept.anchors[String(currentLevel)]) {
    if (projected) {
      levelOffsets[currentLevel] = clampOffset(currentLevel, { x: 0, y: mouseY - projected.y })
      placed = true
    }
    const intentionallyHidden = currentLevel < (targetConcept.min_visible_level ?? 0)
    if (intentionallyHidden) {
      const provisionalOff = offsetOf(currentLevel)
      const reacquired = findConceptAtCursor(currentLevel, provisionalOff)
      if (reacquired) {
        trackedConcept = reacquired
        targetConcept = reacquired
      } else {
        targetConcept = null
      }
    } else {
      targetConcept = null
    }
  }

  if (targetConcept && targetConcept.anchors[String(currentLevel)]) {
    // Disambiguate within-anchor using the phrase-chain projection: when the
    // anchor contains the tracked word several times, pick the occurrence
    // nearest the phrase projection, not just the first one.
    const anchor = targetConcept.anchors[String(currentLevel)]
    let hintChar = null
    if (projected && projected.nodeId === anchor.nodeId) {
      hintChar = Math.floor((projected.charStart + projected.charEnd) / 2)
    }
    const wordPos = anchoring.getTrackedWordPosition(doc, targetConcept, currentLevel, trackedWord, projected, hintChar)
    const pos = wordPos || getConceptCenterPosition(targetConcept, currentLevel)
    if (pos) {
      levelOffsets[currentLevel] = clampOffset(currentLevel, {
        x: mouseX - baseLeftX - pos.contentX,
        y: mouseY - pos.contentY
      })
      placed = true
      if (wordPos) placedWord = wordPos
    }
  }

  // Last resort: pure phrase-chain placement (cursor wasn't on any
  // trackable concept AND the fallback above didn't fire).
  if (!placed && projected) {
    const wordPos = anchoring.getTrackedWordPosition(doc, null, currentLevel, trackedWord, projected, null)
    if (wordPos) placedWord = wordPos
    levelOffsets[currentLevel] = clampOffset(currentLevel, wordPos
      ? { x: mouseX - baseLeftX - wordPos.contentX, y: mouseY - wordPos.contentY }
      : { x: 0, y: mouseY - projected.y })
  }

  // Keep the concept lock on the idea the user is tracking. The same idea can
  // be summarised under a different concept at each level — a word migrates
  // out of one anchor and into another between levels — so when the tracked
  // word was located, re-acquire identity from the concept that actually
  // covers it now instead of freezing on the concept picked at the first zoom.
  if (placedWord && placedWord.nodeId != null && placedWord.charIdx != null) {
    const covering = anchoring.conceptCoveringChar(doc, currentLevel, placedWord.nodeId, placedWord.charIdx)
    if (covering) trackedConcept = covering
  }

  offsetsLocked = true
  lockTimer = 0
  return true
}

function scrollCurrentLevel(deltaY, deltaX = 0) {
  if (sbDragging || Math.abs(displayLevel - currentLevel) > 0.01) return false
  const contentH = levelHeights[currentLevel] || 0
  if (contentH <= renderer.height && Math.abs(deltaX) < 1) return false

  const off = offsetOf(currentLevel)
  levelOffsets[currentLevel] = clampOffset(currentLevel, {
    x: off.x - deltaX,
    y: off.y - deltaY
  })
  clearTracking()
  offsetsLocked = false
  lockTimer = 0
  updateHoverAtCursor()
  return true
}

function syncPointer(e) {
  mouseX = e.clientX
  mouseY = e.clientY
  cursorInTextArea = isInTextArea(mouseX, mouseY)
  updateCanvasCursor()
}

canvas.addEventListener('mousedown', (e) => {
  syncPointer(e)
  const x = mouseX, y = mouseY
  if (e.button === 0 && isOnScrollbarThumb(x, y, currentLevel)) {
    mouseDown = true
    sbDragging = true
    sbDragStartY = y
    sbDragStartOffsetY = offsetOf(currentLevel).y
    updateCanvasCursor()
    e.preventDefault()
    return
  }
  if (e.button === 0 && isOnScrollbarTrack(x, y, currentLevel)) {
    // Page jump toward click point
    const g = getScrollbarGeom(currentLevel)
    const dir = y < g.thumbY ? -1 : 1
    const page = renderer.height * 0.8
    const off = offsetOf(currentLevel)
    levelOffsets[currentLevel] = clampOffset(currentLevel, { x: off.x, y: off.y - dir * page })
    updateHoverAtCursor()
    updateCanvasCursor()
    e.preventDefault()
    return
  }
  if (e.button === 0) {
    mouseDown = true
    lastPressWasDrag = false
    if (cursorInTextArea) {
      viewDragArmed = true
      viewDragging = false
      viewDragStartX = x
      viewDragStartY = y
      viewDragStartOffset = { ...offsetOf(currentLevel) }
    }
    updateCanvasCursor()
  }
  else if (e.button === 2) e.preventDefault()
})

function finishPointerGesture() {
  mouseDown = false
  sbDragging = false
  viewDragArmed = false
  viewDragging = false
  updateHoverAtCursor()
  updateCanvasCursor()
}

canvas.addEventListener('mouseup', finishPointerGesture)
window.addEventListener('mouseup', finishPointerGesture)

// The wheel pans the current level; zoom is on the mouse buttons and +/- keys.
canvas.addEventListener('wheel', (e) => {
  e.preventDefault()
  syncPointer(e)
  scrollCurrentLevel(e.deltaY, e.deltaX)
}, { passive: false })

// Left click zooms out, right click zooms in. A press that turned into a drag
// is a pan, never a zoom: the flag stays set until the next press begins.
canvas.addEventListener('click', (e) => {
  if (e.button !== 0) return
  if (lastPressWasDrag) { e.preventDefault(); return }
  syncPointer(e)
  if (zoomAtCursor(-1)) e.preventDefault()
})

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  syncPointer(e)
  if (cursorInTextArea) zoomAtCursor(1)
})

// Plus and minus keys zoom too (also = and _, so Shift is not needed). The zoom
// centres on the cursor when it is over the text, otherwise on the middle of
// the view. Ctrl/Cmd combos are left alone so browser zoom still works.
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return
  if (e.target?.closest?.('input, textarea, select, [contenteditable]')) return
  const direction = (e.key === '+' || e.key === '=') ? 1 : (e.key === '-' || e.key === '_') ? -1 : 0
  if (!direction) return
  e.preventDefault()
  if (mouseDown || sbDragging || viewDragging) return
  if (cursorInTextArea) { zoomAtCursor(direction); return }
  const saved = { x: mouseX, y: mouseY }
  mouseX = renderer.width / 2
  mouseY = renderer.height / 2
  cursorInTextArea = true
  clearTracking()
  zoomAtCursor(direction)
  mouseX = saved.x
  mouseY = saved.y
  cursorInTextArea = false
})

function onMouseMove(e) {
  const movedX = e.clientX, movedY = e.clientY
  const movedDuringIdle = !mouseDown && !sbDragging && !viewDragging
  // Real cursor motion (>2px) ends the current zoom-tracking session so the
  // next zoom re-acquires whatever concept is now under the cursor.
  if (movedDuringIdle && (Math.abs(movedX - mouseX) > 2 || Math.abs(movedY - mouseY) > 2)) clearTracking()
  mouseX = movedX; mouseY = movedY

  if (viewDragArmed && !sbDragging) {
    const dx = movedX - viewDragStartX
    const dy = movedY - viewDragStartY
    if (!viewDragging && Math.hypot(dx, dy) >= DRAG_PAN_THRESHOLD) {
      viewDragging = true
      lastPressWasDrag = true
      clearTracking()
      offsetsLocked = false
      lockTimer = 0
    }
    if (viewDragging) {
      levelOffsets[currentLevel] = clampOffset(currentLevel, {
        x: viewDragStartOffset.x + dx,
        y: viewDragStartOffset.y + dy
      })
      cursorInTextArea = isInTextArea(mouseX, mouseY)
      hoveredWord = null
      hoveredConcept = null
      updateCanvasCursor()
      e.preventDefault()
      return
    }
  }

  if (sbDragging) {
    const g = getScrollbarGeom(currentLevel)
    if (g) {
      const travel = g.trackH - g.thumbH
      const dy = movedY - sbDragStartY
      const deltaFrac = travel > 0 ? dy / travel : 0
      const newY = sbDragStartOffsetY - deltaFrac * g.scrollRange
      const off = offsetOf(currentLevel)
      levelOffsets[currentLevel] = clampOffset(currentLevel, { x: off.x, y: newY })
    }
    updateCanvasCursor()
    return
  }

  sbHover = isOnScrollbarThumb(movedX, movedY, currentLevel) || isOnScrollbarTrack(movedX, movedY, currentLevel)
  cursorInTextArea = isInTextArea(mouseX, mouseY)
  updateCanvasCursor()
  if (isFrozen() || offsetsLocked) return

  const off = offsetOf(currentLevel)
  hoveredWord = hitTestWord(currentLevel, off)
  hoveredConcept = findConceptAtCursor(currentLevel, off)
}
canvas.addEventListener('mousemove', onMouseMove)
window.addEventListener('mousemove', (e) => { if (sbDragging || viewDragging || viewDragArmed) onMouseMove(e) })

canvas.addEventListener('mouseleave', () => {
  if (!sbDragging && !viewDragging) {
    cursorInTextArea = false
    hoveredWord = null
    hoveredConcept = null
    clearTracking()
    sbHover = false
    updateCanvasCursor()
  }
})
window.addEventListener('resize', () => renderer.resize())

function smoothstep(t) { return t * t * (3 - 2 * t) }

function frame() {
  const diff = currentLevel - displayLevel
  displayLevel += diff * TRANSITION_SPEED
  if (Math.abs(diff) < 0.005) displayLevel = currentLevel
  const isTransitioning = Math.abs(displayLevel - currentLevel) > 0.01

  if (offsetsLocked && !isTransitioning) {
    lockTimer++
    if (lockTimer > 20) { offsetsLocked = false; lockTimer = 0 }
  }

  if (!offsetsLocked && !isTransitioning) {
    const off = levelOffsets[currentLevel]
    if (off) {
      hoveredWord = hitTestWord(currentLevel, off)
      // Only re-detect concept if not locked (concept stays locked through zoom until mouse moves)
      hoveredConcept = findConceptAtCursor(currentLevel, off)
    }
  }

  const baseLevel = Math.floor(displayLevel)
  const nextLevel = Math.min(baseLevel + 1, MAX_LEVEL)
  const t = displayLevel - baseLevel

  renderer.clear()
  if (Object.keys(measuredLevels).length === 0) { requestAnimationFrame(frame); return }

  if (!isTransitioning || baseLevel === nextLevel) {
    const off = offsetOf(currentLevel)
    renderer.drawLevel(measuredLevels[currentLevel], FONT, LINE_HEIGHT, COLUMN_WIDTH, off.x, off.y, 1)
    drawWordHighlight(renderer, hoveredWord)
  } else {
    const blend = smoothstep(t)
    const bo = offsetOf(baseLevel)
    const no = offsetOf(nextLevel)
    renderer.drawLevel(measuredLevels[baseLevel], FONT, LINE_HEIGHT, COLUMN_WIDTH, bo.x, bo.y, 1 - blend)
    renderer.drawLevel(measuredLevels[nextLevel], FONT, LINE_HEIGHT, COLUMN_WIDTH, no.x, no.y, blend)
  }

  updateAndDrawParticles(renderer)
  drawScrollbar(renderer, getScrollbarGeom(currentLevel), sbDragging || sbHover)
  drawHUD(renderer, {
    treeData, maxLevel: MAX_LEVEL, currentLevel, measuredLevels,
    hoveredWord, hoveredConcept, trackedConcept,
  })
  requestAnimationFrame(frame)
}

async function loadTree(jsonPath) {
  try {
    const resp = await fetch(jsonPath)
    if (!resp.ok) throw new Error(`Failed to load: ${jsonPath}`)
    treeData = await resp.json()
  } catch (e) { console.error(e); return }

  MAX_LEVEL = (treeData.levelCount || Object.keys(treeData.levels).length) - 1

  const r = measureAllLevels(treeData)
  measuredLevels = r.measured; levelHeights = r.heights
  phrasesAtLevel = anchoring.buildPhraseIndex(treeData, measuredLevels, MAX_LEVEL, LINE_HEIGHT)
  doc = makeDoc()

  for (let i = 0; i <= MAX_LEVEL; i++) levelOffsets[i] = defaultOffset(i)
  currentLevel = 0; displayLevel = 0
}

async function loadConcepts(basePath) {
  try {
    const resp = await fetch(basePath)
    if (resp.ok) {
      const raw = await resp.json()
      // Older corpora store a bare array; newer ones { concepts, characters, ... }.
      const list = Array.isArray(raw) ? raw : raw?.concepts
      concepts = Array.isArray(list) ? list : []
      console.log(`Loaded ${concepts.length} concepts`)
    } else {
      console.warn('No concepts.json — concept-based zoom disabled')
      concepts = []
    }
  } catch (e) {
    console.warn('Failed to load concepts — concept-based zoom disabled:', e)
    concepts = []
  }
  doc = makeDoc()
}

// Bundled corpora resolve through the build's file map. Texts a reader adds
// (data/library/) appear after the page was built, so they are fetched by
// path from the local dev server instead.
const dataUrl = name => name.startsWith('library/')
  ? `/data/${name}`
  : new URL(`../data/${name}`, import.meta.url).href
// The concepts sidecar of data/<file>: data/<file minus .json>-concepts.json.
const conceptsFileFor = file => file.replace('.json', '-concepts.json')

async function init() {
  const params = new URLSearchParams(window.location.search)
  const file = params.get('file') || 'the-bitter-lesson-auto.json'
  await loadTree(dataUrl(file))
  await loadConcepts(dataUrl(conceptsFileFor(file)))

  const picker = document.getElementById('file-picker')
  if (picker) {
    const openFile = async (newFile) => {
      await loadTree(dataUrl(newFile))
      await loadConcepts(dataUrl(conceptsFileFor(newFile)))
      const url = new URL(window.location)
      url.searchParams.set('file', newFile)
      window.history.replaceState({}, '', url)
    }
    picker.value = file
    picker.addEventListener('change', e => openFile(e.target.value))
    // The "Add a text" panel is page chrome; the headless test DOM has no body.
    if (document.body) import('./add-text.js').then(m => m.initAddText({ picker, openFile }))
  }

  requestAnimationFrame(frame)
}

init()

// Debug exports for headless testing
window._sz = {
  get treeData() { return treeData },
  get concepts() { return concepts },
  get measuredLevels() { return measuredLevels },
  get levelHeights() { return levelHeights },
  get currentLevel() { return currentLevel },
  get displayLevel() { return displayLevel },
  get hoveredConcept() { return hoveredConcept },
  get hoveredWord() { return hoveredWord },
  get levelOffsets() { return levelOffsets },
  get phrasesAtLevel() { return phrasesAtLevel },
  get trackedConcept() { return trackedConcept },
  get trackedWord() { return trackedWord },
  findConceptAtCursor,
  getConceptPosition,
  getConceptCenterPosition,
  getConceptWordPosition,
  findPhraseAtCursor,
  hitTestWord,
  defaultOffset,
  zoomAtCursor,
  scrollCurrentLevel,
  // Test hooks for the regression runner.
  setTrackedConcept(c) { trackedConcept = c },
  setTrackedWord(w) { trackedWord = w },
  clearTrackedConcept: clearTracking,
  getScrollbarGeom,
  isOnScrollbarThumb,
  isOnScrollbarTrack,
  get sbDragging() { return sbDragging },
  get viewDragging() { return viewDragging },
}
