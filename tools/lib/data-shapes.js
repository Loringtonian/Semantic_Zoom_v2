/**
 * The JSON data contract shared by the build tools and the reader.
 *
 * @typedef {{ nodeId: string, charStart: number, charEnd: number }} Anchor
 *   A character range inside one node's text, written as text.substring(charStart, charEnd).
 *
 * @typedef {{ text: string, charStart: number, charEnd: number, matchIn: number, matchOut: number }} Phrase
 *   At level L, matchIn indexes level L+1's flattened phrase list and matchOut level L-1's; -1 = no match.
 *
 * @typedef {{ id: string, text: string, children?: string[], phrases?: Phrase[] }} TreeNode
 *
 * @typedef {{ title: string, levelCount: number, levels: Record<string, { nodes: TreeNode[] }> }} Tree
 *   data/<doc>-auto.json. Level "0" is the most compressed; levelCount - 1 is the full text.
 *
 * @typedef {{ id: string, label: string, min_visible_level?: number, anchors: Record<string, Anchor>,
 *   snippet?: string, type?: string, collapse_axes?: string[] }} Concept
 *
 * @typedef {{ genre: string, confidence: number, secondary: string | null, reasoning: string }} GenreResult
 *   What tools/classify-genre.js classifyGenre returns.
 *
 * @typedef {{ nodeId: string, snippet: string, note?: string }} VoiceAnchor
 *
 * @typedef {Concept[] | { concepts: Concept[], genre?: GenreResult, thematic_thrust?: string,
 *   characters?: Record<string, string>, voice_anchors?: VoiceAnchor[] }} ConceptsFile
 *   data/<doc>-auto-concepts.json. Older corpora store the bare array.
 */

/**
 * Number of levels, falling back to counting `levels` keys when levelCount is absent.
 * @param {Partial<Tree>} tree
 * @returns {number}
 */
export function levelCountOf(tree) {
  return tree.levelCount ?? Object.keys(tree.levels || {}).length
}

/**
 * The concept list from either ConceptsFile shape; undefined when `raw` holds neither.
 * @param {ConceptsFile | null | undefined} raw
 * @returns {Concept[] | undefined}
 */
export function conceptsOf(raw) {
  return Array.isArray(raw) ? raw : raw?.concepts
}
