import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clusterNodes, targetClusterCount } from '../tools/lib/cluster.js'

// Nodes whose 1-hot embeddings make the topic shifts obvious:
// [A, A, B, B, B, C] -> lowest adjacent similarities at indexes 1 and 4.
const topics = ['A', 'A', 'B', 'B', 'B', 'C']
const axis = { A: [1, 0, 0], B: [0, 1, 0], C: [0, 0, 1] }
const nodes = topics.map(t => ({ text: t, embedding: axis[t] }))

const members = clusters => clusters.map(c => c.members)

test('clusterNodes splits at the k-1 lowest adjacent similarities', () => {
  assert.deepEqual(members(clusterNodes(nodes, 3)), [[0, 1], [2, 3, 4], [5]])
})

test('clusterNodes clusters are contiguous, covering and non-overlapping', () => {
  for (let k = 1; k <= nodes.length + 1; k++) {
    const flat = members(clusterNodes(nodes, k)).flat()
    assert.deepEqual(flat, nodes.map((_, i) => i), `k=${k}`)
  }
})

test('clusterNodes with k >= n returns singletons', () => {
  assert.deepEqual(members(clusterNodes(nodes, 99)), nodes.map((_, i) => [i]))
})

test('clusterNodes with k == 1 (or less) returns one cluster', () => {
  assert.deepEqual(members(clusterNodes(nodes, 1)), [[0, 1, 2, 3, 4, 5]])
  assert.deepEqual(members(clusterNodes(nodes, 0)), [[0, 1, 2, 3, 4, 5]])
})

test('targetClusterCount collapses 3 or fewer nodes to 1, else ceil(55%)', () => {
  assert.deepEqual([0, 1, 2, 3].map(targetClusterCount), [1, 1, 1, 1])
  assert.deepEqual([4, 5, 10, 11, 100].map(targetClusterCount), [3, 3, 6, 7, 56])
})
