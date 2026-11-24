// Two cheap, model-free ways to place a concept snippet inside a node's text.
// They share names and purpose but are DIFFERENT algorithms with different
// thresholds, and each one decides where anchors land for its own stage, so
// they are kept apart on purpose:
//
//   anchorByWindow   (extract-concepts.js) — literal match, then a 40-char head
//                    (>= 12 chars); fuzzy = best weighted sliding word window.
//   anchorBySentence (rebuild-levels.js)   — literal, whitespace-compacted, then a
//                    48-char head (>= 16 chars); fuzzy = best sentence or sentence
//                    pair by keyword overlap, with a density gate.
//
// Both return {charStart, charEnd, via} or null.

// ---- anchorByWindow ----

function tokenize(s) {
  return (s.toLowerCase().match(/[a-z0-9]+/g) || []).filter(w => w.length > 2)
}

function windowFuzzy(parentText, snippet, label) {
  const STOP = new Set(['the','a','an','and','or','but','of','to','in','on','at','for','by',
    'with','from','as','is','was','were','are','be','been','being','have','has','had',
    'this','that','these','those','it','its','he','she','his','her','him','they','them',
    'their','my','your','our','not','no','do','does','did','will','would','could','should'])
  const sTokens = tokenize(snippet).filter(w => !STOP.has(w))
  const lTokens = tokenize(label).filter(w => !STOP.has(w))
  const weights = new Map()
  for (const t of sTokens) weights.set(t, (weights.get(t) || 0) + 2)
  for (const t of lTokens) weights.set(t, (weights.get(t) || 0) + 1)
  if (weights.size === 0) return null

  const wordRe = /[A-Za-z0-9'-]+/g
  const positions = []
  let m
  while ((m = wordRe.exec(parentText)) !== null) {
    positions.push({ start: m.index, end: m.index + m[0].length, lc: m[0].toLowerCase() })
  }
  if (positions.length === 0) return null

  const winWords = Math.max(4, Math.min(40, sTokens.length || 6))
  let bestStart = 0, bestEnd = 0, bestScore = 0
  for (let i = 0; i + winWords <= positions.length; i++) {
    let score = 0
    for (let j = i; j < i + winWords; j++) {
      const w = weights.get(positions[j].lc)
      if (w) score += w
    }
    if (score > bestScore) {
      bestScore = score
      bestStart = positions[i].start
      bestEnd = positions[i + winWords - 1].end
    }
  }
  if (bestScore === 0) return null
  return { charStart: bestStart, charEnd: bestEnd, score: bestScore, via: 'fuzzy' }
}

function windowLiteral(parentText, snippet) {
  const idx = parentText.indexOf(snippet)
  if (idx !== -1) return { charStart: idx, charEnd: idx + snippet.length, via: 'literal' }
  // Try first ~40 chars (head)
  const head = snippet.substring(0, Math.min(40, snippet.length))
  const idx2 = parentText.indexOf(head)
  if (idx2 !== -1 && head.length >= 12) {
    return { charStart: idx2, charEnd: idx2 + head.length, via: 'literal-head' }
  }
  return null
}

export const anchorByWindow = { literal: windowLiteral, fuzzy: windowFuzzy }

// ---- anchorBySentence ----

const ANCHOR_STOPWORDS = new Set([
  'about', 'after', 'again', 'against', 'also', 'because', 'before', 'being',
  'between', 'could', 'does', 'doing', 'during', 'every', 'from', 'have',
  'into', 'just', 'more', 'most', 'only', 'over', 'same', 'should', 'that',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'through',
  'under', 'what', 'when', 'where', 'which', 'while', 'with', 'would',
])

function keywords(text) {
  return (text || '')
    .toLowerCase()
    .match(/[a-z0-9'-]+/g)?.filter(w => w.length >= 4 && !ANCHOR_STOPWORDS.has(w)) || []
}

function wordMatches(a, b) {
  if (a === b) return true
  if (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5)) return true
  return a.length >= 6 && b.length >= 6 && (a.includes(b) || b.includes(a))
}

function sentenceLiteral(text, snippet) {
  if (!text || !snippet) return null
  const exact = text.indexOf(snippet)
  if (exact !== -1) return { charStart: exact, charEnd: exact + snippet.length, via: 'literal' }

  const compact = snippet.replace(/\s+/g, ' ').trim()
  if (compact && compact !== snippet) {
    const idx = text.indexOf(compact)
    if (idx !== -1) return { charStart: idx, charEnd: idx + compact.length, via: 'literal-compact' }
  }

  const head = compact.substring(0, Math.min(48, compact.length))
  if (head.length >= 16) {
    const idx = text.indexOf(head)
    if (idx !== -1) return { charStart: idx, charEnd: idx + head.length, via: 'literal-head' }
  }
  return null
}

function sentenceSpans(text) {
  const spans = []
  const re = /[^.!?\n]+[.!?]?/g
  let m
  while ((m = re.exec(text)) !== null) {
    const raw = m[0]
    const leading = raw.match(/^\s*/)?.[0].length || 0
    const trailing = raw.match(/\s*$/)?.[0].length || 0
    const start = m.index + leading
    const end = m.index + raw.length - trailing
    if (end > start) spans.push({ start, end, text: text.slice(start, end) })
  }
  if (spans.length === 0 && text.trim()) {
    const start = text.indexOf(text.trim())
    spans.push({ start, end: start + text.trim().length, text: text.trim() })
  }
  return spans
}

function sentenceFuzzy(text, snippet, label) {
  const sourceWords = [...new Set(keywords(`${label || ''} ${snippet || ''}`))]
  if (sourceWords.length < 2) return null

  const spans = sentenceSpans(text)
  const candidates = []
  for (let i = 0; i < spans.length; i++) {
    candidates.push({ start: spans[i].start, end: spans[i].end, text: spans[i].text })
    if (i < spans.length - 1) {
      candidates.push({
        start: spans[i].start,
        end: spans[i + 1].end,
        text: text.slice(spans[i].start, spans[i + 1].end),
      })
    }
  }

  let best = null
  for (const c of candidates) {
    const spanLen = c.end - c.start
    if (spanLen < 12 || spanLen > 600) continue
    const candidateWords = [...new Set(keywords(c.text))]
    if (candidateWords.length === 0) continue
    let overlap = 0
    for (const sw of sourceWords) {
      if (candidateWords.some(cw => wordMatches(sw, cw))) overlap++
    }
    const score = overlap / sourceWords.length
    const density = overlap / candidateWords.length
    if (overlap < 2 || score < 0.34 || density < 0.12) continue
    const rank = score + density * 0.25 - Math.abs(160 - spanLen) / 5000
    if (!best || rank > best.rank) best = { ...c, rank, via: 'fuzzy' }
  }

  if (!best) return null
  return { charStart: best.start, charEnd: best.end, via: best.via }
}

export const anchorBySentence = { literal: sentenceLiteral, fuzzy: sentenceFuzzy }
