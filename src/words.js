// Word matching used to follow the hovered word across zoom levels.

export function cleanWord(word) {
  return (word || '').replace(/^[^\w'-]+|[^\w'-]+$/g, '').toLowerCase()
}

// Each word of `text` (runs of letters, digits, apostrophes and hyphens) as
// {text, start}, where start is its index in `text`.
export function wordSpans(text) {
  return [...(text || '').matchAll(/[\w'-]+/g)].map(m => ({ text: m[0], start: m.index }))
}

export function tokenizeWords(text) {
  return wordSpans(text).map(w => w.text.toLowerCase())
}

// 0 = exact word, 1 = shares a 4-char stem, 2 = substring either way, null = no match.
export function wordMatchTier(target, words) {
  const clean = cleanWord(target)
  if (clean.length < 3 || words.length === 0) return null
  if (words.includes(clean)) return 0
  if (clean.length >= 4 && words.some(w => w.length >= 4 && w.startsWith(clean.substring(0, 4)))) return 1
  if (clean.length >= 4 && words.some(w => w.length >= 4 && (w.includes(clean) || clean.includes(w)))) return 2
  return null
}

export function wordsCompatible(a, b) {
  const left = cleanWord(a)
  const right = cleanWord(b)
  if (left.length < 2 || right.length < 2) return false
  if (left === right) return true
  if (left.length >= 4 && right.length >= 4 && left.substring(0, 4) === right.substring(0, 4)) return true
  return left.length >= 4 && right.length >= 4 && (left.includes(right) || right.includes(left))
}

// Occurrences of `word` in text[rangeStart, rangeEnd), as {text, textLc, start, end}.
// Tiers, first non-empty wins: exact word, 4-char stem, substring either way.
export function wordMatchCandidates(text, word, rangeStart = 0, rangeEnd = text.length) {
  const clean = cleanWord(word)
  if (clean.length < 2) return []

  const boundedStart = Math.max(0, Math.min(text.length, rangeStart))
  const boundedEnd = Math.max(boundedStart, Math.min(text.length, rangeEnd))
  const slice = text.substring(boundedStart, boundedEnd)

  const words = wordSpans(slice).map(w => ({
    text: w.text,
    textLc: w.text.toLowerCase(),
    start: boundedStart + w.start,
    end: boundedStart + w.start + w.text.length,
  }))
  if (words.length === 0) return []

  const exact = words.filter(w => w.textLc === clean)
  if (exact.length) return exact

  if (clean.length >= 4) {
    const stem = clean.substring(0, 4)
    const stemMatches = words.filter(w => w.textLc.length >= 4 && w.textLc.startsWith(stem))
    if (stemMatches.length) return stemMatches

    const subMatches = words.filter(w => w.textLc.length >= 4 && (w.textLc.includes(clean) || clean.includes(w.textLc)))
    if (subMatches.length) return subMatches
  }

  return []
}

export function shouldUseProjectedWord(word) {
  return cleanWord(word).length >= 4
}
