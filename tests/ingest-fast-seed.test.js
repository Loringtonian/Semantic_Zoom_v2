import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeTempDir, runTool } from './helpers.js'

// --seed-only writes the skeleton tree and exits before any child process
// (extract-concepts / rebuild-levels) could spawn the claude CLI.
function seed(t, text, extraArgs = []) {
  const dir = makeTempDir(t)
  const input = path.join(dir, 'my_test-doc.txt')
  const output = path.join(dir, 'out-auto.json')
  fs.writeFileSync(input, text)
  const result = runTool('tools/ingest-fast.js', [input, '--output', output, '--seed-only', ...extraArgs])
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(fs.readFileSync(output, 'utf8'))
}

const para = (n, w = 'word') => Array(n).fill(w).join(' ')

test('seed tree has empty upper levels and source nodes at Lmax with ids Lmax-i', (t) => {
  const tree = seed(t, `${para(10)}\n\n${para(10)}`, ['--levels', '4'])
  assert.equal(tree.title, 'My test doc')
  assert.equal(tree.levelCount, 4)
  assert.deepEqual([0, 1, 2].map(L => tree.levels[L].nodes), [[], [], []])
  assert.deepEqual(tree.levels[3].nodes, [{ id: '3-0', text: `${para(10)}\n\n${para(10)}`, children: [] }])
})

test('paragraphs are grouped up to max-leaf-words and never split when they fit', (t) => {
  const text = [para(50, 'a'), para(50, 'b'), para(50, 'c')].join('\n\n')
  const nodes = seed(t, text, ['--max-leaf-words', '100']).levels[5].nodes
  assert.deepEqual(nodes.map(n => n.id), ['5-0', '5-1'])
  assert.equal(nodes[0].text, `${para(50, 'a')}\n\n${para(50, 'b')}`)
  assert.equal(nodes[1].text, para(50, 'c'))
})

test('an over-long paragraph is split at sentence ends', (t) => {
  const sentence = `${para(59, 'x')} end.`
  const nodes = seed(t, [sentence, sentence, sentence].join(' '), ['--max-leaf-words', '100']).levels[5].nodes
  assert.deepEqual(nodes.map(n => n.text), [sentence, sentence, sentence])
})

test('--levels below 2 exits 1', (t) => {
  const dir = makeTempDir(t)
  const input = path.join(dir, 'x.txt')
  fs.writeFileSync(input, 'hello')
  const result = runTool('tools/ingest-fast.js', [input, '--output', path.join(dir, 'o.json'), '--seed-only', '--levels', '1'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /--levels must be an integer >= 2/)
  assert.ok(!fs.existsSync(path.join(dir, 'o.json')))
})

test('--max-leaf-words below 80 exits 1', (t) => {
  const dir = makeTempDir(t)
  const input = path.join(dir, 'x.txt')
  fs.writeFileSync(input, 'hello')
  const result = runTool('tools/ingest-fast.js', [input, '--output', path.join(dir, 'o.json'), '--seed-only', '--max-leaf-words', '79'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /--max-leaf-words must be an integer >= 80/)
})
