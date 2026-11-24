import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeTempDir, projectRoot, runTool, smallTree, writeJson } from './helpers.js'

const BASELINE = fs.readFileSync(path.join(projectRoot, 'tests/fixtures/validate-baseline.txt'), 'utf8')
  .split('\n').filter(Boolean)

const lines = (stdout, kind) => stdout.split('\n')
  .map(l => l.trim())
  .filter(l => l.startsWith(kind))
  .sort()

function validate(args) {
  return runTool('tools/validate-data.js', args)
}

// Writes <dir>/doc-auto.json and, unless concepts is null, its -concepts.json sidecar.
function writeCorpus(dir, tree, concepts = []) {
  const treePath = writeJson(path.join(dir, 'doc-auto.json'), tree)
  if (concepts !== null) writeJson(path.join(dir, 'doc-auto-concepts.json'), { concepts })
  return treePath
}

const concept = (anchors, extra = {}) => ({ id: 'c1', label: 'C', anchors, ...extra })

test('validate-data passes the checked-in corpora with exactly the baseline warnings', () => {
  const { status, stdout } = validate([])
  assert.equal(status, 0)
  assert.deepEqual(lines(stdout, 'WARN'), BASELINE)
  assert.deepEqual(lines(stdout, 'ERROR'), [])
  assert.match(stdout, /Validation complete: 0 error\(s\), 0 warning\(s\)\./)
})

test('validate-data --strict passes while the checked-in corpora carry no warnings', () => {
  assert.equal(validate(['--strict']).status, 0)
})

test('a clean tree with in-range anchors reports OK and passes --strict', (t) => {
  const dir = makeTempDir(t)
  const treePath = writeCorpus(dir, smallTree(), [concept({ 1: { nodeId: '1-0', charStart: 0, charEnd: 5 } }, { min_visible_level: 1 })])
  const { status, stdout } = validate([treePath, '--strict'])
  assert.equal(status, 0, stdout)
  assert.match(stdout, /^ {2}OK$/m)
})

test('a concept anchor ending past the node text is an ERROR', (t) => {
  const dir = makeTempDir(t)
  const text = smallTree().levels[1].nodes[0].text
  const treePath = writeCorpus(dir, smallTree(), [concept({ 1: { nodeId: '1-0', charStart: 0, charEnd: text.length + 1 } })])
  const { status, stdout } = validate([treePath])
  assert.equal(status, 1)
  assert.match(stdout, new RegExp(`ERROR .*c1 L1 invalid range 0-${text.length + 1}`))
})

test('a concept anchor on a node id that does not exist is an ERROR', (t) => {
  const dir = makeTempDir(t)
  const treePath = writeCorpus(dir, smallTree(), [concept({ 1: { nodeId: '1-9', charStart: 0, charEnd: 2 } })])
  assert.match(validate([treePath]).stdout, /ERROR .*c1 L1 references missing node 1-9/)
})

test('a concept visible at a level without an anchor there is a WARN', (t) => {
  const dir = makeTempDir(t)
  const treePath = writeCorpus(dir, smallTree(), [concept({}, { min_visible_level: 1 })])
  const { status, stdout } = validate([treePath])
  assert.equal(status, 0)
  assert.deepEqual(lines(stdout, 'WARN').map(l => l.replace(/^WARN .*: /, '')), ['c1 visible at L1 but has no anchor'])
})

test('a missing concepts sidecar is a WARN', (t) => {
  const dir = makeTempDir(t)
  const treePath = writeCorpus(dir, smallTree(), null)
  assert.match(validate([treePath]).stdout, /WARN .*doc-auto\.json: missing .*doc-auto-concepts\.json/)
})

test('a phrase matchIn beyond the next level phrase count is an ERROR', (t) => {
  const dir = makeTempDir(t)
  const tree = smallTree()
  tree.levels[0].nodes[0].phrases = [{ text: 'Root', charStart: 0, charEnd: 4, matchIn: 1, matchOut: -1 }]
  tree.levels[1].nodes[0].phrases = [{ text: 'First', charStart: 0, charEnd: 5, matchIn: -1, matchOut: 0 }]
  const { status, stdout } = validate([writeCorpus(dir, tree)])
  assert.equal(status, 1)
  assert.match(stdout, /ERROR .*L0 phrase 0 matchIn=1 outside L1 count 1/)
})

test('a phrase range outside its node text is an ERROR', (t) => {
  const dir = makeTempDir(t)
  const tree = smallTree()
  tree.levels[1].nodes[0].phrases = [{ text: 'x', charStart: 5, charEnd: 5, matchIn: -1, matchOut: -1 }]
  assert.match(validate([writeCorpus(dir, tree)]).stdout, /ERROR .*phrase 1-0\[0\] has invalid range 5-5/)
})

test('a tree whose non-leaf child links are all empty gets a WARN', (t) => {
  const dir = makeTempDir(t)
  const tree = smallTree()
  tree.levels[0].nodes[0].children = []
  assert.match(validate([writeCorpus(dir, tree)]).stdout, /WARN .*all non-leaf child links are empty/)
})

// Child-link alignment heuristic (VERIFY.md, Fable Round #13).
function misalignedTree(parentCount, parentText = 'alpha bravo charlie delta echo') {
  const parents = [], leaves = []
  for (let i = 0; i < parentCount; i++) {
    parents.push({ id: `0-${i}`, text: parentText, children: [`1-${i}`] })
    leaves.push({ id: `1-${i}`, text: 'zulu yankee xray whiskey victor', children: [] })
  }
  return { title: 'Misaligned', levelCount: 2, levels: { 0: { nodes: parents }, 1: { nodes: leaves } } }
}

test('child-link alignment warns when a parent shares no content words with its children', (t) => {
  const dir = makeTempDir(t)
  const { stdout } = validate([writeCorpus(dir, misalignedTree(1))])
  assert.match(stdout, /WARN .*L0 node 0-0 shares no content words with its children \(1-0\) — child links likely misaligned/)
})

test('child-link alignment caps its warnings at 8 per corpus', (t) => {
  const dir = makeTempDir(t)
  const warnings = lines(validate([writeCorpus(dir, misalignedTree(10))]).stdout, 'WARN')
  assert.equal(warnings.filter(w => w.includes('shares no content words')).length, 8)
})

test('child-link alignment skips parents with fewer than 4 content words (stop words excluded)', (t) => {
  const dir = makeTempDir(t)
  const { stdout } = validate([writeCorpus(dir, misalignedTree(1, 'the and alpha bravo charlie'))])
  assert.doesNotMatch(stdout, /shares no content words/)
})

test('child-link alignment only checks the bottom half of the levels', (t) => {
  // levelCount 5 -> first checked level is floor(4/2) = 2, so an L1 mismatch is ignored.
  const dir = makeTempDir(t)
  const words = ['alpha bravo charlie delta', 'zulu yankee xray whiskey']
  const levels = {}
  for (let L = 0; L < 5; L++) {
    levels[L] = { nodes: [{ id: `${L}-0`, text: words[L === 1 ? 0 : 1], children: L < 4 ? [`${L + 1}-0`] : [] }] }
  }
  const { stdout } = validate([writeCorpus(dir, { title: 'Deep', levelCount: 5, levels })])
  assert.doesNotMatch(stdout, /shares no content words/)
})
