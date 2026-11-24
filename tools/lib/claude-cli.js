// The one way the build tools call Claude: the local `claude` CLI in print
// mode, prompt on stdin, never an API key. Every stage pins
// `--model sonnet --effort medium` unless MODEL / EFFORT override it.
import { execFileSync, spawn } from 'node:child_process'
import os from 'node:os'

const MAX_BUFFER = 8 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 600000
// Claude Code reads instruction files from the folder it starts in and its
// parents. Starting it in the temp folder keeps a reader's own project
// instructions out of the summaries.
const CLAUDE_CWD = os.tmpdir()

// `pinned: false` gives the bare call (no model or effort flags), which is
// what classify-genre.js uses.
export function claudeArgs({ pinned = true } = {}) {
  const base = ['-p', '--output-format', 'text']
  if (!pinned) return base
  return [...base, '--exclude-dynamic-system-prompt-sections',
    '--effort', process.env.EFFORT || 'medium',
    '--model', process.env.MODEL || 'sonnet']
}

const seconds = t0 => ((Date.now() - t0) / 1000).toFixed(1)

function logDone(label, t0, out) {
  if (label) console.log(`    [${label}] ${seconds(t0)}s, ${out.length} chars`)
}

/**
 * @typedef {{ label?: string | null, timeoutMs?: number, pinned?: boolean }} ClaudeCallOptions
 */

// Blocking call. Returns the trimmed reply, or null on failure or an empty reply.
/** @param {string} prompt @param {ClaudeCallOptions} [opts] @returns {string | null} */
export function callClaude(prompt, { label = null, timeoutMs = DEFAULT_TIMEOUT_MS, pinned = true } = {}) {
  const t0 = Date.now()
  try {
    const out = execFileSync('claude', claudeArgs({ pinned }), {
      input: prompt, encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: timeoutMs, cwd: CLAUDE_CWD,
    }).trim()
    logDone(label, t0, out)
    return out || null
  } catch (e) {
    console.error(`  [${label || 'claude'}] Claude call failed after ${seconds(t0)}s:`, e.message?.substring(0, 200))
    return null
  }
}

// Non-blocking call, for running several prompts at once with Promise.all.
// Resolves to the trimmed reply, or null on failure, timeout or an empty reply.
/** @param {string} prompt @param {ClaudeCallOptions} [opts] @returns {Promise<string | null>} */
export function callClaudeAsync(prompt, { label = null, timeoutMs = DEFAULT_TIMEOUT_MS, pinned = true } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const tag = label || 'claude'
    const proc = spawn('claude', claudeArgs({ pinned }), { stdio: ['pipe', 'pipe', 'pipe'], cwd: CLAUDE_CWD })
    let stdout = '', stderr = ''
    proc.stdout.on('data', d => { stdout += d.toString() })
    proc.stderr.on('data', d => { stderr += d.toString() })
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs)
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        console.error(`  [${tag}] exit ${code} after ${seconds(t0)}s: ${stderr.substring(0, 120)}`)
        resolve(null)
        return
      }
      const out = stdout.trim()
      logDone(label, t0, out)
      resolve(out || null)
    })
    proc.on('error', (e) => {
      console.error(`  [${tag}] spawn error: ${e.message?.substring(0, 120)}`)
      resolve(null)
    })
    proc.stdin.write(prompt)
    proc.stdin.end()
  })
}

// Pull JSON out of a model reply: strips markdown fences, then tries the
// whole reply, then the span from the first opening bracket to the last
// closing one. Objects only unless `allowArray`. Returns null when nothing parses.
export function parseModelJson(raw, { allowArray = false } = {}) {
  if (!raw) return null
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
  try { return JSON.parse(text) } catch {}
  const openers = allowArray ? ['[', '{'] : ['{']
  const closers = allowArray ? [']', '}'] : ['}']
  const starts = openers.map(c => text.indexOf(c)).filter(i => i !== -1)
  const start = starts.length ? Math.min(...starts) : -1
  const end = Math.max(...closers.map(c => text.lastIndexOf(c)))
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)) } catch {}
  }
  return null
}
