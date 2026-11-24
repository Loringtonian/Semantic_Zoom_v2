#!/usr/bin/env node
/**
 * Add pre-computed phrase maps to an existing tree JSON.
 * Works on both hand-crafted and auto-generated trees.
 *
 * Usage:
 *   node tools/add-phrase-maps.js <tree.json>
 */

import fs from 'fs'
import path from 'path'
import { projectRoot } from './lib/paths.js'
import { createEmbedder } from './lib/embed.js'
import { embedLevelPhrases, hasChildLinks, matchAdjacentLevels, attachPhrases } from './lib/phrase-maps.js'

const args = process.argv.slice(2)
if (!args[0]) {
  console.error('Usage: node tools/add-phrase-maps.js <tree.json>')
  process.exit(1)
}

const inputPath = path.resolve(projectRoot, args[0])

console.log(`\nAdding phrase maps to: ${inputPath}\n`)

const tree = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
const totalLevels = tree.levelCount || Object.keys(tree.levels).length

console.log('Loading embedding model...')
const embedText = await createEmbedder()

// Phase A: Generate phrases and embed
const phrasesByLevel = await embedLevelPhrases(tree, totalLevels, embedText)

// Phase B: Compute cross-level matches. Prefer tree-constrained matching
// when parent/child links exist; fall back to global matching for rebuilt
// trees that currently lack children.
console.log('\nComputing cross-level matches...')
const linked = hasChildLinks(tree, totalLevels)
if (!linked) {
  console.warn('  warning: no child links found; phrase matching will be global across adjacent levels')
}
matchAdjacentLevels(tree, phrasesByLevel, totalLevels, { global: !linked })

// Phase C: Attach to tree nodes (without embeddings)
attachPhrases(tree, phrasesByLevel, totalLevels)

const totalPhrases = phrasesByLevel.reduce((s, l) => s + l.length, 0)
console.log(`\n${totalPhrases} total phrases mapped.`)

fs.writeFileSync(inputPath, JSON.stringify(tree, null, 2))
console.log(`Written: ${inputPath}`)
