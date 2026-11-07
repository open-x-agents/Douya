import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createElement as h, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { OPEN_RECOVERY, OpenErrorNotice, openErrorNode } from '../src/client/open-error.js'
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
  assert.match(found.chat[0].textContent, /请求失败（HTTP 404）/)
  assert.match(found.chat[0].textContent, /Restart DS Bot/)
  assert.match(found.side[0].textContent, /Restart DS Bot/)
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
  await chromeShot(page, png)
  const dumped = readFileSync(png)
  assert.ok(dumped.length > 1000, 'browser painted the boot page')
  const domDump = await chromeDom(page)
  assert.equal(domDump.match(/data-open-error="chat"/g)?.length, 1)
  assert.equal(domDump.match(/data-open-error="sidebar"/g)?.length, 1)
  assert.equal(domDump.includes('conversation.input.dock'), false)
  writeFileSync('/tmp/verify-this/open-error-boot.png', dumped)
  writeFileSync('/tmp/verify-this/open-error-boot.html', readFileSync(page))

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

function chromeShot(page, png) {
  return chrome(['--screenshot=' + png, '--window-size=1100,640'], page)
}

function chromeDom(page) {
  return chrome(['--dump-dom'], page).then(({ stdout }) => stdout)
}

function chrome(extra, page) {
  const dir = mkdtempSync(join(tmpdir(), 'chrome-open-error-'))
  return new Promise((resolve) => {
    const child = spawn('google-chrome', [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      `--user-data-dir=${dir}`, '--virtual-time-budget=500',
      ...extra, page,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    // Headless Chrome writes the screenshot and then can stay up on this host.
    const timer = setTimeout(() => child.kill('SIGKILL'), 4000)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', () => { clearTimeout(timer); resolve({ stdout, stderr }) })
  })
}
