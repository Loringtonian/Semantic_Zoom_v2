import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { CORPORA, projectRoot } from './helpers.js'
import { runScenario } from './sz-harness.js'

// Golden replay of src/main.js: hover lookups, concept/word positions and
// full click-zoom paths in both directions, recorded before main.js was split
// into modules. Any drift here is a zoom-behaviour change.
for (const corpus of CORPORA) {
  test(`zoom behaviour matches the recorded golden on ${corpus}`, async () => {
    const golden = JSON.parse(fs.readFileSync(path.join(projectRoot, 'tests/fixtures/zoom-golden', `${corpus}.json`), 'utf8'))
    const record = await runScenario(corpus)
    assert.equal(record.lookups.length, golden.lookups.length)
    for (let i = 0; i < golden.lookups.length; i++) assert.deepEqual(record.lookups[i], golden.lookups[i], `lookup ${i}`)
    assert.deepEqual(record.positions, golden.positions)
    assert.equal(record.paths.length, golden.paths.length)
    for (let i = 0; i < golden.paths.length; i++) assert.deepEqual(record.paths[i], golden.paths[i], `path ${golden.paths[i].id}`)
    assert.deepEqual(record.pan, golden.pan)
    assert.equal(record.drag.zoomedIn, record.drag.base + 1, 'right click zooms in')
    assert.equal(record.drag.afterDrag, record.drag.zoomedIn, 'a drag and its closing click do not zoom')
    assert.equal(record.drag.afterPlainClick, record.drag.base, 'a plain left click zooms out')
    assert.equal(record.wheel.after, record.wheel.start, 'wheel pans and leaves the level alone')
    assert.equal(record.keys.afterPlus, record.keys.start + 1, 'plus key zooms in one level')
    assert.equal(record.keys.afterMinus, record.keys.start, 'minus key zooms back out')
  })
}
