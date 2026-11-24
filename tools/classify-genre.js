#!/usr/bin/env node
/**
 * Classify a document's primary mode so extract-concepts.js can route
 * to the right analytical schema.
 *
 * One cheap Claude call per document returns one of ten genres.
 * extract-concepts.js routes each genre to a schema-specific signal prompt,
 * with narrative-family genres sharing the tuned short-story prompt where
 * appropriate.
 *
 * Usage:
 *   node tools/classify-genre.js <tree.json>
 *   node tools/classify-genre.js <tree.json> --json
 *
 * Or import `classifyGenre(tree)` — returns a Promise<{genre, confidence, secondary, reasoning}>.
 */

import fs from 'fs'
import path from 'path'
import { callClaude, parseModelJson } from './lib/claude-cli.js'
import { projectRoot, isMainModule } from './lib/paths.js'

const GENRES = [
  'short_story',
  'novella',
  'novel_excerpt',
  'essay',
  'argument',
  'exposition',
  'procedural',
  'research_paper',
  'biography_memoir',
  'reference',
]

const CLASSIFY_PROMPT = (sample) => `You are classifying a document's primary mode so a downstream tool can apply the right analytical schema.

Pick ONE from this list as the PRIMARY genre:
  short_story       — compact narrative fiction (1k-10k words); has a protagonist, events, an arc
  novella           — longer narrative fiction (20k-50k words); multi-arc, still one work
  novel_excerpt     — a chapter or section of a longer novel; part of a larger narrative
  essay             — argumentative non-fiction; thesis + evidence + often personal frame
  argument          — explicitly argumentative (op-ed, polemic); thesis-driven, less narrative frame
  exposition        — explanatory; encyclopedia, explainer, textbook chapter; definition + elaboration
  procedural        — how-to, recipe, manual; prerequisites + steps + outcome
  research_paper    — scientific article, white paper; problem + method + result + significance
  biography_memoir  — life writing, autobiography, memoir; narrative but about a real life
  reference         — Wikipedia-style entry; neutral exposition of a defined topic

If the document blends modes, pick the PRIMARY one (what's the dominant shape?) and name the secondary as well.

Return STRICT JSON — no markdown fences, no commentary, no preamble:
{
  "genre": "<one of the ids above>",
  "confidence": <number between 0 and 1>,
  "secondary": <one of the ids above or null>,
  "reasoning": "<one short sentence>"
}

TEXT SAMPLE (beginning of the document):
"""
${sample}
"""

Return the JSON.`

/**
 * Classify the tree's primary genre.
 * Takes first ~1000 words from the deepest level (full source).
 */
export async function classifyGenre(tree) {
  const maxL = String(tree.levelCount - 1)
  const nodes = tree.levels[maxL]?.nodes || []
  const fullText = nodes.map(n => n.text).join('\n\n')
  const words = fullText.split(/\s+/)
  const sample = words.slice(0, 1000).join(' ')

  // Unlike the other stages, this call pins no model or effort.
  const raw = callClaude(CLASSIFY_PROMPT(sample), { timeoutMs: 120000, pinned: false })
  const parsed = parseModelJson(raw)

  if (!parsed || typeof parsed.genre !== 'string' || !GENRES.includes(parsed.genre)) {
    console.warn('classify-genre: unparseable or invalid response — defaulting to short_story')
    console.warn('  raw (first 200):', (raw || '').substring(0, 200))
    return { genre: 'short_story', confidence: 0.0, secondary: null, reasoning: 'classifier failed; default' }
  }

  return {
    genre: parsed.genre,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    secondary: (parsed.secondary && GENRES.includes(parsed.secondary)) ? parsed.secondary : null,
    reasoning: parsed.reasoning || '',
  }
}

// CLI
if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length < 1 || args.includes('--help')) {
    console.error('Usage: node tools/classify-genre.js <tree.json> [--json]')
    process.exit(1)
  }
  const jsonOnly = args.includes('--json')
  const treePath = path.resolve(projectRoot, args[0])
  const tree = JSON.parse(fs.readFileSync(treePath, 'utf8'))
  const result = await classifyGenre(tree)
  if (jsonOnly) {
    console.log(JSON.stringify(result))
  } else {
    console.log(`Genre:      ${result.genre}`)
    console.log(`Confidence: ${result.confidence}`)
    console.log(`Secondary:  ${result.secondary || '(none)'}`)
    console.log(`Reasoning:  ${result.reasoning}`)
  }
}
