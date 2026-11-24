// Phrase-chain maps: every node's text is cut into short phrase windows, and
// each phrase points at its closest phrase one level down (matchIn) and one
// level up (matchOut). charStart/charEnd here are the contract src/anchoring.js
// reads to follow the cursor across levels.
import { cosineSim } from './text.js'

// Windows of up to `windowSize` words, `stride` apart, never crossing a clause
// boundary (punctuation at a word end, or a dash or newline between words).
export function phraseWindows(text, windowSize = 6, stride = 3) {
  const words = []
  const regex = /[^\s—–]+/g  // split at whitespace and em/en-dashes
  let m
  while ((m = regex.exec(text)) !== null) {
    words.push({ start: m.index, end: m.index + m[0].length })
  }
  if (words.length === 0) return []

  // Find clause boundaries: break after words ending in punctuation
  // or when the gap between words contains an em-dash, en-dash or newline
  const breakAfter = new Set()
  for (let i = 0; i < words.length - 1; i++) {
    const wordText = text.substring(words[i].start, words[i].end)
    // Strip trailing quotes/parens to find punctuation underneath
    const stripped = wordText.replace(/["'”’“‘)]+$/, '')
    if (/[,;:.!?]$/.test(stripped)) { breakAfter.add(i); continue }
    const gap = text.substring(words[i].end, words[i + 1].start)
    if (/[—–\n]/.test(gap)) breakAfter.add(i)
  }

  // Build clauses (groups of words between break points)
  const clauses = []
  let clauseStart = 0
  for (let i = 0; i < words.length; i++) {
    if (breakAfter.has(i) || i === words.length - 1) {
      if (i >= clauseStart) clauses.push({ from: clauseStart, to: i })
      clauseStart = i + 1
    }
  }

  // Generate windows within each clause (never crossing clause boundaries)
  const phrases = []
  for (const clause of clauses) {
    for (let i = clause.from; i <= clause.to; i += stride) {
      const end = Math.min(i + windowSize - 1, clause.to)
      const win = words.slice(i, end + 1)
      if (win.length === 0) break
      phrases.push({
        text: text.substring(win[0].start, win[win.length - 1].end),
        charStart: win[0].start,
        charEnd: win[win.length - 1].end
      })
      if (end >= clause.to) break
    }
  }
  return phrases
}

// Phase A: the phrases of every level, flattened in node order, each with its
// embedding and nodeId. `embedText(text)` returns a vector.
/**
 * @param {import('./data-shapes.js').Tree} tree
 * @param {number} totalLevels
 * @param {(text: string) => Promise<ArrayLike<number>>} embedText
 * @param {(phraseCount: number) => void} [onNode]
 */
export async function embedLevelPhrases(tree, totalLevels, embedText, onNode = () => {}) {
  const phrasesByLevel = []
  for (let L = 0; L < totalLevels; L++) {
    const flatPhrases = []
    for (const node of tree.levels[String(L)].nodes) {
      for (const w of phraseWindows(node.text)) {
        const embedding = await embedText(w.text)
        flatPhrases.push({ ...w, embedding, nodeId: node.id })
      }
      onNode(flatPhrases.length)
    }
    phrasesByLevel.push(flatPhrases)
    console.log(`  Level ${L}: ${flatPhrases.length} phrases`)
  }
  return phrasesByLevel
}

export function hasChildLinks(tree, totalLevels) {
  for (let L = 0; L < totalLevels - 1; L++) {
    if (tree.levels[String(L)].nodes.some(n => Array.isArray(n.children) && n.children.length > 0)) return true
  }
  return false
}

// Phase B: set matchIn / matchOut (and their cosine scores) on every phrase.
// Matches stay inside a node's children (zoom in) or its parent (zoom out).
// With `global` the constraint is dropped and any phrase on the adjacent level
// may match. A phrase with no candidate gets -1 and score -Infinity; the last
// level's matchIn and the first level's matchOut are -1 with score 0.
export function matchAdjacentLevels(tree, phrasesByLevel, totalLevels, { global = false } = {}) {
  /** @type {Record<string, string[]>} */
  const childrenOf = {}
  /** @type {Record<string, string>} */
  const parentOf = {}
  for (let L = 0; L < totalLevels - 1; L++) {
    for (const node of tree.levels[String(L)].nodes) {
      const children = Array.isArray(node.children) ? node.children : []
      childrenOf[node.id] = children
      for (const childId of children) parentOf[childId] = node.id
    }
  }

  const bestMatch = (phrase, targets, allowed) => {
    let bestIdx = -1, bestSim = -Infinity
    for (let i = 0; i < targets.length; i++) {
      if (!global && !allowed(targets[i].nodeId)) continue
      const sim = cosineSim(phrase.embedding, targets[i].embedding)
      if (sim > bestSim) { bestSim = sim; bestIdx = i }
    }
    return [bestIdx, bestSim]
  }

  for (let L = 0; L < totalLevels; L++) {
    for (const phrase of phrasesByLevel[L]) {
      if (L < totalLevels - 1) {
        const allowedChildren = new Set(childrenOf[phrase.nodeId] || [])
        ;[phrase.matchIn, phrase.matchInScore] = bestMatch(phrase, phrasesByLevel[L + 1], id => allowedChildren.has(id))
      } else {
        phrase.matchIn = -1
        phrase.matchInScore = 0
      }

      if (L > 0) {
        const parentId = parentOf[phrase.nodeId]
        ;[phrase.matchOut, phrase.matchOutScore] = bestMatch(phrase, phrasesByLevel[L - 1], id => id === parentId)
      } else {
        phrase.matchOut = -1
        phrase.matchOutScore = 0
      }
    }
    console.log(`  Level ${L}: matched`)
  }
}

// Phase C: write each level's phrases back onto its nodes as node.phrases,
// shaped by `toEntry` (embeddings and scores are dropped by default).
export function attachPhrases(tree, phrasesByLevel, totalLevels, toEntry = basicEntry) {
  for (let L = 0; L < totalLevels; L++) {
    let flatIdx = 0
    for (const node of tree.levels[String(L)].nodes) {
      node.phrases = []
      while (flatIdx < phrasesByLevel[L].length && phrasesByLevel[L][flatIdx].nodeId === node.id) {
        node.phrases.push(toEntry(phrasesByLevel[L][flatIdx]))
        flatIdx++
      }
    }
  }
}

function basicEntry(p) {
  return { text: p.text, charStart: p.charStart, charEnd: p.charEnd, matchIn: p.matchIn, matchOut: p.matchOut }
}
