// Semantic-zoom anchoring: which concept and word sit under the cursor, and
// where a concept or word lands at another level. Pure functions over a `doc`:
//   {treeData, concepts, measuredLevels, phrasesAtLevel, maxLevel,
//    measureText(text) -> px, columnWidth, lineHeight}
// built with createDoc(). `pointer` is {x, y, screenWidth} in screen pixels and
// `tracked` is the click-zoom session's {concept, word}.
import { toContent } from './viewport.js'
import {
  cleanWord, tokenizeWords, wordSpans, wordMatchTier, wordsCompatible,
  wordMatchCandidates, shouldUseProjectedWord,
} from './words.js'

export function createDoc(fields) {
  const maxLevel = Object.keys(fields.measuredLevels).map(Number).reduce((a, b) => Math.max(a, b), 0)
  return { ...fields, maxLevel, searchWords: new Map() }
}

// Sum of line lengths before line `lineIdx` of a measured node.
export function charsBeforeLine(node, lineIdx) {
  let n = 0
  for (let i = 0; i < lineIdx; i++) n += node.lines[i].text.length
  return n
}

// The line holding character `charIdx`, as {lineIdx, lineStart}. With `caret`
// the index is a caret position, so one sitting exactly at a wrap stays on the
// earlier line. Indexes past the end resolve to the last line; a node with no
// lines gives lineIdx -1.
export function lineIndexForChar(node, charIdx, caret = false) {
  const lines = node.lines
  let start = 0, i = 0
  for (; i < lines.length - 1; i++) {
    const end = start + lines[i].text.length
    if (caret ? charIdx <= end : charIdx < end) break
    start = end
  }
  return { lineIdx: lines.length ? i : -1, lineStart: start }
}

// True when `a` sorts strictly before `b`, comparing `keys` in order.
export function sortsBefore(a, b, keys) {
  for (const k of keys) {
    if (a[k] < b[k]) return true
    if (a[k] !== b[k]) return false
  }
  return false
}

function measuredNode(doc, level, nodeId) {
  return doc.measuredLevels[level]?.find(n => n.nodeId === nodeId) ?? null
}

// The measured node whose vertical band contains `contentY`, or null.
function nodeAtY(nodes, contentY) {
  return nodes.find(node => contentY >= node.y && contentY < node.y + node.height) ?? null
}

// Estimated character index under a content-space point inside `node`: the
// line is picked from Y (clamped to the node), the character from X as a
// fraction of that line's width.
function estimateCharAt(node, contentX, contentY, lineHeight) {
  const lineIdx = Math.max(0, Math.min(node.lines.length - 1,
    Math.floor((contentY - node.y) / lineHeight)))
  const lineStart = charsBeforeLine(node, lineIdx)
  const line = node.lines[lineIdx]
  if (!(line?.width > 0)) return lineStart
  const xFrac = Math.max(0, Math.min(1, contentX / line.width))
  return lineStart + Math.floor(xFrac * line.text.length)
}

// ---- Phrase index ----

export function buildPhraseIndex(tree, measured, maxLevel, lineHeight) {
  const phrasesAtLevel = {}
  for (let L = 0; L <= maxLevel; L++) {
    const levelData = tree.levels[String(L)]
    if (!levelData) continue
    const phrases = []
    for (const node of levelData.nodes) {
      if (!node.phrases) continue
      const mNode = measured[L]?.find(n => n.nodeId === node.id)
      for (const p of node.phrases) {
        phrases.push({
          ...p,
          nodeId: node.id,
          y: mNode ? mNode.y + lineIndexForChar(mNode, p.charStart).lineIdx * lineHeight : 0
        })
      }
    }
    phrasesAtLevel[L] = phrases
  }
  return phrasesAtLevel
}

export function findPhraseAtCursor(doc, level, contentY, contentX) {
  const phrases = doc.phrasesAtLevel[level]
  if (!phrases || phrases.length === 0) return null

  // Step 1: find which node and line the cursor is on
  const nodes = doc.measuredLevels[level]
  if (!nodes) return null

  let cursorNode = nodeAtY(nodes, contentY)
  if (!cursorNode) {
    // Snap to nearest node
    let bestDist = Infinity
    for (const node of nodes) {
      const mid = node.y + node.height / 2
      const dist = Math.abs(contentY - mid)
      if (dist < bestDist) { bestDist = dist; cursorNode = node }
    }
  }
  if (!cursorNode) return null

  // Step 2: estimate character position from line + X
  const cursorChar = estimateCharAt(cursorNode, contentX, contentY, doc.lineHeight)

  // Step 3: find the phrase whose charStart-charEnd range contains cursorChar
  const nodeId = cursorNode.nodeId
  let best = null, bestDist = Infinity
  for (const p of phrases) {
    if (p.nodeId !== nodeId) continue
    // Distance: 0 if cursor is inside the phrase range, else distance to nearest edge
    let dist
    if (cursorChar >= p.charStart && cursorChar <= p.charEnd) {
      dist = 0
    } else {
      dist = Math.min(Math.abs(cursorChar - p.charStart), Math.abs(cursorChar - p.charEnd))
    }
    if (dist < bestDist) { bestDist = dist; best = p }
  }

  return best
}

// ---- Concept lookup ----

export function findConceptAtCursor(doc, level, offsets, pointer, tracked) {
  const nodes = doc.measuredLevels[level]
  if (!nodes || doc.concepts.length === 0) return null

  const { contentX, contentY } = toContent(pointer, offsets, doc.columnWidth)

  let cursorNodeId = null
  let cursorCharIdx = 0

  // Prefer hitTestWord's exact char index — it scans real word widths and
  // returns the word directly under cursor. Linear X-ratio (fallback below)
  // can miss the right word by dozens of chars on wide lines with varying
  // glyph widths, which miscounts containment on short anchor spans.
  const hit = hitTestWord(doc, level, offsets, pointer)
  if (hit) {
    cursorNodeId = hit.nodeId
    cursorCharIdx = Math.floor((hit.charStart + hit.charEnd) / 2)
  }

  if (!cursorNodeId) {
    const node = nodeAtY(nodes, contentY)
    if (node) {
      cursorNodeId = node.nodeId
      cursorCharIdx = estimateCharAt(node, contentX, contentY, doc.lineHeight)
    }
  }

  if (!cursorNodeId) return null

  const lvlStr = String(level)

  // During a click-zoom session, the word under the cursor is the precise
  // interaction target. If that word is still in the tracked concept's
  // neighborhood, keep the tracked identity even when target-level anchors
  // overlap or stop just short of the projected word.
  const trackedAtWord = findTrackedConceptAtWord(level, cursorNodeId, cursorCharIdx, hit, tracked)
  if (trackedAtWord) return trackedAtWord

  // Pass 1: exact char-range containment. Pick the SHORTEST containing anchor
  // when concepts overlap — most specific wins.
  let containing = null
  for (const concept of doc.concepts) {
    const anchor = concept.anchors[lvlStr]
    if (!anchor || anchor.nodeId !== cursorNodeId) continue
    if (cursorCharIdx >= anchor.charStart && cursorCharIdx <= anchor.charEnd) {
      const span = anchor.charEnd - anchor.charStart
      if (!containing || span < containing.span) containing = { concept, span }
    }
  }
  if (containing) return containing.concept

  // Pass 1.5: semantic word fallback. When the cursor is on unanchored
  // text, the exact word under the cursor is still a strong intent signal.
  // Match that word against each concept's label/snippet/anchor text, then
  // prefer the closest current-level anchor when one exists.
  const wordMatched = findConceptByWord(doc, hit?.word, level, contentY)
  if (wordMatched) return wordMatched

  // Pass 2: PHRASE-CHAIN PROJECTION.
  // The cursor sits on unanchored content (most of the story at L0/L1 under
  // the poker-nuts rule). Project the cursor's phrase through matchIn to
  // L_max and ask: at full resolution, what concept does this semantic
  // position belong to? That concept may have no anchor at the current level
  // — that's fine, it's still the right identity for the zoom session.
  // No stem-matching, no spatial proximity — purely embedding chain.
  const phrase = findPhraseAtCursor(doc, level, contentY, contentX)
  if (!phrase) return null
  const Lmax = doc.maxLevel
  let pL = level, pIdx = doc.phrasesAtLevel[level].indexOf(phrase)
  while (pL < Lmax && pIdx >= 0) {
    const p = doc.phrasesAtLevel[pL][pIdx]
    if (!p || p.matchIn == null || p.matchIn < 0) break
    pIdx = p.matchIn
    pL++
  }
  if (pL !== Lmax || pIdx < 0) return null
  const projected = doc.phrasesAtLevel[Lmax][pIdx]
  if (!projected) return null
  const pMid = Math.floor((projected.charStart + projected.charEnd) / 2)
  for (const concept of doc.concepts) {
    const anchor = concept.anchors[String(Lmax)]
    if (!anchor || anchor.nodeId !== projected.nodeId) continue
    if (pMid >= anchor.charStart && pMid <= anchor.charEnd) return concept
  }
  return null
}

function anchorText(doc, concept, level) {
  const anchor = concept.anchors?.[String(level)]
  if (!anchor) return ''
  const node = doc.treeData?.levels?.[String(level)]?.nodes?.find(n => n.id === anchor.nodeId)
  return node ? node.text.substring(anchor.charStart, anchor.charEnd) : ''
}

// Words of the concept's label, snippet and full-resolution anchor text,
// computed once per doc.
function conceptSearchWords(doc, concept) {
  let words = doc.searchWords.get(concept)
  if (!words) {
    const parts = [concept.label, concept.snippet, anchorText(doc, concept, doc.maxLevel)]
    words = tokenizeWords(parts.filter(Boolean).join(' '))
    doc.searchWords.set(concept, words)
  }
  return words
}

function conceptAnchorYDistance(doc, concept, level, contentY) {
  if (!concept.anchors?.[String(level)]) return Infinity
  const pos = getConceptCenterPosition(doc, concept, level)
  return pos ? Math.abs(pos.contentY - contentY) : Infinity
}

const WORD_SCORE_KEYS = ['tier', 'visiblePenalty', 'hiddenPenalty', 'distance', 'span']

export function findConceptByWord(doc, word, level, contentY) {
  const clean = cleanWord(word)
  if (clean.length < 3) return null

  const candidates = []
  for (const concept of doc.concepts) {
    const tier = wordMatchTier(clean, conceptSearchWords(doc, concept))
    if (tier == null) continue
    const distance = conceptAnchorYDistance(doc, concept, level, contentY)
    const visiblePenalty = concept.anchors?.[String(level)] ? 0 : 1
    const minVisible = concept.min_visible_level ?? 0
    const hiddenPenalty = level < minVisible ? 1 : 0
    const span = concept.anchors?.[String(level)]
      ? concept.anchors[String(level)].charEnd - concept.anchors[String(level)].charStart
      : Infinity
    const score = { tier, visiblePenalty, hiddenPenalty, distance, span }
    candidates.push({ concept, score })
  }

  if (candidates.length === 0) return null

  const hasCurrentAnchor = candidates.some(c => c.score.visiblePenalty === 0)
  const eligible = hasCurrentAnchor ? candidates.filter(c => c.score.visiblePenalty === 0) : candidates
  // If the word maps to several concepts and none has a current-level anchor,
  // phrase projection has better local context than first-match ordering.
  if (!hasCurrentAnchor && eligible.length > 1) return null

  let best = null
  for (const candidate of eligible) {
    if (!best || sortsBefore(candidate.score, best.score, WORD_SCORE_KEYS)) best = candidate
  }
  return best?.concept ?? null
}

// Concept whose anchor at `level` covers an exact character position. When
// nested anchors overlap, the most specific (smallest span) wins, matching
// findConceptAtCursor's specificity preference. Used to re-acquire the zoom
// lock when the tracked word moves between concepts across levels.
// Note: charEnd is exclusive here but inclusive in findConceptAtCursor,
// overlapPenaltyAtChar and isNearConceptAnchor. Shipped that way; pinned by tests.
export function conceptCoveringChar(doc, level, nodeId, charIdx) {
  if (nodeId == null || charIdx == null) return null
  let best = null
  for (const concept of doc.concepts) {
    const a = concept.anchors?.[String(level)]
    if (!a || a.nodeId !== nodeId) continue
    if (charIdx < a.charStart || charIdx >= a.charEnd) continue
    const span = a.charEnd - a.charStart
    if (!best || span < best.span) best = { concept, span }
  }
  return best ? best.concept : null
}

// ---- Positions ----

// Top-left of the anchor's first character, in content space.
export function getConceptPosition(doc, concept, level) {
  const anchor = concept.anchors[String(level)]
  if (!anchor) return null
  const node = measuredNode(doc, level, anchor.nodeId)
  if (!node) return null
  if (node.lines.length === 0) return { contentY: node.y, contentX: 0 }

  const { lineIdx, lineStart } = lineIndexForChar(node, anchor.charStart, true)
  const text = node.lines[lineIdx].text
  const prefix = text.substring(0, Math.min(anchor.charStart - lineStart, text.length))
  return { contentY: node.y + lineIdx * doc.lineHeight, contentX: doc.measureText(prefix) }
}

// Content-space position (vertical centre of the line) of a character index
// within a measured node.
function positionAtCharIdx(doc, node, charIdx) {
  if (node.lines.length === 0) return { contentY: node.y + doc.lineHeight / 2, contentX: 0 }
  const { lineIdx, lineStart } = lineIndexForChar(node, charIdx, true)
  const text = node.lines[lineIdx].text
  const prefix = text.substring(0, Math.max(0, Math.min(charIdx - lineStart, text.length)))
  return {
    contentY: node.y + lineIdx * doc.lineHeight + doc.lineHeight / 2,
    contentX: doc.measureText(prefix),
  }
}

function overlapPenaltyAtChar(doc, concept, level, nodeId, charIdx) {
  const target = concept.anchors[String(level)]
  const targetSpan = target.charEnd - target.charStart
  let count = 0
  let weight = 0
  for (const other of doc.concepts) {
    if (other === concept) continue
    const a = other.anchors?.[String(level)]
    if (!a || a.nodeId !== nodeId) continue
    if (charIdx < a.charStart || charIdx > a.charEnd) continue
    const span = a.charEnd - a.charStart
    // Longer enclosing anchors will lose to this target in findConceptAtCursor.
    // Penalize only anchors that are as specific or more specific.
    if (span <= targetSpan) {
      count++
      weight += 1 / Math.max(1, span)
    }
  }
  return { count, weight }
}

const ANCHOR_CHAR_SCORE_KEYS = ['overlapCount', 'overlapWeight', 'edgePenalty', 'centerDist']

function preferredAnchorChar(doc, concept, level, node) {
  const anchor = concept.anchors[String(level)]
  const start = anchor.charStart
  const end = anchor.charEnd
  const mid = Math.floor((start + end) / 2)
  const candidates = new Set([
    mid,
    Math.floor(start + (end - start) * 0.25),
    Math.floor(start + (end - start) * 0.4),
    Math.floor(start + (end - start) * 0.6),
    Math.floor(start + (end - start) * 0.75),
    Math.min(end, start + 12),
    Math.max(start, end - 12),
  ])

  for (const w of wordSpans(node.text.substring(start, end))) {
    candidates.add(start + w.start + Math.floor(w.text.length / 2))
  }

  let best = null
  for (const raw of candidates) {
    const charIdx = Math.max(start, Math.min(end, raw))
    const penalty = overlapPenaltyAtChar(doc, concept, level, anchor.nodeId, charIdx)
    const centerDist = Math.abs(charIdx - mid)
    const edgeDist = Math.min(Math.abs(charIdx - start), Math.abs(end - charIdx))
    const edgePenalty = edgeDist < 2 ? 1 : 0
    const score = { overlapCount: penalty.count, overlapWeight: penalty.weight, edgePenalty, centerDist }
    if (!best || sortsBefore(score, best.score, ANCHOR_CHAR_SCORE_KEYS)) best = { charIdx, score }
  }
  return best?.charIdx ?? mid
}

// Position of a representative character in the anchor span. Prefer the
// center, but avoid positions covered by a more-specific nested concept.
export function getConceptCenterPosition(doc, concept, level) {
  const anchor = concept.anchors[String(level)]
  if (!anchor) return null
  const node = measuredNode(doc, level, anchor.nodeId)
  if (!node) return null
  return positionAtCharIdx(doc, node, preferredAnchorChar(doc, concept, level, node))
}

function pickWordPosition(doc, level, nodeId, matches, hintCharAtLevel) {
  if (!doc.measuredLevels[level] || matches.length === 0) return null
  const node = measuredNode(doc, level, nodeId)
  if (!node) return null

  let best = matches[0]
  if (matches.length > 1 && hintCharAtLevel != null) {
    let bestDist = Infinity
    for (const candidate of matches) {
      const mid = Math.floor((candidate.start + candidate.end) / 2)
      const dist = Math.abs(mid - hintCharAtLevel)
      if (dist < bestDist) {
        bestDist = dist
        best = candidate
      }
    }
  }

  const charIdx = Math.floor((best.start + best.end) / 2)
  return { ...positionAtCharIdx(doc, node, charIdx), nodeId, charIdx }
}

function getWordPositionInNodeRange(doc, level, nodeId, word, hintCharAtLevel, rangeStart, rangeEnd) {
  if (!word || word.length < 2) return null
  const node = doc.treeData?.levels?.[String(level)]?.nodes?.find(n => n.id === nodeId)
  if (!node) return null
  const matches = wordMatchCandidates(node.text, word, rangeStart, rangeEnd)
  return pickWordPosition(doc, level, nodeId, matches, hintCharAtLevel)
}

// The word inside the projected phrase, or anywhere in its node with `wholeNode`.
function getProjectedWordPosition(doc, level, word, projected, wholeNode) {
  if (!projected) return null
  const hint = Math.floor((projected.charStart + projected.charEnd) / 2)
  const [start, end] = wholeNode ? [0, Infinity] : [projected.charStart, projected.charEnd]
  return getWordPositionInNodeRange(doc, level, projected.nodeId, word, hint, start, end)
}

export function isNearConceptAnchor(pos, concept, level, maxDistance = 160) {
  if (!pos || !concept) return false
  const anchor = concept.anchors?.[String(level)]
  if (!anchor || anchor.nodeId !== pos.nodeId || pos.charIdx == null) return false
  if (pos.charIdx >= anchor.charStart && pos.charIdx <= anchor.charEnd) return true
  return Math.min(Math.abs(pos.charIdx - anchor.charStart), Math.abs(pos.charIdx - anchor.charEnd)) <= maxDistance
}

function findTrackedConceptAtWord(level, cursorNodeId, cursorCharIdx, hit, tracked) {
  if (!tracked?.concept || !tracked.word || !hit?.word) return null
  if (!wordsCompatible(hit.word, tracked.word)) return null
  const pos = { nodeId: cursorNodeId, charIdx: cursorCharIdx }
  return isNearConceptAnchor(pos, tracked.concept, level) ? tracked.concept : null
}

// Where the tracked word lands at `level`, trying in order: inside the
// projected phrase, inside the target concept's anchor, anywhere in the
// projected phrase's node. Phrase hits must stay near the target's anchor.
export function getTrackedWordPosition(doc, targetConcept, level, word, projected, hintCharAtLevel) {
  if (!word) return null

  const projectedPhraseWord = getProjectedWordPosition(doc, level, word, projected, false)
  if (projectedPhraseWord && (!targetConcept || isNearConceptAnchor(projectedPhraseWord, targetConcept, level))) {
    return projectedPhraseWord
  }

  if (targetConcept) {
    const anchorWord = getConceptWordPosition(doc, targetConcept, level, word, hintCharAtLevel)
    if (anchorWord) return anchorWord
  }

  if (!shouldUseProjectedWord(word)) return null
  const projectedNodeWord = getProjectedWordPosition(doc, level, word, projected, true)
  if (projectedNodeWord && (!targetConcept || isNearConceptAnchor(projectedNodeWord, targetConcept, level))) {
    return projectedNodeWord
  }

  return null
}

// If `word` (or a stem-equivalent) appears inside the concept's anchor text at
// `level`, return the content-space position of that occurrence, else null.
// Matching tiers, first match wins: exact word, shared 4-char stem, substring
// either way (see wordMatchCandidates). hintCharAtLevel is the phrase-chain
// projected char in the anchor node's text; when the word occurs several
// times inside the anchor, the occurrence nearest the hint wins.
export function getConceptWordPosition(doc, concept, level, word, hintCharAtLevel) {
  if (!word || word.length < 2) return null
  const anchor = concept.anchors[String(level)]
  if (!anchor) return null
  return getWordPositionInNodeRange(doc, level, anchor.nodeId, word, hintCharAtLevel, anchor.charStart, anchor.charEnd)
}

// ---- Hit testing ----

export function hitTestWord(doc, level, offsets, pointer) {
  const nodes = doc.measuredLevels[level]
  if (!nodes) return null
  const { contentX, contentY, baseLeftX } = toContent(pointer, offsets, doc.columnWidth)
  if (contentX < 0 || contentX > doc.columnWidth) return null

  const hitNode = nodeAtY(nodes, contentY)
  if (!hitNode) return null

  const lineIdx = Math.floor((contentY - hitNode.y) / doc.lineHeight)
  if (lineIdx < 0 || lineIdx >= hitNode.lines.length) return null

  const lineStart = charsBeforeLine(hitNode, lineIdx)
  const regex = /(\S+)(\s*)/g
  let match, accWidth = 0
  while ((match = regex.exec(hitNode.lines[lineIdx].text)) !== null) {
    const wt = match[1], tr = match[2]
    const ww = doc.measureText(wt)
    const tw = doc.measureText(tr)
    if (contentX >= accWidth && contentX < accWidth + ww) {
      return {
        word: wt, nodeId: hitNode.nodeId, lineIdx,
        charStart: lineStart + match.index,
        charEnd: lineStart + match.index + wt.length,
        screenRect: {
          x: baseLeftX + offsets.x + accWidth,
          y: hitNode.y + lineIdx * doc.lineHeight + offsets.y,
          w: ww, h: doc.lineHeight
        }
      }
    }
    accWidth += ww + tw
  }
  return null
}
