import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { CORPORA, loadTree, makeTempDir, writeJson, runTool, smallTree, installFakeClaude, projectRoot } from './helpers.js'
import { callClaude, callClaudeAsync, claudeArgs, parseModelJson } from '../tools/lib/claude-cli.js'
import { phraseWindows, matchAdjacentLevels, attachPhrases, hasChildLinks } from '../tools/lib/phrase-maps.js'
import { anchorByWindow, anchorBySentence } from '../tools/lib/anchors.js'
import { cosineSim, wordCount } from '../tools/lib/text.js'
import { projectRoot as libRoot, isMainModule } from '../tools/lib/paths.js'
import { identifyAndAnchorAtLmax } from '../tools/extract-concepts.js'

test('text helpers', () => {
  assert.equal(wordCount('  two words \n'), 2)
  assert.equal(wordCount(''), 0)
  assert.equal(wordCount(null), 0)
  assert.ok(Math.abs(cosineSim([1, 0], [1, 0]) - 1) < 1e-9)
  assert.equal(cosineSim([1, 0], [0, 1]), 0)
})

test('paths helpers', () => {
  assert.equal(libRoot, projectRoot)
  assert.equal(isMainModule(new URL('../tools/lib/text.js', import.meta.url).href), false)
})

test('claudeArgs pins sonnet / medium unless MODEL / EFFORT override; unpinned is the bare call', () => {
  const saved = { MODEL: process.env.MODEL, EFFORT: process.env.EFFORT }
  delete process.env.MODEL; delete process.env.EFFORT
  assert.deepEqual(claudeArgs(), ['-p', '--output-format', 'text', '--exclude-dynamic-system-prompt-sections', '--effort', 'medium', '--model', 'sonnet'])
  process.env.MODEL = "it's"; process.env.EFFORT = 'low'
  assert.deepEqual(claudeArgs().slice(-4), ['--effort', 'low', '--model', "it's"])
  assert.deepEqual(claudeArgs({ pinned: false }), ['-p', '--output-format', 'text'])
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
})

test('callClaude and callClaudeAsync send the prompt on stdin and return the trimmed reply', async (t) => {
  const fake = installFakeClaude(t, '  hello  \n')
  assert.equal(callClaude('prompt one', { timeoutMs: 10000 }), 'hello')
  assert.equal(fake.prompt(), 'prompt one')
  assert.equal(await callClaudeAsync('prompt two', { label: 'x', timeoutMs: 10000 }), 'hello')
  assert.equal(fake.prompt(), 'prompt two')
})

test('callClaude and callClaudeAsync work without a timeoutMs', async (t) => {
  installFakeClaude(t, 'hi')
  assert.equal(callClaude('p'), 'hi')
  assert.equal(await callClaudeAsync('p'), 'hi')
})

test('callClaude returns null on an empty reply or a missing CLI', async (t) => {
  installFakeClaude(t, '   ')
  assert.equal(callClaude('p', { timeoutMs: 10000 }), null)
  assert.equal(await callClaudeAsync('p', { timeoutMs: 10000 }), null)
  process.env.PATH = '/nonexistent'
  assert.equal(callClaude('p', { timeoutMs: 10000 }), null)
  assert.equal(await callClaudeAsync('p', { timeoutMs: 10000 }), null)
})

test('parseModelJson: fences, surrounding prose, arrays only when allowed', () => {
  assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(parseModelJson('Sure: {"a":1} done'), { a: 1 })
  assert.equal(parseModelJson('nothing here'), null)
  assert.equal(parseModelJson(''), null)
  assert.deepEqual(parseModelJson('[1,2]'), [1, 2])
  assert.equal(parseModelJson('Here: [1,2] ok'), null)
  assert.deepEqual(parseModelJson('Here: [1,2] ok', { allowArray: true }), [1, 2])
  assert.deepEqual(parseModelJson('x {"a":[1]} y', { allowArray: true }), { a: [1] })
})

// The checked-in phrases were produced by phraseWindows; every node must reproduce them.
for (const corpus of CORPORA) {
  test(`phraseWindows reproduces the checked-in phrase ranges on ${corpus}`, () => {
    const tree = loadTree(corpus)
    for (const L of Object.keys(tree.levels)) {
      for (const node of tree.levels[L].nodes) {
        const got = phraseWindows(node.text).map(p => [p.text, p.charStart, p.charEnd])
        const want = (node.phrases || []).map(p => [p.text, p.charStart, p.charEnd])
        assert.deepEqual(got, want, `node ${node.id}`)
      }
    }
  })
}

function phraseFixture(children) {
  const tree = { levelCount: 2, levels: {
    0: { nodes: [{ id: '0-0', text: 'a', children }] },
    1: { nodes: [{ id: '1-0', text: 'b' }, { id: '1-1', text: 'c' }] },
  } }
  const byLevel = [
    [{ text: 'a', charStart: 0, charEnd: 1, nodeId: '0-0', embedding: [1, 0] }],
    [
      { text: 'b', charStart: 0, charEnd: 1, nodeId: '1-0', embedding: [0, 1] },
      { text: 'c', charStart: 0, charEnd: 1, nodeId: '1-1', embedding: [1, 0.1] },
    ],
  ]
  return { tree, byLevel }
}

test('matchAdjacentLevels stays inside child/parent links', () => {
  const { tree, byLevel } = phraseFixture(['1-0'])
  assert.equal(hasChildLinks(tree, 2), true)
  matchAdjacentLevels(tree, byLevel, 2)
  assert.equal(byLevel[0][0].matchIn, 0)          // only 1-0 is a child, though 1-1 is closer
  assert.equal(byLevel[0][0].matchOut, -1)
  assert.equal(byLevel[1][0].matchOut, 0)
  assert.equal(byLevel[1][1].matchOut, -1)        // 1-1 has no parent
  assert.equal(byLevel[1][1].matchOutScore, -Infinity)
  assert.equal(byLevel[1][0].matchIn, -1)
  assert.equal(byLevel[1][0].matchInScore, 0)
})

test('matchAdjacentLevels with global matches across the whole adjacent level', () => {
  const { tree, byLevel } = phraseFixture([])
  assert.equal(hasChildLinks(tree, 2), false)
  matchAdjacentLevels(tree, byLevel, 2, { global: true })
  assert.equal(byLevel[0][0].matchIn, 1)
  assert.equal(byLevel[1][0].matchOut, 0)
})

test('attachPhrases writes node.phrases without embeddings, or via a custom entry', () => {
  const { tree, byLevel } = phraseFixture(['1-0'])
  matchAdjacentLevels(tree, byLevel, 2)
  attachPhrases(tree, byLevel, 2)
  assert.deepEqual(tree.levels[0].nodes[0].phrases, [{ text: 'a', charStart: 0, charEnd: 1, matchIn: 0, matchOut: -1 }])
  attachPhrases(tree, byLevel, 2, p => ({ t: p.text }))
  assert.deepEqual(tree.levels[1].nodes[1].phrases, [{ t: 'c' }])
})

test('the two anchor families are different algorithms (kept apart on purpose)', () => {
  const text = 'The council met at dawn.  It voted to   close the old mill forever.'
  // Whitespace-compacted literal match exists only in the sentence family.
  assert.equal(anchorByWindow.literal(text, 'voted to close the old mill'), null)
  assert.deepEqual(anchorBySentence.literal(text, 'voted to   close the old mill'), { charStart: 29, charEnd: 58, via: 'literal' })
  // Head fallback: the first 40 chars vs the whitespace-compacted first 48.
  const snippet = text.substring(0, 40) + 'ZZZ'
  assert.deepEqual(anchorByWindow.literal(text, snippet), { charStart: 0, charEnd: 40, via: 'literal-head' })
  assert.equal(anchorBySentence.literal(text, snippet), null)
  // Fuzzy: best 4-word window vs best sentence pair.
  assert.deepEqual(anchorByWindow.fuzzy(text, 'council voted close mill', 'mill closure'),
    { charStart: 40, charEnd: 58, score: 5, via: 'fuzzy' })
  assert.deepEqual(anchorBySentence.fuzzy(text, 'council voted close mill', 'mill closure'),
    { charStart: 0, charEnd: 67, via: 'fuzzy' })
})

const CANNED = JSON.stringify({
  events: [
    { id: 'e1', label: 'First leaf', nodeId: '1-0', snippet: 'First leaf', min_visible_level: 0 },
    { id: 'missing', label: 'Gone', nodeId: '1-9', snippet: 'x', min_visible_level: 1 },
  ],
  characters: { Ann: 'the narrator' },
  thematic_thrust: '  a thrust  ',
  voice_anchors: [{ nodeId: '1-0', snippet: 'First', note: 'n' }, { bad: true }],
})

test('identifyAndAnchorAtLmax returns concepts plus characters, thrust and voice anchors without touching the tree', (t) => {
  installFakeClaude(t, CANNED)
  const tree = smallTree()
  const result = identifyAndAnchorAtLmax(tree, 8, 'short_story')
  assert.deepEqual(result.concepts.map(c => [c.id, c.snippet, c.min_visible_level, c.lmaxAnchor]),
    [['e1', 'First leaf', 0, { nodeId: '1-0', charStart: 0, charEnd: 10 }]])
  assert.deepEqual(result.characters, { Ann: 'the narrator' })
  assert.equal(result.thematicThrust, 'a thrust')
  assert.deepEqual(result.voiceAnchors, [{ nodeId: '1-0', snippet: 'First', note: 'n' }])
  assert.deepEqual(Object.keys(tree).filter(k => k.startsWith('_')), [])
})

test('extract-concepts --identify-only writes the concepts file shape', (t) => {
  installFakeClaude(t, CANNED)
  const dir = makeTempDir(t)
  const treePath = writeJson(path.join(dir, 'doc-auto.json'), smallTree())
  const out = path.join(dir, 'out.json')
  const result = runTool('tools/extract-concepts.js', [treePath, '--identify-only', '--output', out])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), {
    genre: { genre: 'short_story', confidence: 0, secondary: null, reasoning: 'classifier failed; default' },
    thematic_thrust: 'a thrust',
    characters: { Ann: 'the narrator' },
    voice_anchors: [{ nodeId: '1-0', snippet: 'First', note: 'n' }],
    concepts: [{ id: 'e1', label: 'First leaf', min_visible_level: 0, anchors: { 1: { nodeId: '1-0', charStart: 0, charEnd: 10 } }, snippet: 'First leaf' }],
  })
})

test('validateCorpus runs in-process: 0 errors and 0 warnings over the checked-in corpora', async () => {
  const { validateCorpus } = await import('../tools/validate-data.js')
  let errors = 0, warnings = 0
  for (const corpus of CORPORA) {
    const bucket = validateCorpus(path.join(projectRoot, 'data', `${corpus}-auto.json`))
    errors += bucket.errors.length
    warnings += bucket.warnings.length
  }
  assert.equal(errors, 0)
  assert.equal(warnings, 0)
})
