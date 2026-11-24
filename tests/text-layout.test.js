import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CORPORA, loadTree } from './helpers.js'

// Node has no canvas. pretext only sets ctx.font and calls measureText, so a
// fake OffscreenCanvas measuring 7px per code point makes layout deterministic.
// It must be installed before pretext first asks for a context.
globalThis.OffscreenCanvas = class {
  getContext() {
    return { font: '', measureText: s => ({ width: [...s].length * 7 }) }
  }
}
const { measureLevel } = await import('../src/text-layout.js')

// The values src/main.js passes to measureLevel.
const FONT = '18px Georgia, serif'
const LINE_HEIGHT = 28
const COLUMN_WIDTH = 640
const NODE_GAP = 24

const measure = nodes => measureLevel(nodes, FONT, COLUMN_WIDTH, LINE_HEIGHT, NODE_GAP)

test('measureLevel stacks nodes at cumulative height plus NODE_GAP', () => {
  const nodes = [
    { id: 'a', text: 'short' },
    { id: 'b', text: Array(40).fill('lorem').join(' ') },
    { id: 'c', text: 'tail' },
  ]
  const measured = measure(nodes)
  assert.deepEqual(measured.map(m => m.nodeId), ['a', 'b', 'c'])
  assert.equal(measured[0].y, 0)
  for (let i = 1; i < measured.length; i++) {
    assert.equal(measured[i].y, measured[i - 1].y + measured[i - 1].height + NODE_GAP)
  }
  for (const m of measured) {
    assert.equal(m.height, m.lineCount * LINE_HEIGHT)
    assert.equal(m.lines.length, m.lineCount)
  }
  assert.equal(measured[1].lineCount, 3) // 239 chars * 7px = 1673px over a 640px column
})

test('measureLevel wraps lines within COLUMN_WIDTH and reports each line as {text, width}', () => {
  const [m] = measure([{ id: 'a', text: Array(40).fill('lorem').join(' ') }])
  for (const line of m.lines) {
    assert.equal(typeof line.text, 'string')
    assert.equal(typeof line.width, 'number')
    assert.ok(line.width <= COLUMN_WIDTH, `line width ${line.width}`)
  }
})

// Every charsAcc loop in src/main.js maps a character offset in node.text to a
// (line, column) by summing line.text lengths, which assumes joining the line
// texts gives back node.text. pretext does NOT preserve it: it lays text out
// like CSS `white-space: normal`, collapsing every whitespace run to one space.
// A lone "\n" becomes " " (offsets still line up), but a run such as "\n\n"
// shrinks, so every concept anchor after it lands N chars late on screen.
// BUG (latent, pinned not fixed): 15 nodes across ada-lovelace-wikipedia,
// fair-guiding-principles-excerpt and the-bitter-lesson have such runs.
const collapse = text => text.replace(/\s+/g, ' ')

for (const corpus of CORPORA) {
  test(`joined line texts equal the whitespace-collapsed node text on every ${corpus} node`, () => {
    const tree = loadTree(corpus)
    for (let L = 0; L < tree.levelCount; L++) {
      for (const m of measure(tree.levels[L].nodes)) {
        assert.equal(m.lines.map(l => l.text).join(''), collapse(m.text), `node ${m.nodeId}`)
      }
    }
  })
}

test('BUG: a whitespace run shortens the laid-out text, shifting later char offsets', () => {
  const [single] = measure([{ id: 'a', text: 'one\ntwo' }])
  const [double] = measure([{ id: 'b', text: 'one\n\ntwo' }])
  assert.equal(single.lines.map(l => l.text).join(''), 'one two')
  assert.equal(double.lines.map(l => l.text).join(''), 'one two')
  assert.equal(double.lines.map(l => l.text).join('').length, double.text.length - 1)
})

test('count of real nodes whose laid-out length differs from node.text (the drift surface)', () => {
  let drifting = 0
  for (const corpus of CORPORA) {
    const tree = loadTree(corpus)
    for (let L = 0; L < tree.levelCount; L++) {
      for (const m of measure(tree.levels[L].nodes)) {
        if (m.lines.map(l => l.text).join('').length !== m.text.length) drifting++
      }
    }
  }
  assert.equal(drifting, 15)
})
