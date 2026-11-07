import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
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
    body{margin:0;display:flex;height:640px;font-family:-apple-system,sans-serif;background:#fcfcfc}
    [data-sidebar]{width:280px;background:#f7f7f7;padding:12px;box-sizing:border-box}
    [data-conversation-region=chat]{position:relative;flex:1}
    [data-composer-card]{position:absolute;left:24px;right:24px;bottom:16px;height:44px;border:1px dashed #ccc;border-radius:22px}
    ${rule}${lines}${placed}
  </style>${doc.body.innerHTML}`)
  const png = join(shotDir, 'boot.png')
  const shot = await runChrome(['--screenshot=' + png, '--window-size=1100,640'], page)
  let dumped
  try {
    dumped = readFileSync(png)
  } catch (error) {
    assert.fail(`boot.png was not written (${error.code ?? error.message}). ${chromeReport(shot)}`)
  }
  const image = decodePng(dumped)
  const leftInk = darkPixels(image, 0, Math.floor(image.width * 0.28))
  const rightInk = darkPixels(image, Math.floor(image.width * 0.32), image.width)
  assert.ok(image.width >= 800 && image.height >= 400, `png ${image.width}x${image.height}. ${chromeReport(shot)}`)
  assert.ok(leftInk > 30, `sidebar alert not painted (${leftInk} dark pixels). ${chromeReport(shot)}`)
  assert.ok(rightInk > 30, `chat alert not painted (${rightInk} dark pixels). ${chromeReport(shot)}`)
  const dumpedDom = await runChrome(['--dump-dom'], page)
  assert.equal(dumpedDom.stdout.match(/data-open-error="chat"/g)?.length, 1, chromeReport(dumpedDom))
  assert.equal(dumpedDom.stdout.match(/data-open-error="sidebar"/g)?.length, 1, chromeReport(dumpedDom))
  assert.equal(dumpedDom.stdout.includes('conversation.input.dock'), false)

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

// Chrome on this host can write the PNG and then stay up, and a 4s kill on a
// slower host can land before the file exists. Wait until the process exits or
// the PNG is stable, and keep stderr, exit, signal, and size samples either way.
function runChrome(extra, page) {
  const bin = chromeBinary()
  const started = Date.now()
  const screenshot = extra.find(arg => arg.startsWith('--screenshot='))?.slice('--screenshot='.length) ?? null
  if (!bin) {
    return Promise.reject(new Error('no Chrome binary. Set CHROME_BIN or install google-chrome, chromium, or Playwright Chrome.'))
  }
  const dir = mkdtempSync(join(tmpdir(), 'chrome-open-error-'))
  return new Promise((resolve, reject) => {
    const args = [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      `--user-data-dir=${dir}`, '--virtual-time-budget=2000',
      ...extra, page,
    ]
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    let stableAt = null
    const samples = []
    const sample = () => {
      let size = null
      try { size = screenshot && existsSync(screenshot) ? statSync(screenshot).size : null } catch { size = null }
      samples.push({ ms: Date.now() - started, size })
    }
    const finish = (exitCode, signal) => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(killTimer)
      sample()
      resolve({
        bin, args, stdout, stderr, exitCode, signal,
        elapsedMs: Date.now() - started, samples, screenshot,
      })
    }
    // Chrome writes the PNG or the DOM and then can stay up. A fixed 4s kill
    // can land before either exists. Once the artifact is stable, stop the
    // process; SIGKILL follows if SIGTERM does not reap it.
    const poll = setInterval(() => {
      sample()
      const last = samples.at(-1)
      const prev = samples.at(-2)
      const shotReady = Boolean(screenshot) && last?.size > 1000 && prev?.size === last.size
      const domReady = !screenshot && stdout.includes('</html>') && stdout.length > 200
      if (!(shotReady || domReady)) return
      if (stableAt === null) {
        stableAt = Date.now()
        child.kill('SIGTERM')
      } else if (Date.now() - stableAt > 1000) child.kill('SIGKILL')
    }, 250)
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 45000)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(killTimer)
      reject(Object.assign(error, { bin, elapsedMs: Date.now() - started, stderr, samples }))
    })
    child.on('close', (code, signal) => finish(code, signal))
  })
}

function chromeReport(run, error) {
  const sizes = (run.samples ?? []).map(sample => `${sample.ms}ms:${sample.size ?? 'missing'}`).join(' ')
  const err = run.stderr ? run.stderr.slice(-800) : ''
  return [
    error ? String(error.message ?? error) : '',
    `bin=${run.bin}`,
    `exit=${run.exitCode}`,
    `signal=${run.signal}`,
    `elapsedMs=${run.elapsedMs}`,
    `screenshot=${run.screenshot ?? 'none'}`,
    `sizes=${sizes || 'none'}`,
    err ? `stderr=${err}` : 'stderr empty',
  ].filter(Boolean).join('\n')
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
      assert.equal(data[8], 8, 'png bit depth')
      assert.equal(data[10], 0, 'png must be non-interlaced')
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
