import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateTree } from '../tools/lib/schema.js'
import { CORPORA, loadTree, smallTree } from './helpers.js'

for (const corpus of CORPORA) {
  test(`validateTree accepts the checked-in ${corpus} corpus`, () => {
    assert.deepEqual(validateTree(loadTree(corpus)), [])
  })
}

test('validateTree accepts the minimal fixture tree', () => {
  assert.deepEqual(validateTree(smallTree()), [])
})

test('validateTree rejects a non-object outright', () => {
  assert.deepEqual(validateTree(null), ['Tree must be a non-null object'])
})

test('validateTree reports a missing title', () => {
  assert.deepEqual(validateTree(smallTree({ title: '' })), ['Missing or empty "title"'])
})

test('validateTree reports levelCount 0', () => {
  assert.ok(validateTree(smallTree({ levelCount: 0 })).includes('"levelCount" must be a positive integer'))
})

test('validateTree stops at a missing levels object', () => {
  assert.deepEqual(validateTree(smallTree({ levels: undefined })), ['Missing "levels" object'])
})

test('validateTree reports a missing level', () => {
  const tree = smallTree({ levelCount: 3 })
  assert.ok(validateTree(tree).includes('Missing level "2"'))
})

test('validateTree reports a node without an id', () => {
  const tree = smallTree()
  delete tree.levels[1].nodes[1].id
  assert.ok(validateTree(tree).includes('Node in level 1 missing "id"'))
})

test('validateTree reports duplicate ids across levels', () => {
  const tree = smallTree()
  tree.levels[1].nodes[1].id = '0-0'
  tree.levels[0].nodes[0].children = ['1-0']
  assert.ok(validateTree(tree).includes('Duplicate node ID: "0-0"'))
})

test('validateTree reports empty text', () => {
  const tree = smallTree()
  tree.levels[1].nodes[0].text = '   '
  assert.deepEqual(validateTree(tree), ['Node "1-0" has empty or missing text'])
})

test('validateTree reports a missing children array', () => {
  const tree = smallTree()
  delete tree.levels[1].nodes[0].children
  assert.deepEqual(validateTree(tree), ['Node "1-0" missing "children" array'])
})

test('validateTree reports a child id that does not exist', () => {
  const tree = smallTree()
  tree.levels[0].nodes[0].children.push('9-9')
  assert.deepEqual(validateTree(tree), ['Node "0-0" references non-existent child "9-9"'])
})

test('validateTree reports a child that is not in the next level', () => {
  const tree = smallTree({ levelCount: 3 })
  tree.levels[1].nodes[0].children = ['2-0']
  tree.levels[1].nodes[1].children = ['2-0']
  tree.levels[2] = { nodes: [{ id: '2-0', text: 'Deep leaf.', children: [] }] }
  tree.levels[0].nodes[0].children.push('2-0')
  assert.deepEqual(validateTree(tree), ['Node "0-0" child "2-0" not in next level 1'])
})

test('validateTree reports orphans below L0', () => {
  const tree = smallTree()
  tree.levels[0].nodes[0].children = ['1-0']
  assert.deepEqual(validateTree(tree), ['Orphaned node: "1-1" (not referenced as a child)'])
})

test('validateTree reports a leaf with children', () => {
  const tree = smallTree()
  tree.levels[1].nodes[0].children = ['1-1']
  assert.deepEqual(validateTree(tree), ['Leaf node "1-0" at max level has non-empty children'])
})
