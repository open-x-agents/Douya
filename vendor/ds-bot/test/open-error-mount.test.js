import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { inflateSync } from 'node:zlib'
import { createElement as h, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { OPEN_RECOVERY } from '../src/client/open-error-copy.js'
import { OpenErrorNotice, openErrorNode } from '../src/client/open-error.js'
import { rosterGate } from '../src/client/roster-gate.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, 'dev', 'harness'), 'package.json'))('jsdom')

// The failed boot the live run recorded: the shell sidebar and the chat column
// are up, the composer is up, and conversation.input.dock is not in the tree
// because that slot waits for a Session.
const BOOT_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<aside data-sidebar><div id="side"></div></aside>
<div data-conversation-region="chat" data-content-phase="hero">
  <div data-conversation-scroll><div data-composer-card></div></div>
</div>
</body></html>`

function installDom(dom) {
  const window = dom.window
  globalThis.window = window
  globalThis.document = window.document
  globalThis.MutationObserver = window.MutationObserver
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
  globalThis.HTMLElement = window.HTMLElement
  globalThis.Node = window.Node
  globalThis.Element = window.Element
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.getComputedStyle = window.getComputedStyle.bind(window)
}

function rosterStore(initial) {
  let roster = initial
  const listeners = new Set()
  const useRoster = (select) => useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    () => select(roster),
  )
  const setRoster = (next) => {
    roster = next
    for (const listener of listeners) listener()
  }
  return { useRoster, setRoster }
}

function Side({ useRoster }) {
  const roster = useRoster(value => value)
  const gate = rosterGate({ ready: roster.ready === true, hasMain: roster.byId?.[roster.mainBotId] != null, loadError: roster.loadError })
  switch (gate.kind) {
    case 'error': return openErrorNode(gate.text, 'sidebar')
    case 'setup': return h('div', { className: 'bt-hint' }, 'Setting up your Main Bot…')
    case 'team': return null
    default: {
      const unexpected = gate.kind
      throw new Error(`Unknown roster gate ${String(unexpected)}`)
    }
  }
}

function alerts(doc) {
  const chat = doc.querySelector('[data-conversation-region="chat"]')
  const side = doc.querySelector('[data-sidebar]')
  return {
    chat: [...chat.querySelectorAll('[role=alert]')],
    side: [...side.querySelectorAll('[role=alert]')],
    dock: doc.querySelector('[data-slot="conversation.input.dock"], [data-open-error="dock"]'),
  }
}

test('a sessionless boot mounts the open error in the sidebar and the chat column', async () => {
  const dom = new JSDOM(BOOT_HTML)
  installDom(dom)
  const doc = dom.window.document
  const { useRoster, setRoster } = rosterStore({ ready: false, byId: {}, loadError: '请求失败（HTTP 404）' })
  const overlay = doc.createElement('div')
  overlay.dataset.shellOverlay = ''
  doc.body.appendChild(overlay)
  const sideRoot = createRoot(doc.getElementById('side'))
  const overlayRoot = createRoot(overlay)
  const paint = async () => {
    await act(async () => {
      sideRoot.render(h(Side, { useRoster }))
      overlayRoot.render(h(OpenErrorNotice, { useRoster }))
      await new Promise(resolve => setTimeout(resolve, 30))
    })
  }
  await paint()
  let found = alerts(doc)
  assert.equal(found.dock, null)
  assert.equal(found.side.length, 1, 'sidebar alert')
  assert.equal(found.chat.length, 1, 'chat column alert')
  assert.equal(found.chat[0].getAttribute('data-open-error'), 'chat')
  assert.equal(found.side[0].getAttribute('data-open-error'), 'sidebar')
  assert.match(found.chat[0].textContent, /HTTP 404/)
  assert.match(found.chat[0].textContent, /Restart DS Bot/)
  assert.match(found.side[0].textContent, /Restart DS Bot/)
  assert.equal(found.chat[0].textContent.includes('session.v4'), false)
  assert.equal(found.chat[0].textContent.includes(OPEN_RECOVERY) || found.chat[0].textContent.includes('Restart DS Bot'), true)

  await act(async () => { setRoster({ ready: false, byId: {}, loadError: '请求失败（HTTP 404）' }) })
  found = alerts(doc)
  assert.equal(found.chat.length, 1, 'blocked retry keeps the chat alert')
  assert.equal(found.side.length, 1, 'blocked retry keeps the sidebar alert')
  assert.equal(found.dock, null)

  const shotDir = mkdtempSync(join(tmpdir(), 'open-error-boot-'))
  const page = join(shotDir, 'boot.html')
  const css = readFileSync(join(PLUGIN, 'src/client/styles.js'), 'utf8')
  const rule = css.match(/\.bt-open-error\{[^}]+\}/)[0]
  const lines = css.match(/\.bt-open-error-line\{[^}]+\}/g).join('')
  const placed = css.match(/\[data-conversation-region=chat\]>\.bt-open-error\{[^}]+\}/)[0]
  writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;display:flex;height:640px;font-family:-apple-system,sans-serif;background:#fcfcfc;color:#141414;--bt-ink:#141414}
    [data-sidebar]{width:280px;background:#f7f7f7;padding:12px;box-sizing:border-box}
    [data-conversation-region=chat]{position:relative;flex:1}
    [data-composer-card]{position:absolute;left:24px;right:24px;bottom:16px;height:44px;border:1px dashed #ccc;border-radius:22px}
    ${rule}${lines}${placed}
  </style>${doc.body.innerHTML}`)
  const png = join(shotDir, 'boot.png')
  // Eval run 7616 (pid 105646, /usr/bin/google-chrome) launched
  // `--virtual-time-budget=2000 --screenshot=boot.png` plus a bare filesystem
  // path. The PNG was missing at every 250ms sample. Stdout stayed empty.
  // Stderr was six DBus lines in the first 219ms and one XNNPACK line at
  // 12.3s, then silence. The 2000ms budget never exited the process; SIGKILL
  // landed at 45.0s with no PNG. Those flags are not used here. DevTools
  // captures the bitmap of an explicit file:// page and this test writes the
  // PNG before the browser is closed. A throw before decode is a capture fault.
  const shot = await capturePage(page, png)
  const dumped = readFileSync(png)
  let image
  try {
    image = decodePng(dumped)
  } catch (error) {
    assert.fail(`PNG decode failed after capture (${error.message}). ${shot.report}`)
  }
  const leftInk = darkPixels(image, 0, Math.floor(image.width * 0.28))
  const rightInk = darkPixels(image, Math.floor(image.width * 0.32), image.width)
  assert.ok(image.width >= 800 && image.height >= 400, `visual: png ${image.width}x${image.height}. ${shot.report}`)
  assert.ok(leftInk > 30, `visual: sidebar alert not painted (${leftInk} dark pixels). ${shot.report}`)
  assert.ok(rightInk > 30, `visual: chat alert not painted (${rightInk} dark pixels). ${shot.report}`)
  assert.equal(shot.html.match(/data-open-error="chat"/g)?.length, 1, shot.report)
  assert.equal(shot.html.match(/data-open-error="sidebar"/g)?.length, 1, shot.report)
  assert.equal(shot.html.includes('conversation.input.dock'), false)

  await act(async () => {
    setRoster({ ready: true, mainBotId: 'm', byId: { m: { id: 'm' } }, loadError: '请求失败（HTTP 404）' })
  })
  found = alerts(doc)
  assert.equal(found.chat.length, 0, 'a successful state answer clears the chat alert')
  assert.equal(found.side.length, 0, 'a successful state answer clears the sidebar alert')
  await act(async () => {
    sideRoot.unmount()
    overlayRoot.unmount()
  })
})

test('the chat alert attaches when the region appears later and follows a replacement', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="overlay"></div></body>')
  installDom(dom)
  const doc = dom.window.document
  const { useRoster } = rosterStore({ ready: false, byId: {}, loadError: 'HTTP 404' })
  const root = createRoot(doc.getElementById('overlay'))
  await act(async () => {
    root.render(h(OpenErrorNotice, { useRoster }))
  })
  assert.equal(doc.querySelector('[data-open-error="chat"]'), null)

  const late = doc.createElement('div')
  late.setAttribute('data-conversation-region', 'chat')
  await act(async () => {
    doc.body.appendChild(late)
    await new Promise(resolve => setTimeout(resolve, 30))
  })
  assert.equal(late.querySelectorAll('[role=alert]').length, 1)
  assert.match(late.textContent, /HTTP 404/)
  assert.match(late.textContent, /Restart DS Bot/)

  const replacement = doc.createElement('div')
  replacement.setAttribute('data-conversation-region', 'chat')
  await act(async () => {
    late.replaceWith(replacement)
    await new Promise(resolve => setTimeout(resolve, 30))
  })
  assert.equal(late.querySelector('[role=alert]'), null, 'detached region keeps no alert')
  assert.equal(replacement.querySelectorAll('[role=alert]').length, 1, 'replacement region shows the alert')
  assert.match(replacement.textContent, /Restart DS Bot/)
  assert.equal(doc.querySelectorAll('[data-open-error="chat"]').length, 1)

  await act(async () => { root.unmount() })
})

test('a network failure stays on the chat column without restart guidance', async () => {
  const dom = new JSDOM(BOOT_HTML)
  installDom(dom)
  const doc = dom.window.document
  const { useRoster } = rosterStore({
    ready: false,
    byId: {},
    loadError: 'Could not reach DSH. Check that it is still running. /home/box/.dsh/secret',
  })
  const root = createRoot(doc.getElementById('side'))
  await act(async () => { root.render(h(Side, { useRoster })) })
  const alert = doc.querySelector('[data-sidebar] [role=alert]')
  assert.ok(alert)
  assert.match(alert.textContent, /keep trying/)
  assert.equal(/Restart DS Bot/.test(alert.textContent), false)
  assert.equal(alert.textContent.includes('/home/box'), false)
  await act(async () => { root.unmount() })
})

function chromeBinary() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      const found = execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim()
      if (found) return found
    } catch { /* try the next name */ }
  }
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, join(homedir(), '.cache/ms-playwright')].filter(Boolean)
  for (const root of roots) {
    const found = findChrome(root, 0)
    if (found) return found
  }
  return null
}

function findChrome(dir, depth) {
  if (depth > 4 || !existsSync(dir)) return null
  let names
  try { names = readdirSync(dir) } catch { return null }
  for (const name of names) {
    const path = join(dir, name)
    if (name === 'chrome' || name === 'chromium' || name === 'google-chrome') {
      try { if (statSync(path).isFile()) return path } catch { /* keep looking */ }
    }
  }
  for (const name of names) {
    const path = join(dir, name)
    try { if (!statSync(path).isDirectory()) continue } catch { continue }
    const found = findChrome(path, depth + 1)
    if (found) return found
  }
  return null
}

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// Whole capture, including a slow DevTools port. Each step below has its own
// shorter deadline. Cleanup is not part of this budget: it always runs after.
const CAPTURE_BUDGET_MS = 20000
const STEP_MS = 8000
const TERM_GRACE_MS = 3000
const KILL_GRACE_MS = 2000

function captureFault(phase, message) {
  return Object.assign(new Error(message), { phase })
}

// `close` is the only finished state. A signal death reports code null, so an
// exit-code check would treat that process as still running.
function trackChild(child) {
  const life = {
    closed: false,
    exitCode: null,
    signal: null,
    stderr: '',
    stopPromise: null,
  }
  life.closedPromise = new Promise((resolve) => {
    const done = (code, sig) => {
      if (life.closed) return
      life.closed = true
      life.exitCode = code
      life.signal = sig
      resolve({ code, signal: sig })
    }
    // A failed spawn emits `error` and no `close`. Leaving that unhandled
    // would crash the test and skip the rest of cleanup.
    child.on('error', (error) => {
      life.spawnError = error
      done(null, null)
    })
    child.on('close', (code, sig) => done(code, sig))
  })
  child.stderr?.on('data', (chunk) => {
    life.stderr = (life.stderr + chunk).slice(-4000)
  })
  return life
}

function stopChild(child, life, limits = {}) {
  if (life.stopPromise) return life.stopPromise
  const termGraceMs = limits.termGraceMs ?? TERM_GRACE_MS
  const killGraceMs = limits.killGraceMs ?? KILL_GRACE_MS
  life.stopPromise = (async () => {
    if (!life.closed) {
      try { child.kill('SIGTERM') } catch { /* close already won the race */ }
      const termed = await Promise.race([
        life.closedPromise,
        wait(termGraceMs).then(() => null),
      ])
      if (!termed && !life.closed) {
        try { child.kill('SIGKILL') } catch { /* close already won the race */ }
        const killed = await Promise.race([
          life.closedPromise,
          wait(killGraceMs).then(() => null),
        ])
        if (!killed && !life.closed) {
          throw captureFault('cleanup', 'capture: browser did not exit after SIGKILL')
        }
      }
    }
    return life.closedPromise
  })()
  return life.stopPromise
}

// `work` receives an abort signal. The budget rejects even if a step forgot
// its own deadline, then SIGTERM, the grace period, SIGKILL, and `close` all
// still run. A signal exit (code null) counts as closed.
async function runCaptured(child, life, work, limits = {}) {
  const budgetMs = limits.budgetMs ?? CAPTURE_BUDGET_MS
  const abort = new AbortController()
  const budget = setTimeout(() => abort.abort(), budgetMs)
  let failure = null
  let value
  const aborted = new Promise((resolve) => {
    const onAbort = () => resolve({
      ok: false,
      error: captureFault('budget', 'capture: exceeded the capture budget'),
    })
    if (abort.signal.aborted) onAbort()
    else abort.signal.addEventListener('abort', onAbort, { once: true })
  })
  const worked = Promise.resolve()
    .then(() => work(abort.signal))
    .then(
      (result) => ({ ok: true, result }),
      (error) => ({ ok: false, error }),
    )
  try {
    const outcome = await Promise.race([worked, aborted])
    if (outcome.ok) value = outcome.result
    else failure = outcome.error?.phase ? outcome.error : captureFault('capture', outcome.error?.message ?? 'capture failed')
  } finally {
    clearTimeout(budget)
    abort.abort()
  }
  try {
    await stopChild(child, life, limits)
  } catch (error) {
    if (!failure) failure = error
  }
  if (failure) throw failure
  return value
}

async function fetchJson(url, ms, signal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw captureFault('devtools', `capture: DevTools list returned HTTP ${response.status}`)
    return await response.json()
  } catch (error) {
    if (signal?.aborted) throw captureFault('budget', 'capture: exceeded the capture budget')
    if (error?.phase) throw error
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw captureFault('devtools', 'capture: DevTools list timed out')
    }
    throw captureFault('devtools', `capture: DevTools list failed: ${error?.message ?? error}`)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

// Eval 7616 never produced boot.png from `--screenshot`. Ask the live browser
// for the bitmap over DevTools, write that PNG, then close Chrome. The port
// poll, the list fetch, the socket handshake, and each DevTools call have
// their own deadline, and the whole capture has one more. Cleanup always
// waits until `close`, including when that close carries a null exit code.
async function capturePage(page, png) {
  const bin = chromeBinary()
  const started = Date.now()
  if (!bin) throw new Error('capture: no Chrome binary. Set CHROME_BIN or install google-chrome, chromium, or Playwright Chrome.')
  const dir = mkdtempSync(join(tmpdir(), 'chrome-open-error-'))
  const args = [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--remote-allow-origins=*',
    `--remote-debugging-port=0`, `--user-data-dir=${dir}`,
    '--window-size=1100,640', 'about:blank',
  ]
  const child = spawn(bin, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: 'disabled:' },
  })
  const life = trackChild(child)
  let html
  try {
    html = await runCaptured(child, life, async (signal) => {
      const port = await devtoolsPort(dir, life, signal)
      const list = await fetchJson(`http://127.0.0.1:${port}/json/list`, STEP_MS, signal)
      const target = list.find(entry => entry.type === 'page' && entry.webSocketDebuggerUrl)
      if (!target) throw captureFault('devtools', 'capture: DevTools listed no page')
      return withPage(target.webSocketDebuggerUrl, pathToFileURL(page).href, async (send) => {
        const shot = await send('Page.captureScreenshot', { format: 'png' })
        if (typeof shot?.data !== 'string' || shot.data.length < 100) {
          throw captureFault('screenshot', 'capture: Page.captureScreenshot returned no PNG')
        }
        writeFileSync(png, Buffer.from(shot.data, 'base64'))
        const dom = await send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true })
        return dom?.result?.value ?? ''
      }, { signal })
    })
  } catch (error) {
    const phase = error.phase ?? 'capture'
    const detail = [
      `${phase}: ${error.message}`,
      'This failed before pixel checks, so it is a browser launch/capture fault, not a visual assertion.',
      `bin=${bin}`,
      `exit=${life.exitCode}`,
      `signal=${life.signal}`,
      `closed=${life.closed}`,
      `elapsedMs=${Date.now() - started}`,
      `png=${existsSync(png) ? statSync(png).size : 'missing'}`,
      life.stderr ? `stderr=${life.stderr.slice(-800)}` : 'stderr empty',
    ].join('\n')
    throw new Error(detail)
  }
  return {
    html,
    report: [
      'phase=captured',
      `bin=${bin}`,
      `exit=${life.exitCode}`,
      `signal=${life.signal}`,
      `closed=${life.closed}`,
      `elapsedMs=${Date.now() - started}`,
      `pngBytes=${statSync(png).size}`,
      life.stderr ? `stderr=${life.stderr.slice(-800)}` : 'stderr empty',
    ].join('\n'),
  }
}

async function devtoolsPort(dir, life, signal) {
  const file = join(dir, 'DevToolsActivePort')
  const deadline = Date.now() + STEP_MS
  while (Date.now() < deadline) {
    if (signal?.aborted) throw captureFault('budget', 'capture: exceeded the capture budget')
    if (existsSync(file)) {
      const port = Number(readFileSync(file, 'utf8').split('\n')[0])
      if (port > 0) return port
    }
    if (life.closed) break
    await wait(50)
  }
  if (signal?.aborted) throw captureFault('budget', 'capture: exceeded the capture budget')
  throw captureFault('devtools-port', `capture: DevTools port was not published. stderr=${life.stderr.slice(-800)}`)
}

function withPage(wsUrl, url, run, options = {}) {
  const handshakeMs = options.handshakeMs ?? STEP_MS
  const stepMs = options.stepMs ?? STEP_MS
  const signal = options.signal
  const ws = new WebSocket(wsUrl)
  let next = 0
  const pending = new Map()
  const events = []
  const waiters = []
  let opened = false
  let settled = false
  const failPending = (error) => {
    for (const job of pending.values()) job.reject(error)
    pending.clear()
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
  }
  return new Promise((resolve, reject) => {
    let handshakeTimer
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(handshakeTimer)
      signal?.removeEventListener('abort', onAbort)
      if (value instanceof Error) failPending(value)
      try { ws.close() } catch { /* already closing */ }
      fn(value)
    }
    const onAbort = () => finish(reject, captureFault('budget', 'capture: exceeded the capture budget'))
    handshakeTimer = setTimeout(() => {
      finish(reject, captureFault('devtools', 'capture: DevTools socket did not open'))
    }, handshakeMs)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    ws.addEventListener('message', (event) => {
      let message
      try { message = JSON.parse(event.data) } catch { return }
      if (message.id !== undefined && pending.has(message.id)) {
        const job = pending.get(message.id)
        pending.delete(message.id)
        if (message.error) job.reject(new Error(message.error.message))
        else job.resolve(message.result)
        return
      }
      events.push(message)
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        if (waiters[index].method === message.method) {
          const waiter = waiters.splice(index, 1)[0]
          clearTimeout(waiter.timer)
          waiter.resolve(message.params)
        }
      }
    })
    ws.addEventListener('error', () => {
      if (!opened) finish(reject, captureFault('devtools', 'capture: DevTools socket failed'))
    })
    ws.addEventListener('close', () => {
      if (!opened) finish(reject, captureFault('devtools', 'capture: DevTools socket closed before open'))
      else finish(reject, captureFault('devtools', 'capture: DevTools socket closed'))
    })
    const send = (method, params = {}) => new Promise((resolveSend, rejectSend) => {
      const id = ++next
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectSend(captureFault('screenshot', `capture: ${method} timed out`))
      }, stepMs)
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolveSend(value) },
        reject: (error) => { clearTimeout(timer); rejectSend(error) },
      })
      try {
        ws.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        rejectSend(captureFault('devtools', error?.message ?? 'capture: DevTools send failed'))
      }
    })
    const once = (method) => new Promise((resolveOnce, rejectOnce) => {
      const already = events.find(message => message.method === method)
      if (already) { resolveOnce(already.params); return }
      const timer = setTimeout(() => rejectOnce(captureFault('navigate', `capture: ${method} was not emitted`)), stepMs)
      waiters.push({ method, timer, resolve: resolveOnce, reject: rejectOnce })
    })
    ws.addEventListener('open', () => {
      if (settled) return
      opened = true
      clearTimeout(handshakeTimer)
      send('Page.enable').then(() => send('Runtime.enable')).then(() => {
        const loaded = once('Page.loadEventFired')
        return send('Page.navigate', { url }).then(() => loaded)
      }).then(() => run(send)).then((value) => {
        finish(resolve, value)
      }).catch((error) => {
        finish(reject, error?.phase ? error : captureFault('screenshot', error?.message ?? 'capture failed'))
      })
    })
  })
}

test('capture cleanup observes a signal exit and still reaps an ignored SIGTERM', { timeout: 8000 }, async () => {
  const signaled = spawn(process.execPath, ['-e', 'setTimeout(() => process.kill(process.pid, "SIGTERM"), 30)'], { stdio: 'ignore' })
  const signaledLife = trackChild(signaled)
  try {
    const died = await Promise.race([
      signaledLife.closedPromise,
      wait(1000).then(() => null),
    ])
    assert.ok(died, 'the child did not exit from its own SIGTERM')
    assert.equal(signaledLife.exitCode, null)
    const began = Date.now()
    const ended = await stopChild(signaled, signaledLife, { termGraceMs: 1000, killGraceMs: 1000 })
    const elapsed = Date.now() - began
    assert.equal(signaledLife.closed, true)
    assert.equal(signaledLife.signal, 'SIGTERM')
    assert.equal(ended.signal, 'SIGTERM')
    assert.equal(ended.code, null)
    assert.ok(elapsed < 200, `a signal exit was treated as still running (${elapsed}ms)`)
  } finally {
    if (!signaledLife.closed) signaled.kill('SIGKILL')
  }

  const stubborn = await spawnIgnoringTerm()
  const began = Date.now()
  try {
    const ended = await stopChild(stubborn.child, stubborn.life, { termGraceMs: 200, killGraceMs: 2000 })
    const elapsed = Date.now() - began
    assert.equal(stubborn.life.closed, true)
    assert.equal(stubborn.life.exitCode, null)
    assert.equal(ended.signal, 'SIGKILL')
    assert.ok(elapsed >= 150, `SIGKILL escalated too early (${elapsed}ms)`)
    assert.ok(elapsed < 3000, `cleanup was not bounded (${elapsed}ms)`)
  } finally {
    if (!stubborn.life.closed) stubborn.child.kill('SIGKILL')
  }
})

test('capture fetch, handshake, and budget each stop and the browser is still reaped', { timeout: 8000 }, async () => {
  const hangingSockets = new Set()
  const hanging = createServer(() => {})
  hanging.on('connection', (socket) => {
    hangingSockets.add(socket)
    socket.on('close', () => hangingSockets.delete(socket))
  })
  await new Promise((resolve) => hanging.listen(0, '127.0.0.1', resolve))
  const hangingPort = hanging.address().port
  const fetchBegan = Date.now()
  try {
    await assert.rejects(
      fetchJson(`http://127.0.0.1:${hangingPort}/json/list`, 200),
      /DevTools list timed out/,
    )
    const fetchElapsed = Date.now() - fetchBegan
    assert.ok(fetchElapsed < 1000, `list fetch was not bounded (${fetchElapsed}ms)`)
    const abort = new AbortController()
    const aborted = fetchJson(`http://127.0.0.1:${hangingPort}/json/list`, 5000, abort.signal)
    setTimeout(() => abort.abort(), 40)
    const abortBegan = Date.now()
    await assert.rejects(aborted, /exceeded the capture budget/)
    const abortElapsed = Date.now() - abortBegan
    assert.ok(abortElapsed < 1000, `aborted list fetch waited out its own timer (${abortElapsed}ms)`)
  } finally {
    for (const socket of hangingSockets) socket.destroy()
    hanging.close()
  }

  const closedEarly = createNetServer((socket) => { socket.destroy() })
  await new Promise((resolve) => closedEarly.listen(0, '127.0.0.1', resolve))
  try {
    const earlyBegan = Date.now()
    await assert.rejects(
      withPage(`ws://127.0.0.1:${closedEarly.address().port}`, 'about:blank', async () => '', { handshakeMs: 2000, stepMs: 2000 }),
      /DevTools socket closed before open|DevTools socket failed/,
    )
    const earlyElapsed = Date.now() - earlyBegan
    assert.ok(earlyElapsed < 1000, `pre-open close waited for the handshake timer (${earlyElapsed}ms)`)
  } finally {
    closedEarly.close()
  }

  const silentSockets = new Set()
  const silent = createNetServer((socket) => {
    silentSockets.add(socket)
    socket.on('error', () => {})
  })
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve))
  try {
    const silentBegan = Date.now()
    await assert.rejects(
      withPage(`ws://127.0.0.1:${silent.address().port}`, 'about:blank', async () => '', { handshakeMs: 200, stepMs: 200 }),
      /DevTools socket did not open/,
    )
    const silentElapsed = Date.now() - silentBegan
    assert.ok(silentElapsed >= 150, `handshake timer fired too early (${silentElapsed}ms)`)
    assert.ok(silentElapsed < 1000, `handshake timer was not bounded (${silentElapsed}ms)`)
  } finally {
    for (const socket of silentSockets) socket.destroy()
    silent.close()
  }

  const stubborn = await spawnIgnoringTerm()
  const began = Date.now()
  try {
    await assert.rejects(
      runCaptured(stubborn.child, stubborn.life, () => new Promise(() => {}), { budgetMs: 250, termGraceMs: 150, killGraceMs: 2000 }),
      /exceeded the capture budget/,
    )
    const elapsed = Date.now() - began
    assert.equal(stubborn.life.closed, true)
    assert.equal(stubborn.life.exitCode, null)
    assert.equal(stubborn.life.signal, 'SIGKILL')
    assert.ok(elapsed >= 350, `budget cleanup skipped the SIGTERM grace (${elapsed}ms)`)
    assert.ok(elapsed < 3000, `budget cleanup was not bounded (${elapsed}ms)`)
  } finally {
    if (!stubborn.life.closed) stubborn.child.kill('SIGKILL')
  }
})

async function spawnIgnoringTerm() {
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const life = trackChild(child)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stubborn child did not start')), 2000)
    const fail = () => {
      clearTimeout(timer)
      reject(new Error('stubborn child exited before it could ignore SIGTERM'))
    }
    child.once('close', fail)
    child.stdout.on('data', (chunk) => {
      if (!String(chunk).includes('ready')) return
      clearTimeout(timer)
      child.removeListener('close', fail)
      resolve()
    })
  })
  return { child, life }
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft
  const dl = Math.abs(estimate - left)
  const du = Math.abs(estimate - up)
  const dlu = Math.abs(estimate - upLeft)
  if (dl <= du && dl <= dlu) return left
  return du <= dlu ? up : upLeft
}

function decodePng(buf) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'not a PNG')
  let offset = 8
  let width = 0
  let height = 0
  let colorType = -1
  const idat = []
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii')
    const data = buf.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      colorType = data[9]
      // IHDR data: 8 bit depth, 9 color type, 10 compression, 11 filter, 12 interlace.
      assert.equal(data[8], 8, 'IHDR bit depth (index 8)')
      assert.equal(data[10], 0, 'IHDR compression method (index 10)')
      assert.equal(data[11], 0, 'IHDR filter method (index 11)')
      assert.equal(data[12], 0, 'IHDR interlace method (index 12)')
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : null
  assert.ok(channels, `png color type ${colorType}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const rows = []
  let cursor = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor]
    cursor += 1
    const row = Buffer.alloc(stride)
    const prior = rows[y - 1] ?? Buffer.alloc(stride)
    for (let i = 0; i < stride; i += 1) {
      const value = raw[cursor]
      cursor += 1
      const left = i >= channels ? row[i - channels] : 0
      const up = prior[i]
      const upLeft = i >= channels ? prior[i - channels] : 0
      if (filter === 0) row[i] = value
      else if (filter === 1) row[i] = (value + left) & 255
      else if (filter === 2) row[i] = (value + up) & 255
      else if (filter === 3) row[i] = (value + Math.floor((left + up) / 2)) & 255
      else if (filter === 4) row[i] = (value + paeth(left, up, upLeft)) & 255
      else throw new Error(`png filter ${filter}`)
    }
    rows.push(row)
  }
  return { width, height, channels, rows }
}

function darkPixels(image, x0, x1) {
  let count = 0
  const step = Math.max(1, Math.floor(image.height / 200))
  for (let y = 0; y < image.height; y += step) {
    const row = image.rows[y]
    for (let x = x0; x < x1; x += 2) {
      const at = x * image.channels
      if (row[at] < 80 && row[at + 1] < 80 && row[at + 2] < 80) count += 1
    }
  }
  return count
}
