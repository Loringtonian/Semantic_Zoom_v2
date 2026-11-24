import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createDoc, charsBeforeLine, lineIndexForChar, sortsBefore, conceptCoveringChar,
  findConceptAtCursor, findConceptByWord, isNearConceptAnchor, getConceptPosition,
  getConceptCenterPosition, getConceptWordPosition, hitTestWord, buildPhraseIndex,
} from '../src/anchoring.js'
import { cleanWord, tokenizeWords, wordMatchTier, wordsCompatible, wordMatchCandidates, shouldUseProjectedWord } from '../src/words.js'
import {
  toContent, defaultOffset, clampOffset, getScrollbarGeom, isOnScrollbarThumb, isOnScrollbarTrack, isInTextArea,
} from '../src/viewport.js'

const LH = 28
const node = (lines, y = 0) => ({ nodeId: 'n', y, height: lines.length * LH, lines: lines.map(t => ({ text: t, width: t.length * 7 })) })

test('charsBeforeLine sums the lengths of earlier lines', () => {
  const n = node(['abc ', 'de ', 'f'])
  assert.deepEqual([0, 1, 2].map(i => charsBeforeLine(n, i)), [0, 4, 7])
})

test('lineIndexForChar: a char belongs to the line that holds it; a caret at a wrap stays on the earlier line', () => {
  const n = node(['abc ', 'de ', 'f'])
  assert.deepEqual(lineIndexForChar(n, 3), { lineIdx: 0, lineStart: 0 })
  assert.deepEqual(lineIndexForChar(n, 4), { lineIdx: 1, lineStart: 4 })
  assert.deepEqual(lineIndexForChar(n, 4, true), { lineIdx: 0, lineStart: 0 })
  assert.deepEqual(lineIndexForChar(n, 99), { lineIdx: 2, lineStart: 7 })
  assert.deepEqual(lineIndexForChar(n, 99, true), { lineIdx: 2, lineStart: 7 })
  assert.deepEqual(lineIndexForChar(node([]), 0), { lineIdx: -1, lineStart: 0 })
})

test('sortsBefore compares keys in order and keeps ties stable', () => {
  const keys = ['a', 'b']
  assert.equal(sortsBefore({ a: 1, b: 9 }, { a: 2, b: 0 }, keys), true)
  assert.equal(sortsBefore({ a: 2, b: 0 }, { a: 2, b: 1 }, keys), true)
  assert.equal(sortsBefore({ a: 2, b: 1 }, { a: 2, b: 1 }, keys), false)
  assert.equal(sortsBefore({ a: Infinity, b: 0 }, { a: Infinity, b: 1 }, keys), true)
})

test('toContent maps a screen point into the centred column', () => {
  assert.deepEqual(toContent({ x: 500, y: 300, screenWidth: 1400 }, { x: 10, y: 100 }, 640),
    { contentX: 110, contentY: 200, baseLeftX: 380 })
})

test('viewport geometry', () => {
  const view = { width: 1400, height: 900, columnWidth: 640, levelHeights: { 0: 400, 1: 1800 }, levelOffsets: {} }
  assert.deepEqual(defaultOffset(view, 0), { x: 0, y: 250 })
  assert.deepEqual(clampOffset(view, 1, { x: 9999, y: -9999 }), { x: 640, y: -1760 })
  assert.equal(getScrollbarGeom(view, 0), null)
  const g = getScrollbarGeom(view, 1)
  assert.deepEqual(g, { trackX: 1386, trackY: 0, trackH: 900, thumbY: 225, thumbH: 450, scrollRange: 900 })
  assert.equal(isOnScrollbarThumb(view, 1390, 300, 1), true)
  assert.equal(isOnScrollbarThumb(view, 1390, 10, 1), false)
  assert.equal(isOnScrollbarTrack(view, 1390, 10, 1), true)
  assert.equal(isInTextArea(view, 700, 10), true)
  assert.equal(isInTextArea(view, 1383, 10), false)
  assert.equal(isInTextArea(view, 300, 10), false)
})

test('word helpers', () => {
  assert.equal(cleanWord('"Hello,'), 'hello')
  assert.deepEqual(tokenizeWords("Don't stop-me now"), ["don't", 'stop-me', 'now'])
  assert.equal(wordMatchTier('cheating', ['cheated']), 1)
  assert.equal(wordMatchTier('logs', ['log', 'blogs']), 2)
  assert.equal(wordMatchTier('vote', ['vote']), 0)
  assert.equal(wordMatchTier('of', ['of']), null)
  assert.equal(wordsCompatible('Votes.', 'voter'), true)
  assert.equal(wordsCompatible('cat', 'dog'), false)
  assert.deepEqual(wordMatchCandidates('a vote, the votes', 'vote').map(w => w.start), [2])
  assert.deepEqual(wordMatchCandidates('a voter, the votes', 'vote').map(w => w.start), [2, 13])
  assert.deepEqual(wordMatchCandidates('a vote, the vote', 'vote', 5).map(w => w.start), [12])
  assert.equal(shouldUseProjectedWord('the'), false)
  assert.equal(shouldUseProjectedWord('word'), true)
})

// A two-line node and three concepts with nested anchors.
function smallDoc(concepts) {
  const text = 'alpha beta gamma delta epsilon zeta'
  const measured = { 0: [{ nodeId: '0-0', text, y: 0, height: 2 * LH, lines: [
    { text: 'alpha beta gamma ', width: 17 * 7 },
    { text: 'delta epsilon zeta', width: 18 * 7 },
  ] }] }
  const treeData = { levels: { 0: { nodes: [{ id: '0-0', text, phrases: [{ charStart: 0, charEnd: 16 }, { charStart: 17, charEnd: 35 }] }] } } }
  return createDoc({
    treeData, concepts, measuredLevels: measured,
    phrasesAtLevel: buildPhraseIndex(treeData, measured, 0, LH),
    measureText: s => s.length * 7, columnWidth: 640, lineHeight: LH,
  })
}

const concept = (id, charStart, charEnd, extra = {}) => ({ id, label: id, anchors: { 0: { nodeId: '0-0', charStart, charEnd } }, ...extra })

test('createDoc derives maxLevel from the measured levels', () => {
  assert.equal(createDoc({ measuredLevels: {} }).maxLevel, 0)
  assert.equal(createDoc({ measuredLevels: { 0: [], 3: [], 5: [] } }).maxLevel, 5)
})

test('buildPhraseIndex places each phrase on the line holding its first char', () => {
  const doc = smallDoc([])
  assert.deepEqual(doc.phrasesAtLevel[0].map(p => p.y), [0, LH])
})

test('conceptCoveringChar treats charEnd as EXCLUSIVE (shipped behaviour, pinned)', () => {
  const doc = smallDoc([concept('a', 6, 10)])
  assert.equal(conceptCoveringChar(doc, 0, '0-0', 9)?.id, 'a')
  assert.equal(conceptCoveringChar(doc, 0, '0-0', 10), null)
  assert.equal(conceptCoveringChar(doc, 0, '0-0', null), null)
})

test('isNearConceptAnchor treats charEnd as INCLUSIVE, within 160 chars', () => {
  const c = concept('a', 6, 10)
  assert.equal(isNearConceptAnchor({ nodeId: '0-0', charIdx: 10 }, c, 0), true)
  assert.equal(isNearConceptAnchor({ nodeId: '0-0', charIdx: 170 }, c, 0), true)
  assert.equal(isNearConceptAnchor({ nodeId: '0-0', charIdx: 171 }, c, 0), false)
  assert.equal(isNearConceptAnchor({ nodeId: '1-0', charIdx: 8 }, c, 0), false)
})

test('conceptCoveringChar prefers the most specific nested anchor', () => {
  const doc = smallDoc([concept('outer', 0, 35), concept('inner', 6, 16)])
  assert.equal(conceptCoveringChar(doc, 0, '0-0', 8).id, 'inner')
  assert.equal(conceptCoveringChar(doc, 0, '0-0', 20).id, 'outer')
})

test('findConceptAtCursor: containment is end-inclusive and the shortest anchor wins', () => {
  const doc = smallDoc([concept('outer', 0, 35), concept('inner', 6, 10)])
  const pointer = x => ({ x: 380 + x, y: 10, screenWidth: 1400 })
  const off = { x: 0, y: 0 }
  // 'beta' spans chars 6-10; the cursor at 45px is its middle.
  assert.equal(findConceptAtCursor(doc, 0, off, pointer(45), {}).id, 'inner')
  assert.equal(findConceptAtCursor(doc, 0, off, pointer(10), {}).id, 'outer')
})

test('findConceptAtCursor keeps the tracked concept while its word stays near the anchor', () => {
  const outer = concept('outer', 0, 35)
  const doc = smallDoc([outer, concept('inner', 6, 10)])
  const p = { x: 380 + 45, y: 10, screenWidth: 1400 }
  assert.equal(findConceptAtCursor(doc, 0, { x: 0, y: 0 }, p, { concept: outer, word: 'beta' }).id, 'outer')
  assert.equal(findConceptAtCursor(doc, 0, { x: 0, y: 0 }, p, { concept: outer, word: 'zzzz' }).id, 'inner')
})

test('findConceptByWord matches label words and memoises search words per doc', () => {
  const doc = smallDoc([concept('epsilon-thing', 17, 22, { label: 'Epsilon thing' })])
  assert.equal(findConceptByWord(doc, 'Epsilon', 0, 40).id, 'epsilon-thing')
  assert.equal(doc.searchWords.size, 1)
  assert.equal(findConceptByWord(doc, 'qq', 0, 40), null)
})

test('concept and word positions', () => {
  const c = concept('a', 17, 30)
  const doc = smallDoc([c])
  assert.deepEqual(getConceptPosition(doc, c, 0), { contentY: 0, contentX: 17 * 7 })
  const center = getConceptCenterPosition(doc, c, 0)
  assert.equal(center.contentY, LH + LH / 2)
  assert.deepEqual(getConceptWordPosition(doc, c, 0, 'epsilon', null), { contentY: LH + LH / 2, contentX: 9 * 7, nodeId: '0-0', charIdx: 26 })
  assert.equal(getConceptWordPosition(doc, c, 0, 'zeta', null), null)
})

test('hitTestWord returns the word under the pointer with its char range', () => {
  const doc = smallDoc([])
  const hit = hitTestWord(doc, 0, { x: 0, y: 0 }, { x: 380 + 45, y: 10, screenWidth: 1400 })
  assert.equal(hit.word, 'beta')
  assert.deepEqual([hit.charStart, hit.charEnd, hit.lineIdx], [6, 10, 0])
  const second = hitTestWord(doc, 0, { x: 0, y: 0 }, { x: 380 + 45, y: LH + 5, screenWidth: 1400 })
  assert.deepEqual([second.word, second.charStart], ['epsilon', 23])
  assert.equal(hitTestWord(doc, 0, { x: 0, y: 0 }, { x: 100, y: 10, screenWidth: 1400 }), null)
})
