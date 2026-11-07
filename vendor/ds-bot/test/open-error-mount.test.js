import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
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

// Eval 7616 never produced boot.png from `--screenshot`. Ask the live browser
// for the bitmap over DevTools, write that PNG, then close Chrome. SIGKILL is
// only cleanup after the bytes are already on disk.
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
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: 'disabled:' },
  })
  let stderr = ''
  let exitCode = null
  let signal = null
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.on('close', (code, sig) => { exitCode = code; signal = sig })
  const trace = () => ({
    bin, args, stderr, exitCode, signal,
    elapsedMs: Date.now() - started, phase: 'launch',
  })
  const stop = async () => {
    if (exitCode !== null) return
    child.kill('SIGTERM')
    const deadline = Date.now() + 3000
    while (exitCode === null && Date.now() < deadline) await wait(50)
    if (exitCode === null) child.kill('SIGKILL')
  }
  try {
    const port = await devtoolsPort(dir, child, () => exitCode, () => stderr)
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json())
    const target = list.find(entry => entry.type === 'page' && entry.webSocketDebuggerUrl)
    if (!target) throw Object.assign(new Error('capture: DevTools listed no page'), { phase: 'devtools', ...trace() })
    const html = await withPage(target.webSocketDebuggerUrl, pathToFileURL(page).href, async (send) => {
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      if (typeof shot?.data !== 'string' || shot.data.length < 100) {
        throw Object.assign(new Error('capture: Page.captureScreenshot returned no PNG'), { phase: 'screenshot' })
      }
      writeFileSync(png, Buffer.from(shot.data, 'base64'))
      const dom = await send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true })
      return dom?.result?.value ?? ''
    })
    await stop()
    return {
      html,
      report: [
        'phase=captured',
        `bin=${bin}`,
        `exit=${exitCode}`,
        `signal=${signal}`,
        `elapsedMs=${Date.now() - started}`,
        `pngBytes=${statSync(png).size}`,
        stderr ? `stderr=${stderr.slice(-800)}` : 'stderr empty',
      ].join('\n'),
    }
  } catch (error) {
    await stop()
    const phase = error.phase ?? 'capture'
    const detail = [
      `${phase}: ${error.message}`,
      'This failed before pixel checks, so it is a browser launch/capture fault, not a visual assertion.',
      `bin=${bin}`,
      `exit=${exitCode}`,
      `signal=${signal}`,
      `elapsedMs=${Date.now() - started}`,
      `png=${existsSync(png) ? statSync(png).size : 'missing'}`,
      stderr ? `stderr=${stderr.slice(-800)}` : 'stderr empty',
    ].join('\n')
    throw new Error(detail)
  }
}

async function devtoolsPort(dir, child, exitCode, stderr) {
  const file = join(dir, 'DevToolsActivePort')
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const port = Number(readFileSync(file, 'utf8').split('\n')[0])
      if (port > 0) return port
    }
    if (exitCode() !== null) break
    await wait(50)
  }
  throw Object.assign(new Error(`capture: DevTools port was not published. stderr=${stderr().slice(-800)}`), { phase: 'devtools-port' })
}

function withPage(wsUrl, url, run) {
  const ws = new WebSocket(wsUrl)
  let next = 0
  const pending = new Map()
  const events = []
  const waiters = []
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
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
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(Object.assign(new Error(`capture: ${method} timed out`), { phase: 'screenshot' }))
    }, 8000)
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value) },
      reject: (error) => { clearTimeout(timer); reject(error) },
    })
    ws.send(JSON.stringify({ id, method, params }))
  })
  const once = (method) => new Promise((resolve, reject) => {
    const already = events.find(message => message.method === method)
    if (already) { resolve(already.params); return }
    const timer = setTimeout(() => reject(Object.assign(new Error(`capture: ${method} was not emitted`), { phase: 'navigate' })), 8000)
    waiters.push({ method, timer, resolve })
  })
  return new Promise((resolve, reject) => {
    const fail = (error) => { ws.close(); reject(error) }
    ws.addEventListener('error', () => fail(Object.assign(new Error('capture: DevTools socket failed'), { phase: 'devtools' })))
    ws.addEventListener('open', () => {
      send('Page.enable').then(() => send('Runtime.enable')).then(() => {
        const loaded = once('Page.loadEventFired')
        return send('Page.navigate', { url }).then(() => loaded)
      }).then(() => run(send)).then((value) => {
        ws.close()
        resolve(value)
      }).catch(fail)
    })
  })
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
