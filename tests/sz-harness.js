// Loads src/main.js in Node behind a fake DOM and replays a fixed script of
// hovers, lookups and click-zoom paths on one corpus. The returned record is
// compared against tests/fixtures/zoom-golden/<corpus>.json, which was
// recorded from main.js before it was split into modules. Text is measured
// at 7px per code point, so layouts differ from a browser but are stable.
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCREEN_W = 1400
const SCREEN_H = 900
const COLUMN_WIDTH = 640
const LINE_HEIGHT = 28
const SETTLE_FRAMES = 40

const measure = s => [...s].length * 7

function fakeCtx() {
  return new Proxy({ measureText: s => ({ width: measure(s) }) }, {
    get: (target, key) => key in target ? target[key] : () => {},
    set: () => true,
  })
}

function installDom(corpus) {
  globalThis.OffscreenCanvas = class { getContext() { return fakeCtx() } }
  const listeners = {}
  const frames = []
  const canvas = {
    clientWidth: SCREEN_W, clientHeight: SCREEN_H, width: 0, height: 0, style: {},
    getContext: () => fakeCtx(),
    addEventListener: (type, fn) => { (listeners['canvas:' + type] ||= []).push(fn) },
  }
  globalThis.document = {
    getElementById: id => (id === 'viewport' ? canvas : null),
    createElement: () => ({ getContext: () => fakeCtx() }),
  }
  globalThis.window = {
    location: { search: `?file=${corpus}-auto.json` },
    devicePixelRatio: 1,
    history: { replaceState() {} },
    addEventListener: (type, fn) => { (listeners['window:' + type] ||= []).push(fn) },
  }
  globalThis.requestAnimationFrame = fn => { frames.push(fn) }
  globalThis.fetch = async url => {
    const file = fileURLToPath(url)
    if (!fs.existsSync(file)) return { ok: false }
    const text = fs.readFileSync(file, 'utf8')
    return { ok: true, json: async () => JSON.parse(text) }
  }
  const origLog = console.log
  console.log = () => {}
  return {
    restoreLog: () => { console.log = origLog },
    fire(type, x, y, extra = {}) {
      const e = { clientX: x, clientY: y, button: 0, deltaX: 0, deltaY: 0, preventDefault() {}, ...extra }
      for (const fn of listeners['canvas:' + type] || []) fn(e)
    },
    fireKey(key, extra = {}) {
      const e = { key, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {}, ...extra }
      for (const fn of listeners['window:keydown'] || []) fn(e)
    },
    runFrames(n) {
      for (let i = 0; i < n; i++) {
        const pending = frames.splice(0)
        for (const fn of pending) fn()
      }
    },
  }
}

const idOf = c => (c ? c.id : null)
const round = n => (typeof n === 'number' ? Math.round(n * 1000) / 1000 : n)
const roundAll = obj => obj && JSON.parse(JSON.stringify(obj, (k, v) => round(v)))

function hitSummary(hit) {
  if (!hit) return null
  return { word: hit.word, nodeId: hit.nodeId, lineIdx: hit.lineIdx, charStart: hit.charStart, charEnd: hit.charEnd, screenRect: roundAll(hit.screenRect) }
}

function phraseSummary(p) {
  return p ? { nodeId: p.nodeId, charStart: p.charStart, charEnd: p.charEnd, y: p.y } : null
}

// Sample points over each level: up to `perLevel` lines, three x positions each.
function samplePoints(nodes, perLevel) {
  const lines = []
  for (const n of nodes) {
    n.lines.forEach((line, i) => lines.push({ n, i, line }))
  }
  const stride = Math.max(1, Math.ceil(lines.length / perLevel))
  const points = []
  for (let k = 0; k < lines.length; k += stride) {
    const { n, i, line } = lines[k]
    const y = n.y + i * LINE_HEIGHT + LINE_HEIGHT / 2
    for (const frac of [0.1, 0.5, 0.9]) points.push({ x: Math.floor(line.width * frac) + 1, y })
  }
  return points
}

export async function runScenario(corpus, mainUrl = new URL('../src/main.js', import.meta.url).href) {
  const dom = installDom(corpus)
  try {
    const url = `${mainUrl}?corpus=${encodeURIComponent(corpus)}`
    await import(url)
    const sz = window._sz
    for (let i = 0; i < 200 && !(sz.treeData && sz.concepts.length); i++) {
      await new Promise(r => setImmediate(r))
    }
    const maxLevel = Math.max(...Object.keys(sz.measuredLevels).map(Number))
    const baseLeftX = (SCREEN_W - COLUMN_WIDTH) / 2
    const record = { corpus, maxLevel, lookups: [], positions: [], paths: [] }

    // 1. Hover lookups at sampled points on every level.
    for (let L = 0; L <= maxLevel; L++) {
      const off = sz.defaultOffset(L)
      for (const p of samplePoints(sz.measuredLevels[L], 60)) {
        const sx = baseLeftX + off.x + p.x, sy = off.y + p.y
        dom.fire('mousemove', sx, sy)
        record.lookups.push({
          L, x: p.x, y: p.y,
          concept: idOf(sz.findConceptAtCursor(L, off)),
          hit: hitSummary(sz.hitTestWord(L, off)),
          phrase: phraseSummary(sz.findPhraseAtCursor(L, p.y, p.x)),
        })
      }
    }

    // 2. Concept positions at every anchored level, plus word positions.
    for (const c of sz.concepts) {
      for (let L = 0; L <= maxLevel; L++) {
        const a = c.anchors[String(L)]
        if (!a) continue
        const node = sz.treeData.levels[String(L)].nodes.find(n => n.id === a.nodeId)
        const words = (node?.text.substring(a.charStart, a.charEnd).match(/[\w'-]+/g) || []).slice(0, 4)
        record.positions.push({
          id: c.id, L,
          pos: roundAll(sz.getConceptPosition(c, L)),
          center: roundAll(sz.getConceptCenterPosition(c, L)),
          words: words.map(w => [w, roundAll(sz.getConceptWordPosition(c, L, w, a.charStart + 5))]),
        })
      }
    }

    // 3. Click-zoom paths. Each path brings a concept's centre on screen at a
    // start level, zooms all the way in, then all the way out.
    const snapshot = () => ({
      level: sz.currentLevel,
      off: roundAll(sz.levelOffsets[sz.currentLevel]),
      tracked: idOf(sz.trackedConcept),
      word: sz.trackedWord,
      hovered: idOf(sz.hoveredConcept),
      hoveredWord: sz.hoveredWord?.word ?? null,
    })
    const zoomTo = target => {
      let guard = 0
      while (sz.currentLevel !== target && guard++ < 20) {
        const before = sz.currentLevel
        if (target > before) dom.fire('contextmenu', mouse.x, mouse.y)
        else dom.fire('click', mouse.x, mouse.y)
        dom.runFrames(SETTLE_FRAMES)
        if (sz.currentLevel === before) break
      }
    }
    const mouse = { x: SCREEN_W / 2, y: SCREEN_H / 2 }
    for (const c of sz.concepts) {
      const start = c.min_visible_level ?? 0
      if (!c.anchors[String(start)]) continue
      zoomTo(start)
      // Reset the session the way a real user does: move the mouse.
      mouse.x += 10
      dom.fire('mousemove', mouse.x, mouse.y)
      const center = sz.getConceptCenterPosition(c, start)
      if (!center) continue
      const off = sz.levelOffsets[start] ?? sz.defaultOffset(start)
      const wantY = SCREEN_H / 2
      sz.scrollCurrentLevel(off.y + center.contentY - wantY, 0)
      dom.runFrames(2)
      const off2 = sz.levelOffsets[start]
      mouse.x = Math.round(baseLeftX + off2.x + center.contentX)
      mouse.y = Math.round(off2.y + center.contentY)
      dom.fire('mousemove', mouse.x, mouse.y)
      dom.runFrames(SETTLE_FRAMES)
      const steps = [snapshot()]
      for (let L = start + 1; L <= maxLevel; L++) { zoomTo(L); steps.push(snapshot()) }
      for (let L = maxLevel - 1; L >= 0; L--) { zoomTo(L); steps.push(snapshot()) }
      record.paths.push({ id: c.id, start, mouse: { ...mouse }, steps })
    }

    // 4. Drag-pan, and the click that ends it, must not change the level.
    const levelBefore = sz.currentLevel
    dom.fire('mousedown', mouse.x, mouse.y)
    for (let i = 1; i <= 5; i++) dom.fire('mousemove', mouse.x + i * 4, mouse.y + i * 6)
    dom.fire('mouseup', mouse.x + 20, mouse.y + 30)
    dom.fire('click', mouse.x + 20, mouse.y + 30)
    dom.runFrames(SETTLE_FRAMES)
    record.pan = { levelBefore, levelAfter: sz.currentLevel, off: roundAll(sz.levelOffsets[sz.currentLevel]) }

    // 4b. One level in, a drag and its closing click must not zoom back out.
    dom.fire('mousemove', SCREEN_W / 2, SCREEN_H / 2)
    dom.runFrames(2)
    const dragBase = sz.currentLevel
    dom.fire('contextmenu', SCREEN_W / 2, SCREEN_H / 2)
    dom.runFrames(SETTLE_FRAMES)
    const dragStart = sz.currentLevel
    dom.fire('mousedown', SCREEN_W / 2, SCREEN_H / 2)
    for (let i = 1; i <= 5; i++) dom.fire('mousemove', SCREEN_W / 2 + i * 2, SCREEN_H / 2 + i * 6)
    dom.fire('mouseup', SCREEN_W / 2 + 10, SCREEN_H / 2 + 30)
    dom.runFrames(2)
    dom.fire('click', SCREEN_W / 2 + 10, SCREEN_H / 2 + 30)
    dom.runFrames(SETTLE_FRAMES)
    const dragEnd = sz.currentLevel
    dom.fire('mousedown', SCREEN_W / 2, SCREEN_H / 2)
    dom.fire('mouseup', SCREEN_W / 2, SCREEN_H / 2)
    dom.fire('click', SCREEN_W / 2, SCREEN_H / 2)
    dom.runFrames(SETTLE_FRAMES)
    record.drag = { base: dragBase, zoomedIn: dragStart, afterDrag: dragEnd, afterPlainClick: sz.currentLevel }

    // 5. The wheel pans; it must not change the level.
    const cx = SCREEN_W / 2, cy = SCREEN_H / 2
    dom.fire('mousemove', cx, cy)
    dom.runFrames(2)
    const wheelStart = sz.currentLevel
    dom.fire('wheel', cx, cy, { deltaY: 120 })
    dom.runFrames(SETTLE_FRAMES)
    record.wheel = { start: wheelStart, after: sz.currentLevel }

    // 6. Plus and minus keys zoom one level each way.
    const keyStart = sz.currentLevel
    dom.fireKey('+')
    dom.runFrames(SETTLE_FRAMES)
    const keyIn = sz.currentLevel
    dom.fireKey('-')
    dom.runFrames(SETTLE_FRAMES)
    record.keys = { start: keyStart, afterPlus: keyIn, afterMinus: sz.currentLevel }

    return record
  } finally {
    dom.restoreLog()
  }
}

// `node tests/sz-harness.js <corpus> <outFile> [mainUrl]` records a golden.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [corpus, out, mainUrl] = process.argv.slice(2)
  const record = await runScenario(corpus, mainUrl)
  fs.writeFileSync(out, JSON.stringify(record) + '\n')
  console.log(`${corpus}: ${record.lookups.length} lookups, ${record.positions.length} positions, ${record.paths.length} paths`)
}
