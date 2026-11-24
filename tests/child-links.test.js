import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rebuildLinearChildLinks } from '../tools/lib/child-links.js'
import { CORPORA, loadTree } from './helpers.js'

function childrenByLevel(tree) {
  return Object.fromEntries(Object.entries(tree.levels)
    .map(([L, level]) => [L, level.nodes.map(n => n.children)]))
}

for (const corpus of CORPORA) {
  test(`rebuildLinearChildLinks reproduces the checked-in child links of ${corpus}`, () => {
    const tree = loadTree(corpus)
    const expected = childrenByLevel(tree)
    const rebuilt = structuredClone(tree)
    rebuilt.levels[String(tree.levelCount - 1)].nodes.forEach(n => { n.children = ['stale'] })

    rebuildLinearChildLinks(rebuilt)

    assert.deepEqual(childrenByLevel(rebuilt), expected)
    for (const leaf of rebuilt.levels[String(tree.levelCount - 1)].nodes) {
      assert.deepEqual(leaf.children, [])
    }
  })
}

const node = (id, words) => ({ id, text: Array(words).fill('w').join(' '), children: [] })

test('rebuildLinearChildLinks assigns each child to the parent its span overlaps most', () => {
  const tree = {
    levelCount: 2,
    levels: {
      0: { nodes: [node('0-0', 1), node('0-1', 1)] },
      1: { nodes: [node('1-0', 1), node('1-1', 1), node('1-2', 1), node('1-3', 1)] },
    },
  }
  const { totalLinks } = rebuildLinearChildLinks(tree)
  assert.deepEqual(tree.levels[0].nodes.map(n => n.children), [['1-0', '1-1'], ['1-2', '1-3']])
  assert.equal(totalLinks, 4)
})

test('a parent that wins no child still gets its nearest child (duplicating a link)', () => {
  // One long child covers the whole level; both parents overlap it equally,
  // the midpoint tie-break gives it to the first, and the fallback hands the
  // same child to the second so every parent stays navigable.
  const tree = {
    levelCount: 2,
    levels: {
      0: { nodes: [node('0-0', 1), node('0-1', 1)] },
      1: { nodes: [node('1-0', 10)] },
    },
  }
  rebuildLinearChildLinks(tree)
  assert.deepEqual(tree.levels[0].nodes.map(n => n.children), [['1-0'], ['1-0']])
})

test('an empty child level leaves its parents with children: []', () => {
  const tree = {
    levelCount: 3,
    levels: {
      0: { nodes: [{ ...node('0-0', 2), children: ['x'] }] },
      1: { nodes: [] },
      2: { nodes: [{ ...node('2-0', 2), children: ['y'] }] },
    },
  }
  rebuildLinearChildLinks(tree)
  assert.deepEqual(tree.levels[0].nodes[0].children, [])
  assert.deepEqual(tree.levels[2].nodes[0].children, [])
})
