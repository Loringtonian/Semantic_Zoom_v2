import test from 'node:test'
import assert from 'node:assert/strict'
import { htmlToText, slugify, treeProblem } from '../server/library-api.js'

test('slugify makes a safe file name from a title', () => {
  assert.equal(slugify('  The Bitter Lesson: 2019! '), 'the-bitter-lesson-2019')
  assert.equal(slugify('../../etc/passwd'), 'etc-passwd')
  assert.equal(slugify('???'), 'text')
})

test('htmlToText keeps the article, drops page furniture, keeps paragraphs', () => {
  const page = htmlToText(`<html><head><title>My &amp; Essay</title><style>p{}</style></head>
    <body><nav>Home | About</nav><article><h1>Heading</h1><p>First&nbsp;paragraph<br>second line.</p>
    <script>alert(1)</script><p>Second &#8220;quoted&#8221; paragraph.</p></article><footer>Copyright</footer></body></html>`)
  assert.equal(page.title, 'My & Essay')
  assert.equal(page.text, 'Heading\n\nFirst paragraph\nsecond line.\n\nSecond “quoted” paragraph.')
})

test('htmlToText falls back to the body when no article is marked', () => {
  assert.equal(htmlToText('<body><div>Just a line.</div></body>').text, 'Just a line.')
})

test('treeProblem rejects builds that exited cleanly but are not usable', () => {
  const good = { levels: { 0: { nodes: [{ text: 'Short.' }] }, 1: { nodes: [{ text: 'The whole source text.' }] } } }
  assert.equal(treeProblem(good), null)
  assert.match(treeProblem(good, ['[claude] spawn error: spawn claude ENOENT']), /did not answer/)
  assert.match(treeProblem({ levels: { 0: { nodes: [] }, 1: { nodes: [{ text: 'Source.' }] } } }), /level 0 came back empty/)
  const limited = { levels: { 0: { nodes: [{ text: "You've hit your usage limit." }] }, 1: { nodes: [{ text: 'Source.' }] } } }
  assert.match(treeProblem(limited), /limit or sign-in message/)
  // The source level is the reader's own words and may say anything.
  const source = { levels: { 0: { nodes: [{ text: 'A summary.' }] }, 1: { nodes: [{ text: 'The rate limit reached us all.' }] } } }
  assert.equal(treeProblem(source), null)
})
