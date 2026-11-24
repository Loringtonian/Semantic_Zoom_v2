import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const dataDir = path.join(projectRoot, 'data')

export const CORPORA = fs.readdirSync(dataDir)
  .filter(f => f.endsWith('-auto.json'))
  .map(f => f.replace(/-auto\.json$/, ''))
  .sort()

export function loadTree(corpus) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, `${corpus}-auto.json`), 'utf8'))
}

export function loadConcepts(corpus) {
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, `${corpus}-auto-concepts.json`), 'utf8'))
  return Array.isArray(raw) ? raw : raw.concepts
}

export function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sz-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

export function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
  return file
}

export function runTool(script, args = [], opts = {}) {
  return spawnSync(process.execPath, [path.join(projectRoot, script), ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    ...opts,
  })
}

// Minimal well-formed tree: L0 has one root, L1 has two leaves.
export function smallTree(overrides = {}) {
  return {
    title: 'Small',
    levelCount: 2,
    levels: {
      0: { nodes: [{ id: '0-0', text: 'Root summary text.', children: ['1-0', '1-1'] }] },
      1: { nodes: [
        { id: '1-0', text: 'First leaf paragraph.', children: [] },
        { id: '1-1', text: 'Second leaf paragraph.', children: [] },
      ] },
    },
    ...overrides,
  }
}

/**
 * Put a fake `claude` executable first on PATH for this test file's process.
 * The stub records the prompt it receives on stdin and prints `reply`.
 * The real CLI lives in ~/.local/bin, which the stubbed PATH leaves out, so a
 * stub failure cannot fall through to a paid call.
 */
export function installFakeClaude(t, reply) {
  const dir = makeTempDir(t)
  const promptFile = path.join(dir, 'prompt.txt')
  const replyFile = path.join(dir, 'reply.txt')
  fs.writeFileSync(replyFile, reply)
  const bin = path.join(dir, 'claude')
  fs.writeFileSync(bin, `#!/bin/sh\necho "$@" > '${dir}/args.txt'\ncat > '${promptFile}'\ncat '${replyFile}'\n`)
  fs.chmodSync(bin, 0o755)
  const oldPath = process.env.PATH
  process.env.PATH = `${dir}:/usr/bin:/bin`
  t.after(() => { process.env.PATH = oldPath })
  return {
    prompt: () => fs.readFileSync(promptFile, 'utf8'),
    args: () => fs.readFileSync(path.join(dir, 'args.txt'), 'utf8').trim(),
    wasCalled: () => fs.existsSync(promptFile),
  }
}
