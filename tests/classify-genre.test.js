import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyGenre } from '../tools/classify-genre.js'
import { installFakeClaude, smallTree } from './helpers.js'

const FALLBACK = { genre: 'short_story', confidence: 0, secondary: null, reasoning: 'classifier failed; default' }

async function classifyWith(t, reply, tree = smallTree()) {
  const fake = installFakeClaude(t, reply)
  const result = await classifyGenre(tree)
  assert.ok(fake.wasCalled(), 'stub claude was not invoked')
  return { result, fake }
}

test('classifyGenre returns the parsed genre from strict JSON', async (t) => {
  const { result } = await classifyWith(t, '{"genre":"essay","confidence":0.9,"secondary":"argument","reasoning":"thesis"}')
  assert.deepEqual(result, { genre: 'essay', confidence: 0.9, secondary: 'argument', reasoning: 'thesis' })
})

test('classifyGenre strips markdown fences', async (t) => {
  const { result } = await classifyWith(t, '```json\n{"genre":"procedural","confidence":0.7}\n```')
  assert.equal(result.genre, 'procedural')
})

test('classifyGenre ignores prose before the first { and after the last }', async (t) => {
  const { result } = await classifyWith(t, 'Sure! Here it is: {"genre":"reference","confidence":1} Hope that helps.')
  assert.equal(result.genre, 'reference')
})

test('classifyGenre defaults missing confidence to 0.5 and drops unknown secondaries', async (t) => {
  const { result } = await classifyWith(t, '{"genre":"novella","secondary":"poem"}')
  assert.deepEqual(result, { genre: 'novella', confidence: 0.5, secondary: null, reasoning: '' })
})

test('classifyGenre falls back to short_story on an unknown genre', async (t) => {
  const { result } = await classifyWith(t, '{"genre":"poetry","confidence":0.99}')
  assert.deepEqual(result, FALLBACK)
})

test('classifyGenre falls back to short_story on garbage', async (t) => {
  const { result } = await classifyWith(t, 'no json here')
  assert.deepEqual(result, FALLBACK)
})

test('classifyGenre samples the first 1000 words of the deepest level', async (t) => {
  const tree = smallTree()
  tree.levels[1].nodes[1].text = Array(1200).fill('w').join(' ')
  const { fake } = await classifyWith(t, '{"genre":"essay"}', tree)
  const sample = fake.prompt().split('"""\n')[1].split('\n"""')[0]
  assert.equal(sample.split(' ').length, 1000)
  assert.ok(sample.startsWith('First leaf paragraph. w w'))
  assert.doesNotMatch(fake.prompt(), /Root summary/)
})

test('classifyGenre calls the CLI without pinning a model (open question, not a fix)', async (t) => {
  const { fake } = await classifyWith(t, '{"genre":"essay"}')
  assert.equal(fake.args(), '-p --output-format text')
})
