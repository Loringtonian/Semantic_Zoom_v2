/**
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {number}
 */
export function cosineSim(a, b) {
  let dot = 0, magA = 0, magB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; magA += a[i] * a[i]; magB += b[i] * b[i]
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) + 1e-10)
}

/**
 * Whitespace-separated words, ignoring leading and trailing whitespace.
 * @param {string | null | undefined} text
 * @returns {number}
 */
export function wordCount(text) {
  return (text || '').split(/\s+/).filter(Boolean).length
}
