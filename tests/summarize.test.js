import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claudeSummarize, extractiveSummarize, targetWordCount } from '../tools/lib/summarize.js'
import { installFakeClaude } from './helpers.js'

test('targetWordCount compresses by 0.55^(level+1)', () => {
  assert.equal(targetWordCount(1000, 0, 6), 550)
  assert.equal(targetWordCount(1000, 1, 6), 303)
  assert.equal(targetWordCount(1000, 3, 6), 92)
})

test('targetWordCount floors at 2.5% of the whole document', () => {
  assert.equal(targetWordCount(1000, 5, 6, 10000), 250)
})

test('targetWordCount floors at 2.5% of the members when totalDocWords is 0', () => {
  // 0.55^20 * 10000 rounds to 0, so the 2.5% member floor (250) wins.
  assert.equal(targetWordCount(10000, 19, 6), 250)
})

test('targetWordCount never exceeds the member word count', () => {
  assert.equal(targetWordCount(100, 0, 6, 100000), 100)
})

const words = n => Array(n).fill('word').join(' ')

test('extractiveSummarize returns a single short member verbatim', () => {
  assert.equal(extractiveSummarize([{ text: 'Short one. Two.', embedding: [1] }], 10), 'Short one. Two.')
})

test('extractiveSummarize returns empty text for no members', () => {
  assert.equal(extractiveSummarize([], 10), '')
})

test('extractiveSummarize picks centroid-nearest sentences and restores source order', () => {
  // Two members on axis X, one on axis Y: the centroid leans to X, so X
  // sentences rank first. Target 4 words stops after two 2-word sentences.
  const members = [
    { text: 'X one. X two.', embedding: [1, 0] },
    { text: 'Y one. Y two.', embedding: [0, 1] },
    { text: 'X three.', embedding: [1, 0] },
  ]
  assert.equal(extractiveSummarize(members, 4), 'X one. X two.')
  assert.equal(extractiveSummarize(members, 6), 'X one. X two. X three.')
})

test('extractiveSummarize overshoots the target by at most one sentence', () => {
  const members = [
    { text: `${words(5)}. ${words(5)}.`, embedding: [1, 0] },
    { text: `${words(5)}.`, embedding: [0, 1] },
  ]
  assert.equal(extractiveSummarize(members, 6).split(/\s+/).length, 10)
})

// buildReductionPrompt is private; claudeSummarize hands it to the CLI on
// stdin, so a stubbed `claude` captures it without any model call.
function reductionPrompt(t, members, targetWords, important = [], opts = {}) {
  const fake = installFakeClaude(t, '  reduced text \n')
  const out = claudeSummarize(members, targetWords, important, opts)
  assert.equal(out, 'reduced text')
  return { prompt: fake.prompt(), args: fake.args() }
}

const passages = [{ text: 'First passage.' }, { text: 'Second passage.' }]

test('claudeSummarize pins the sonnet / medium-effort CLI flags', (t) => {
  delete process.env.MODEL
  delete process.env.EFFORT
  const { args } = reductionPrompt(t, passages, 40)
  assert.equal(args, '-p --output-format text --exclude-dynamic-system-prompt-sections --effort medium --model sonnet')
})

test('reduction prompt without essentials numbers passages and asks to cover all of them', (t) => {
  const { prompt } = reductionPrompt(t, passages, 40, [{ text: 'keep me', importance: 3 }])
  assert.match(prompt, /PASSAGE 1\/2:\nFirst passage\.\n\n---\n\nPASSAGE 2\/2:\nSecond passage\./)
  assert.match(prompt, /You MUST include content from ALL 2 passages\./)
  assert.match(prompt, /Each passage contributes ~20 words/)
  assert.match(prompt, /PRIORITY PHRASES \(preserve where natural\):\n- \[3\] keep me/)
  assert.doesNotMatch(prompt, /EVENTS TO INCLUDE/)
  assert.doesNotMatch(prompt, /CAST & GLOSSARY/)
})

test('reduction prompt in essentials mode lists events and the stricter coverage rule', (t) => {
  const essentials = [{ label: 'She signs', snippet: 'x'.repeat(120) }, { label: 'He leaves' }]
  const { prompt } = reductionPrompt(t, passages, 40, [{ text: 'ignored hint' }], { essentials })
  assert.match(prompt, /EVENTS TO INCLUDE — and ONLY THESE:\n- She signs {2}\(in the source: "x{100}…"\)\n- He leaves\n/)
  assert.match(prompt, /- The output covers NO event NOT listed above \(include none\)\./)
  assert.doesNotMatch(prompt, /PRIORITY PHRASES/)
  assert.match(prompt, /covering ONLY the events listed above/)
})

test('reduction prompt includes the cast block only when characters are given', (t) => {
  const { prompt } = reductionPrompt(t, passages, 40, [], { characters: { Anna: 'the daughter' }, thematicThrust: '  trust  ' })
  assert.match(prompt, /CAST & GLOSSARY[^\n]*\n {2}Anna — the daughter\n/)
  assert.match(prompt, /THEMATIC THRUST[^\n]*\n {2}trust\n/)
})

test('reduction prompt for one passage uses the singular wording', (t) => {
  const { prompt } = reductionPrompt(t, [{ text: 'Only.' }], 5)
  assert.match(prompt, /You are REDUCING 1 passage for/)
  assert.match(prompt, /Each passage contributes ~8 words/)
})
