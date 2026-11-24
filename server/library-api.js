// Local helper behind the "Add a text" button. It runs inside the Vite dev
// server on the reader's own computer and does three things the browser
// cannot: check that Claude Code is installed, fetch a web page, and run the
// ingest tool, which calls the reader's own Claude subscription through the
// local `claude` command. Added texts live in data/library/, which git ignores.
import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const libraryDir = path.join(projectRoot, 'data', 'library')
const MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_PAGE_BYTES = 6 * 1024 * 1024
const MIN_WORDS = 300
// The longest text a build has been checked with. Longer ones get a warning, not a block.
const TESTED_WORDS = 2500

// The ingest tool prints one of these lines as each stage begins.
const STAGES = [
  { match: 'Seed tree:', label: 'Saving your text' },
  { match: 'Identifying concepts', label: 'Finding the key ideas' },
  { match: 'Generating zoom levels', label: 'Writing the zoom levels' },
  { match: 'Validating generated corpus', label: 'Checking the result' },
]

// A reply that is really Claude Code saying it cannot work, not a summary.
const REFUSAL = /usage limit|rate limit|limit reached|limit will reset|out of extra usage|not logged in|please run \/login|invalid api key|authentication_error|credit balance is too low/i
const CALL_FAILED = /Claude call failed|spawn error|spawn claude ENOENT/

// A build can exit cleanly and still be empty: the tools carry on when a
// Claude call fails. Returns a plain reason when the tree is not usable.
export function treeProblem(tree, log = []) {
  if (log.some(line => CALL_FAILED.test(line))) return 'Claude Code did not answer some of the requests.'
  const levels = Object.keys(tree?.levels || {}).map(Number).sort((a, b) => a - b)
  if (levels.length < 2) return 'The result has no zoom levels.'
  for (const level of levels) {
    const nodes = tree.levels[String(level)]?.nodes || []
    if (!nodes.length || nodes.some(node => !String(node.text || '').trim())) return `Zoom level ${level} came back empty.`
    if (level !== levels[levels.length - 1] && nodes.some(node => REFUSAL.test(node.text))) return 'Claude Code answered with a limit or sign-in message instead of a summary.'
  }
  return null
}

/** @type {Map<string, object>} */
const jobs = new Map()
let runningJobId = null

const countWords = text => text.split(/\s+/).filter(Boolean).length

export function slugify(title) {
  const slug = String(title).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return slug || 'text'
}

function freeSlug(title) {
  const base = slugify(title)
  let slug = base
  for (let n = 2; fs.existsSync(path.join(libraryDir, `${slug}.txt`)); n++) slug = `${base}-${n}`
  return slug
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' }

function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
}

// Plain-text reading of a web page: the article or main region when the page
// marks one, otherwise the body, with paragraphs kept as blank-line breaks.
export function htmlToText(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : ''
  let body = html.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|iframe|nav|header|footer|aside|form|figure)\b[\s\S]*?<\/\1>/gi, ' ')
  const region = body.match(/<article\b[\s\S]*<\/article>/i) || body.match(/<main\b[\s\S]*<\/main>/i) || body.match(/<body\b[\s\S]*<\/body>/i)
  if (region) body = region[0]
  const text = decodeEntities(body
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|section|tr|pre)>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title, text }
}

function send(res, status, payload) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) { reject(new Error('That text is too large to send in one go.')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
      catch { reject(new Error('The request was not readable.')) }
    })
    req.on('error', reject)
  })
}

// Only this page may start work that spends the reader's subscription: a
// request from another site carries that site's Origin and is refused.
function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try { return new URL(origin).host === req.headers.host } catch { return false }
}

function claudeStatus() {
  return new Promise((resolve) => {
    execFile('claude', ['--version'], { timeout: 15000 }, (error, stdout) => {
      if (error) resolve({ installed: false })
      else resolve({ installed: true, version: String(stdout).trim().split('\n')[0] })
    })
  })
}

function listLibrary() {
  if (!fs.existsSync(libraryDir)) return []
  const items = []
  for (const name of fs.readdirSync(libraryDir)) {
    if (!name.endsWith('-auto.json')) continue
    const slug = name.slice(0, -'-auto.json'.length)
    const file = path.join(libraryDir, name)
    if (!fs.existsSync(path.join(libraryDir, `${slug}-auto-concepts.json`))) continue
    let title = slug
    try { title = JSON.parse(fs.readFileSync(file, 'utf8')).title || slug } catch { continue }
    items.push({ file: `library/${name}`, title, added: fs.statSync(file).mtimeMs })
  }
  return items.sort((a, b) => a.added - b.added)
}

const publicJob = job => ({
  id: job.id, title: job.title, words: job.words, state: job.state, stage: job.stage,
  stageIndex: job.stageIndex, stageCount: STAGES.length, startedAt: job.startedAt,
  finishedAt: job.finishedAt, file: job.state === 'done' ? job.file : null,
  error: job.error, needsSignIn: job.needsSignIn, limitHit: Boolean(job.limitHit), log: job.log.slice(-12),
})

function startJob({ title, text }) {
  fs.mkdirSync(libraryDir, { recursive: true })
  const slug = freeSlug(title)
  const txtPath = path.join(libraryDir, `${slug}.txt`)
  fs.writeFileSync(txtPath, text.trim() + '\n')
  const relTxt = path.relative(projectRoot, txtPath)
  const relOut = path.join('data', 'library', `${slug}-auto.json`)
  const job = {
    id: `${Date.now().toString(36)}-${slug}`, title, slug, words: countWords(text),
    state: 'running', stage: STAGES[0].label, stageIndex: 0, startedAt: Date.now(), finishedAt: null,
    file: `library/${slug}-auto.json`, error: null, needsSignIn: false, log: [],
  }
  jobs.set(job.id, job)
  runningJobId = job.id

  const child = spawn(process.execPath, ['tools/ingest-fast.js', relTxt, '--output', relOut], {
    cwd: projectRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so Stop also ends the tools and Claude calls it started.
    detached: true,
  })
  job.child = child
  const onOutput = (chunk) => {
    for (const line of String(chunk).split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      job.log.push(trimmed.slice(0, 300))
      if (job.log.length > 200) job.log.shift()
      const index = STAGES.findIndex(stage => trimmed.includes(stage.match))
      if (index > job.stageIndex) { job.stageIndex = index; job.stage = STAGES[index].label }
    }
  }
  child.stdout.on('data', onOutput)
  child.stderr.on('data', onOutput)
  const finish = (code, spawnError) => {
    if (job.state !== 'running') return
    job.finishedAt = Date.now()
    if (runningJobId === job.id) runningJobId = null
    const outPath = path.join(projectRoot, relOut)
    let problem = null
    if (code === 0 && fs.existsSync(outPath)) {
      try {
        const tree = JSON.parse(fs.readFileSync(outPath, 'utf8'))
        problem = treeProblem(tree, job.log)
        if (!problem) {
          tree.title = title
          fs.writeFileSync(outPath, JSON.stringify(tree, null, 2))
          job.state = 'done'
          job.stage = 'Ready'
          return
        }
      } catch { problem = 'The result could not be read.' }
    }
    const tail = job.log.join('\n')
    job.state = job.cancelled ? 'cancelled' : 'failed'
    job.needsSignIn = /spawn claude ENOENT|not logged in|\/login|authentication|invalid api key|unauthorized/i.test(tail)
    job.limitHit = /usage limit|rate limit|limit reached|limit will reset|out of extra usage/i.test(tail) || /limit/.test(problem || '')
    job.error = job.cancelled ? 'Stopped.'
      : spawnError ? spawnError.message
      : job.limitHit ? 'Your Claude subscription has reached a usage limit. Try again after it resets.'
      : job.needsSignIn ? 'Claude Code did not answer. It may not be installed or signed in on this computer.'
      : problem || `The build stopped during "${job.stage}".`
    // Remove what this build wrote, so a half-built text never shows up in
    // the list. The reader's draft is still in the panel.
    for (const leftover of [outPath, outPath.replace(/\.json$/, '-concepts.json'), txtPath]) {
      if (fs.existsSync(leftover)) fs.rmSync(leftover)
    }
  }
  child.on('error', error => finish(1, error))
  child.on('close', code => finish(code, null))
  return job
}

async function fetchPage(url) {
  let parsed
  try { parsed = new URL(url) } catch { throw new Error('That does not look like a web address.') }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http and https links can be fetched.')
  const response = await fetch(parsed, {
    redirect: 'follow', signal: AbortSignal.timeout(20000),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; semantic-zoom-reader)', Accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' },
  })
  if (!response.ok) throw new Error(`The page answered with error ${response.status}.`)
  const type = response.headers.get('content-type') || ''
  if (/pdf/i.test(type)) throw new Error('That link is a PDF. Download it and use "Choose a file" instead.')
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > MAX_PAGE_BYTES) throw new Error('That page is too large to read.')
  const raw = buffer.toString('utf8')
  if (/text\/plain|markdown/i.test(type)) return { title: path.basename(parsed.pathname) || parsed.hostname, text: raw.trim() }
  const page = htmlToText(raw)
  return { title: page.title || parsed.hostname, text: page.text }
}

async function handle(req, res, route) {
  if (req.method === 'GET' && route === '/status') {
    return send(res, 200, { ...(await claudeStatus()), projectPath: projectRoot, minWords: MIN_WORDS, testedWords: TESTED_WORDS })
  }
  if (req.method === 'GET' && route === '/library') return send(res, 200, { items: listLibrary() })
  if (req.method === 'GET' && route.startsWith('/jobs/')) {
    const job = jobs.get(decodeURIComponent(route.slice('/jobs/'.length)))
    return job ? send(res, 200, publicJob(job)) : send(res, 404, { error: 'That build is no longer on record. The helper may have restarted.' })
  }
  if (req.method !== 'POST') return send(res, 404, { error: 'Not found.' })
  if (!sameOrigin(req)) return send(res, 403, { error: 'This helper only answers its own page.' })
  if (!/application\/json/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Send JSON.' })
  const body = await readJson(req)

  if (route.startsWith('/jobs/') && route.endsWith('/stop')) {
    const job = jobs.get(decodeURIComponent(route.slice('/jobs/'.length, -'/stop'.length)))
    if (!job) return send(res, 404, { error: 'That build is no longer on record.' })
    if (job.state === 'running') {
      job.cancelled = true
      try { process.kill(-job.child.pid, 'SIGTERM') } catch { job.child.kill('SIGTERM') }
    }
    return send(res, 200, publicJob(job))
  }
  if (route === '/fetch') {
    const page = await fetchPage(String(body.url || '').trim())
    if (countWords(page.text) < 20) throw new Error('No readable text came back from that link. Copy the text from the page and paste it instead.')
    return send(res, 200, { ...page, words: countWords(page.text) })
  }
  if (route === '/ingest') {
    const text = String(body.text || '').trim()
    const title = String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, 120)
    if (!title) return send(res, 400, { error: 'Give the text a title.' })
    if (countWords(text) < MIN_WORDS) return send(res, 400, { error: `That is ${countWords(text)} words. Give me at least ${MIN_WORDS}, you lazy bum.` })
    if (runningJobId) return send(res, 409, { error: 'Another text is still being built. Wait for it to finish.', job: publicJob(jobs.get(runningJobId)) })
    const status = await claudeStatus()
    if (!status.installed) return send(res, 428, { error: 'Claude Code is not installed on this computer.', needsSignIn: true })
    return send(res, 200, publicJob(startJob({ title, text })))
  }
  return send(res, 404, { error: 'Not found.' })
}

export function libraryApi() {
  return {
    name: 'semantic-zoom-library-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api', (req, res) => {
        const route = (req.url || '/').split('?')[0]
        handle(req, res, route).catch(error => send(res, 400, { error: error?.message || 'Something went wrong.' }))
      })
    },
  }
}
