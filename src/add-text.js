// The "Add a text" button and its panel. One screen: a title, a text box, and
// two other ways to fill the box (a link, a file). Building the zoom levels is
// done by the local helper (server/library-api.js), which calls Claude Code on
// this computer. The draft and a running build both survive a page reload.

const STORE_KEY = 'semantic-zoom.add-text'
const POLL_MS = 1500

const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else node.setAttribute(key, value)
  }
  for (const child of [].concat(children)) if (child) node.append(child)
  return node
}

const countWords = text => text.split(/\s+/).filter(Boolean).length
const titleFromName = name => name.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim()

function loadState() {
  try { return { open: false, title: '', text: '', url: '', jobId: null, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') } }
  catch { return { open: false, title: '', text: '', url: '', jobId: null } }
}

async function api(route, body) {
  const response = await fetch(`/api${route}`, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined)
  const type = response.headers.get('content-type') || ''
  if (!type.includes('application/json')) throw new Error('offline')
  const data = await response.json()
  if (!response.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { data, status: response.status })
  return data
}

async function readPdf(file) {
  const pdfjs = await import('pdfjs-dist')
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise
  const pages = []
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent()
    let page = ''
    for (const item of content.items) {
      if (!('str' in item)) continue
      page += item.str + (item.hasEOL ? '\n' : '')
    }
    pages.push(page)
  }
  // PDF lines break mid-sentence: join lines, keep blank lines as paragraphs.
  return pages.join('\n\n')
    .replace(/-\n(?=[a-z])/g, '')
    .replace(/([^\n])\n(?=[^\n])/g, '$1 ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function readDocx(file) {
  const mammoth = await import('mammoth/mammoth.browser.js')
  const api = mammoth.default || mammoth
  const result = await api.extractRawText({ arrayBuffer: await file.arrayBuffer() })
  return result.value.replace(/\n{3,}/g, '\n\n').trim()
}

async function readFile(file) {
  const name = file.name.toLowerCase()
  if (name.endsWith('.pdf')) return readPdf(file)
  if (name.endsWith('.docx')) return readDocx(file)
  if (name.endsWith('.doc')) throw new Error('Old .doc files cannot be read here. Save it as .docx or PDF first.')
  return (await file.text()).trim()
}

function handoffPrompt(projectPath) {
  const folder = projectPath || 'the folder where I cloned Semantic Zoom'
  return `I want you to power this app. It is Semantic Zoom, a reader that zooms prose between summary and detail. It lives in this folder on my computer:
${folder}

Please do this for me:
1. Check that Claude Code is signed in to my Claude subscription.
2. If the reader is not running, run "npm install" and then "npm run dev" in that folder, and give me the link it prints.
3. Ask me for the text I want to read: a link, pasted text, or a file. Save it as plain text in data/library/<short-name>.txt.
4. Run: node tools/ingest-fast.js data/library/<short-name>.txt --output data/library/<short-name>-auto.json
5. When it finishes, tell me to reload the reader and pick the text from the dropdown at the top right.`
}

export function initAddText({ picker, openFile }) {
  const state = loadState()
  let status = null        // { installed, projectPath, minWords } or { offline: true }
  let job = null
  let pollTimer = 0
  let busy = ''
  let notice = ''
  let noticeKind = ''
  let promptShown = false

  const save = () => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)) } catch { /* private mode: the draft just does not persist */ }
  }

  const button = el('button', { id: 'add-text-button', type: 'button', text: '+ Add a text' })
  const panel = el('section', { id: 'add-text-panel', hidden: '', 'aria-label': 'Add a text' })
  document.body.append(button, panel)

  async function refreshLibrary(selectFile) {
    let items = []
    try { items = (await api('/library')).items } catch { return }
    picker.querySelector('optgroup[data-library]')?.remove()
    if (items.length) {
      const group = el('optgroup', { label: 'Your texts', 'data-library': '' })
      for (const item of items) group.append(el('option', { value: item.file, text: item.title }))
      picker.append(group)
    }
    const wanted = selectFile || new URLSearchParams(window.location.search).get('file')
    if (wanted && [...picker.options].some(option => option.value === wanted)) picker.value = wanted
  }

  function setNotice(text, kind = '') { notice = text; noticeKind = kind; render() }

  // The prompt gets its own box, so it is readable before pasting and still
  // reachable when the browser refuses clipboard access.
  async function copyPrompt() {
    promptShown = true
    let copied = false
    try { await navigator.clipboard.writeText(handoffPrompt(status?.projectPath)); copied = true } catch { /* shown in the box instead */ }
    setNotice(copied ? 'Prompt copied. Paste it into Claude Code.' : 'Select the prompt below and copy it into Claude Code.', copied ? 'good' : '')
  }

  function promptBox() {
    if (!promptShown) return null
    const box = el('textarea', { class: 'at-prompt', readonly: '', 'aria-label': 'Prompt for your Claude' })
    box.value = handoffPrompt(status?.projectPath)
    box.addEventListener('focus', () => box.select())
    return box
  }

  async function stopBuild() {
    if (!job) return
    try { job = await api(`/jobs/${encodeURIComponent(job.id)}/stop`, {}) } catch { /* the poll reports what happened */ }
    render()
  }

  async function fetchLink() {
    const url = state.url.trim()
    if (!url) return
    busy = 'Fetching the page…'
    notice = ''
    render()
    try {
      const page = await api('/fetch', { url: /^https?:\/\//i.test(url) ? url : `https://${url}` })
      state.text = page.text
      if (!state.title.trim()) state.title = page.title
      save()
      busy = ''
      setNotice(`Fetched ${page.words.toLocaleString()} words. Check the text, then build.`, 'good')
    } catch (error) {
      busy = ''
      setNotice(error.message === 'offline' ? 'Links can only be fetched when the app runs on your own computer.' : error.message, 'bad')
    }
  }

  async function chooseFile(file) {
    if (!file) return
    busy = `Reading ${file.name}…`
    notice = ''
    render()
    try {
      const text = await readFile(file)
      if (!text) throw new Error('No text could be read from that file. A scanned PDF holds pictures of pages, not text.')
      state.text = text
      if (!state.title.trim()) state.title = titleFromName(file.name)
      save()
      busy = ''
      setNotice(`Read ${countWords(text).toLocaleString()} words from ${file.name}. Check the text, then build.`, 'good')
    } catch (error) {
      busy = ''
      setNotice(error.message || 'That file could not be read.', 'bad')
    }
  }

  async function startBuild() {
    notice = ''
    busy = 'Starting…'
    render()
    try {
      job = await api('/ingest', { title: state.title, text: state.text })
      state.jobId = job.id
      save()
      busy = ''
      render()
      poll()
    } catch (error) {
      busy = ''
      if (error.data?.job) { job = error.data.job; state.jobId = job.id; save(); render(); poll(); return }
      if (error.data?.needsSignIn && status) status.installed = false
      setNotice(error.message === 'offline' ? 'Building works when the app runs on your own computer.' : error.message, 'bad')
    }
  }

  function poll() {
    clearTimeout(pollTimer)
    if (!state.jobId) return
    pollTimer = setTimeout(async () => {
      try {
        job = await api(`/jobs/${encodeURIComponent(state.jobId)}`)
      } catch (error) {
        // The helper restarted and forgot the build: return to the draft.
        job = null
        state.jobId = null
        save()
        setNotice(error.message === 'offline' ? 'The local helper is not answering.' : error.message, 'bad')
        return
      }
      if (job.state === 'cancelled') { backToDraft(); return }
      if (job.state === 'done') {
        const file = job.file
        const title = job.title
        job = null
        Object.assign(state, { jobId: null, title: '', text: '', url: '', open: false })
        save()
        await refreshLibrary(file)
        await openFile(file)
        button.textContent = `Added: ${title}`
        setTimeout(() => { button.textContent = '+ Add a text' }, 4000)
        render()
        return
      }
      render()
      if (job.state === 'running') poll()
    }, POLL_MS)
  }

  function backToDraft() {
    job = null
    state.jobId = null
    save()
    notice = ''
    render()
  }

  function elapsed(from, to = Date.now()) {
    const seconds = Math.max(0, Math.round((to - from) / 1000))
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
  }

  function connectCard() {
    return el('div', { class: 'at-connect' }, [
      el('strong', { text: 'Connect your Claude subscription' }),
      el('p', { text: 'The zoom levels are written by Claude Code on this computer. It was not found.' }),
      el('ol', {}, [
        el('li', { text: 'Install Claude Code from claude.com/claude-code.' }),
        el('li', { text: 'Open it once and sign in with your Claude subscription.' }),
        el('li', { text: 'Come back and press Check again.' }),
      ]),
      el('div', { class: 'at-row' }, [
        el('button', { type: 'button', class: 'at-secondary', text: 'Check again', onclick: async () => { status = null; render(); await loadStatus(); } }),
        el('button', { type: 'button', class: 'at-secondary', text: 'Copy a prompt for my Claude', onclick: copyPrompt }),
      ]),
    ])
  }

  function composeView() {
    const words = countWords(state.text)
    const minWords = status?.minWords || 300
    const ready = !busy && state.title.trim() && words >= minWords && status?.installed
    const title = el('input', { type: 'text', class: 'at-title', placeholder: 'Title', value: state.title, 'aria-label': 'Title', maxlength: '120' })
    const text = el('textarea', { class: 'at-text', placeholder: 'Paste the text here', 'aria-label': 'Text' })
    text.value = state.text
    const count = el('span', { class: 'at-count' })
    const long = el('p', { class: 'at-notice', hidden: '' })
    const lazy = el('p', { class: 'at-notice bad', hidden: '' })
    const build = el('button', { type: 'button', class: 'at-primary', text: 'Build zoom levels', onclick: startBuild })
    const sync = () => {
      const n = countWords(state.text)
      count.textContent = n ? `${n.toLocaleString()} words` : ''
      lazy.hidden = !(n > 0 && n < minWords)
      lazy.textContent = `${n.toLocaleString()} words? Give me at least ${minWords}, you lazy bum.`
      build.disabled = !(!busy && state.title.trim() && n >= minWords && status?.installed)
      const tested = status?.testedWords || 0
      long.hidden = !(tested && n > tested)
      long.textContent = `Builds have been checked up to ${tested.toLocaleString()} words. This one is ${n.toLocaleString()}: it will take longer and use more of your subscription.`
    }
    title.addEventListener('input', () => { state.title = title.value; save(); sync() })
    text.addEventListener('input', () => { state.text = text.value; save(); sync() })
    build.disabled = !ready

    const link = el('input', { type: 'url', class: 'at-link', placeholder: 'or a link to an article', value: state.url, 'aria-label': 'Link' })
    link.addEventListener('input', () => { state.url = link.value; save() })
    link.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fetchLink() } })
    const file = el('input', { type: 'file', hidden: '', 'aria-label': 'Choose a file', accept: '.pdf,.docx,.txt,.md,.markdown,text/plain,application/pdf' })
    file.addEventListener('change', () => chooseFile(file.files?.[0]))

    const view = el('div', { class: 'at-view' }, [
      status && status.installed === false && !status.offline ? connectCard() : null,
      status && status.installed === false ? promptBox() : null,
      status?.offline ? el('div', { class: 'at-connect' }, [
        el('strong', { text: 'Run the app on your own computer to add texts' }),
        el('p', { text: 'This page has no local helper behind it, so it cannot reach your Claude subscription.' }),
        el('button', { type: 'button', class: 'at-secondary', text: 'Copy a prompt for my Claude', onclick: copyPrompt }),
      ]) : null,
      title,
      text,
      el('div', { class: 'at-row' }, [
        link,
        el('button', { type: 'button', class: 'at-secondary', text: 'Fetch', onclick: fetchLink }),
        el('button', { type: 'button', class: 'at-secondary', text: 'Choose a file', title: 'PDF, Word (.docx) or plain text', onclick: () => file.click() }),
        file,
      ]),
      busy ? el('p', { class: 'at-notice', text: busy }) : notice ? el('p', { class: `at-notice ${noticeKind}`, text: notice }) : null,
      long,
      lazy,
      el('div', { class: 'at-foot' }, [
        el('div', { class: 'at-meta' }, [count, el('span', { text: 'Built by Claude Code on this computer, on your Claude subscription.' })]),
        build,
      ]),
      status?.installed ? el('button', { type: 'button', class: 'at-linkish', text: 'Rather hand this to your own Claude? Copy a prompt', onclick: copyPrompt }) : null,
      status?.installed ? promptBox() : null,
    ])
    sync()
    return view
  }

  function progressView() {
    const failed = job.state === 'failed'
    const steps = el('ol', { class: 'at-steps' })
    const labels = ['Saving your text', 'Finding the key ideas', 'Writing the zoom levels', 'Checking the result']
    labels.forEach((label, index) => {
      const mark = index < job.stageIndex ? 'done' : index === job.stageIndex ? (failed ? 'failed' : 'now') : 'todo'
      steps.append(el('li', { class: mark, text: label }))
    })
    return el('div', { class: 'at-view' }, [
      el('strong', { class: 'at-jobtitle', text: job.title }),
      el('p', { class: 'at-sub', text: `${job.words.toLocaleString()} words · ${failed ? 'stopped after' : 'running for'} ${elapsed(job.startedAt, job.finishedAt || Date.now())}` }),
      steps,
      failed ? el('p', { class: 'at-notice bad', text: job.error }) : el('p', { class: 'at-sub', text: 'Keep reading. This carries on if you close the panel or reload the page.' }),
      failed && job.needsSignIn && !job.limitHit ? connectCard() : null,
      failed && job.needsSignIn && !job.limitHit ? promptBox() : null,
      failed ? null : el('div', { class: 'at-foot' }, [el('span'), el('button', { type: 'button', class: 'at-secondary', text: 'Stop', onclick: stopBuild })]),
      failed && job.log?.length ? el('details', { class: 'at-log' }, [el('summary', { text: 'What the tool printed' }), el('pre', { text: job.log.join('\n') })]) : null,
      failed ? el('div', { class: 'at-foot' }, [el('span'), el('button', { type: 'button', class: 'at-primary', text: 'Back to the text', onclick: backToDraft })]) : null,
    ])
  }

  function render() {
    panel.hidden = !state.open
    button.classList.toggle('busy', job?.state === 'running')
    if (job?.state === 'running' && !state.open) button.textContent = `Building: ${job.stage}…`
    else if (!button.textContent.startsWith('Added')) button.textContent = '+ Add a text'
    if (!state.open) return
    const active = document.activeElement
    const focus = panel.contains(active) ? { cls: active.className, start: active.selectionStart, end: active.selectionEnd } : null
    panel.replaceChildren(
      el('header', { class: 'at-head' }, [
        el('h2', { text: job ? 'Building your text' : 'Add a text' }),
        el('button', { type: 'button', class: 'at-close', 'aria-label': 'Close', text: '×', onclick: () => { state.open = false; save(); render() } }),
      ]),
      job ? progressView() : composeView(),
    )
    if (focus?.cls) {
      const again = panel.querySelector(`.${focus.cls.split(' ')[0]}`)
      if (again && (again.tagName === 'INPUT' || again.tagName === 'TEXTAREA')) {
        again.focus()
        try { again.setSelectionRange(focus.start, focus.end) } catch { /* not a text field */ }
      }
    }
  }

  async function loadStatus() {
    try { status = await api('/status') } catch { status = { offline: true, installed: false } }
    render()
  }

  button.addEventListener('click', () => { state.open = !state.open; save(); render() })
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.open) { state.open = false; save(); render() }
  })
  setInterval(() => { if (state.open && job?.state === 'running') render() }, 1000)

  loadStatus()
  refreshLibrary()
  if (state.jobId) {
    api(`/jobs/${encodeURIComponent(state.jobId)}`).then((found) => { job = found; render(); poll() }).catch(() => { state.jobId = null; save(); render() })
  }
  render()
}
