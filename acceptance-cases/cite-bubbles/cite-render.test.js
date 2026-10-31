// Renders the reloaded group page the desktop actually paints: the host's own
// user bubble, not .bt-umsg, plus the late cite. The hider the client calls
// has to leave each cited sentence once in that page.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hideCitedHostBubbles, lateCiteHtml } from '../../vendor/ds-bot/src/shared/cite.js'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const WHO = '你们是谁'
const FOLLOW = '在干嘛'

function matchSel(node, selector) {
  if (selector === '*') return node.nodeType === 1
  if (selector.startsWith('.')) {
    const name = selector.slice(1)
    return String(node.className ?? '').split(/\s+/).includes(name)
  }
  const attr = /^\[([^\]=]+)(?:(\*=|=)"([^"]*)")?\]$/.exec(selector)
  if (attr == null) return false
  const [, name, op, value] = attr
  if (op == null) return node.hasAttribute(name)
  if (op === '=') return node.getAttribute(name) === value
  return String(node.className ?? '').includes(value)
}

function queryAll(rootNode, selector) {
  const out = []
  const walk = (node) => {
    for (const child of node.childNodes ?? []) {
      if (child.nodeType !== 1) continue
      if (child.matches(selector)) out.push(child)
      walk(child)
    }
  }
  walk(rootNode)
  return out
}

function documentOrder(doc) {
  const list = []
  const walk = (node) => {
    list.push(node)
    for (const child of node.childNodes ?? []) walk(child)
  }
  walk(doc)
  return list
}

function element(doc, name, attrs = {}, kids = []) {
  const node = {
    nodeType: 1,
    nodeName: name,
    childNodes: [],
    parentNode: null,
    ownerDocument: doc,
    attrs: {},
    className: '',
  }
  node.getAttribute = (key) => (Object.hasOwn(node.attrs, key) ? node.attrs[key] : null)
  node.setAttribute = (key, value) => {
    node.attrs[key] = String(value)
    if (key === 'class') node.className = node.attrs.class
  }
  node.hasAttribute = (key) => Object.hasOwn(node.attrs, key)
  node.removeAttribute = (key) => {
    delete node.attrs[key]
    if (key === 'class') node.className = ''
  }
  node.contains = (other) => {
    let current = other
    while (current != null) {
      if (current === node) return true
      current = current.parentNode
    }
    return false
  }
  node.matches = (selector) => matchSel(node, selector)
  node.closest = (selector) => {
    let current = node
    while (current != null && current.nodeType === 1) {
      if (current.matches(selector)) return current
      current = current.parentNode
    }
    return null
  }
  node.querySelectorAll = (selector) => queryAll(node, selector)
  node.compareDocumentPosition = (other) => {
    const order = documentOrder(doc)
    const left = order.indexOf(node)
    const right = order.indexOf(other)
    if (right > left) return 4
    if (right < left) return 2
    return 0
  }
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key === 'className' ? 'class' : key, value)
  for (const kid of kids) append(node, kid)
  Object.defineProperty(node, 'textContent', {
    get() { return node.childNodes.map(child => child.textContent).join('') },
  })
  return node
}

function textNode(data) {
  return { nodeType: 3, nodeName: '#text', textContent: data, data, childNodes: [], parentNode: null }
}

function append(parent, child) {
  const node = typeof child === 'string' ? textNode(child) : child
  node.parentNode = parent
  parent.childNodes.push(node)
  return node
}

function createDocument() {
  const doc = {
    nodeType: 9,
    nodeName: '#document',
    childNodes: [],
    parentNode: null,
  }
  doc.querySelectorAll = (selector) => queryAll(doc, selector)
  doc.querySelector = (selector) => queryAll(doc, selector)[0] ?? null
  const body = element(doc, 'body')
  append(doc, body)
  doc.body = body
  return doc
}

// The shape eval_bot reloaded: host bubbles above the essay, then one late cite
// of both sentences, then a later send of the same words. No .bt-umsg.
function reloadedPage() {
  const doc = createDocument()
  const sidebar = element(doc, 'aside', { class: 'sidebar' }, [
    element(doc, 'div', { class: 'preview' }, [WHO]),
    element(doc, 'div', { class: 'preview' }, [FOLLOW]),
  ])
  const scroll = element(doc, 'div', { 'data-conversation-scroll': '' })
  const history = (id, sentence) => element(doc, 'div', { id, class: 'x_flowItem_a', 'data-chat-flow-kind': 'user' }, [
    element(doc, 'div', { class: 'x_userRow_a' }, [
      element(doc, 'div', { class: 'x_bubble_a' }, [
        element(doc, 'p', {}, [sentence]),
      ]),
      element(doc, 'div', { class: 'x_actions_a' }, [
        element(doc, 'span', { class: 'x_timeStart_a' }, ['4:09 PM']),
      ]),
    ]),
  ])
  // The clock sits in the same text node as the sentence. No inner element holds
  // the sentence alone, which is how a host bubble's textContent arrives.
  const glued = element(doc, 'div', { id: 'hist-glued', class: 'x_flowItem_a', 'data-chat-flow-kind': 'user' }, [
    element(doc, 'div', { class: 'x_userRow_a' }, [
      element(doc, 'div', { class: 'x_bubble_a' }, [`${FOLLOW}4:11 PM`]),
    ]),
  ])
  const cite = element(doc, 'div', {
    id: 'cite',
    class: 'bt-route-cite',
    'data-late-cite': '',
    'data-cite-texts': JSON.stringify([WHO, FOLLOW]),
  }, [
    element(doc, 'div', { class: 'bt-route-cite-label' }, ['Replying to what you wrote earlier']),
    element(doc, 'div', { class: 'bt-urow' }, [
      element(doc, 'div', { class: 'bt-ububble' }, [element(doc, 'p', {}, [WHO])]),
    ]),
    element(doc, 'div', { class: 'bt-urow' }, [
      element(doc, 'div', { class: 'bt-ububble' }, [element(doc, 'p', {}, [FOLLOW])]),
    ]),
  ])
  const pending = element(doc, 'div', { id: 'pending', class: 'x_userRow_a', 'data-pending-steering': '' }, [
    element(doc, 'div', { class: 'x_bubble_a' }, [element(doc, 'p', {}, [`${WHO}\n未读`])]),
  ])
  const later = history('later-who', WHO)
  const dock = element(doc, 'div', { id: 'dock', class: 'bt-route-dock', 'data-route-dock': '' }, [
    element(doc, 'div', { class: 'bt-route-text' }, [WHO]),
  ])
  append(doc.body, sidebar)
  append(doc.body, scroll)
  append(scroll, history('hist-who', WHO))
  append(scroll, history('hist-follow', FOLLOW))
  append(scroll, glued)
  append(scroll, pending)
  append(scroll, cite)
  append(scroll, element(doc, 'div', { class: 'essay' }, ['秋水正文']))
  append(scroll, later)
  append(scroll, dock)
  return doc
}

function byId(doc, id) {
  return doc.querySelectorAll('*').find(node => node.getAttribute('id') === id)
}

function shown(node) {
  let current = node
  while (current != null) {
    if (current.hasAttribute?.('data-cited-history')) return false
    current = current.parentNode
  }
  return true
}

test('a reloaded page hides the host history bubbles once the late cite paints', () => {
  const doc = reloadedPage()
  const hidden = hideCitedHostBubbles(doc)
  assert.ok(hidden >= 4)
  assert.equal(byId(doc, 'hist-who').getAttribute('data-cited-history'), '1')
  assert.equal(byId(doc, 'hist-follow').getAttribute('data-cited-history'), '1')
  assert.equal(byId(doc, 'hist-glued').getAttribute('data-cited-history'), '1')
  assert.equal(byId(doc, 'pending').getAttribute('data-cited-history'), '1')
  assert.equal(byId(doc, 'later-who').hasAttribute('data-cited-history'), false)
  assert.equal(byId(doc, 'cite').hasAttribute('data-cited-history'), false)
  assert.equal(byId(doc, 'dock').hasAttribute('data-cited-history'), false)
  for (const preview of doc.body.childNodes[0].querySelectorAll('.preview')) {
    assert.equal(preview.hasAttribute('data-cited-history'), false)
    assert.equal(shown(preview), true)
  }
  const citeBubbles = [...byId(doc, 'cite').querySelectorAll('.bt-ububble')].map(node => node.textContent)
  assert.deepEqual(citeBubbles, [WHO, FOLLOW])
  const visibleHistory = doc.querySelectorAll('[data-chat-flow-kind="user"]').filter(shown)
  assert.deepEqual(visibleHistory.map(node => node.getAttribute('id')), ['later-who'])
  assert.equal(doc.querySelectorAll('.bt-umsg').length, 0)
})

test('a control inside the cite bubble does not keep the history row', () => {
  const doc = reloadedPage()
  const bubble = byId(doc, 'cite').querySelectorAll('.bt-ububble')[0]
  append(bubble, 'Copy')
  hideCitedHostBubbles(doc)
  assert.equal(byId(doc, 'hist-who').getAttribute('data-cited-history'), '1')
  assert.equal(byId(doc, 'cite').hasAttribute('data-cited-history'), false)
  assert.equal(byId(doc, 'later-who').hasAttribute('data-cited-history'), false)
})

test('history stays when the page has no late cite', () => {
  const doc = reloadedPage()
  const cite = byId(doc, 'cite')
  cite.parentNode.childNodes = cite.parentNode.childNodes.filter(node => node !== cite)
  assert.equal(hideCitedHostBubbles(doc), 0)
  assert.equal(doc.querySelectorAll('[data-cited-history]').length, 0)
})

test('the cite cell on the page is what starts the hider', () => {
  const cells = readFileSync(join(root, 'vendor/ds-bot/src/client/cells.js'), 'utf8')
  const late = cells.slice(cells.indexOf('function LateCite'), cells.indexOf('function GroupEvent'))
  assert.match(late, /watchCitedHostBubbles\(/)
  const styles = readFileSync(join(root, 'vendor/ds-bot/src/client/styles.js'), 'utf8')
  assert.match(styles, /\[data-cited-history\]\{display:none!important\}/)
  const client = readFileSync(join(root, 'vendor/ds-bot/client.js'), 'utf8')
  assert.match(client, /data-cited-history/)
  assert.match(client, /data-cite-texts/)
})

function chromeBinary() {
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    if (spawnSync('which', [name], { encoding: 'utf8' }).status === 0) return name
  }
  return undefined
}

test('Chrome paints the reloaded page with the history rows hidden', async () => {
  const chrome = chromeBinary()
  if (chrome === undefined) return
  let esbuild
  try {
    esbuild = (await import('../../vendor/ds-bot/node_modules/esbuild/lib/main.js')).default
  } catch {
    return
  }
  const styles = readFileSync(join(root, 'vendor/ds-bot/src/client/styles.js'), 'utf8')
  const hideRule = styles.match(/\[data-cited-history\]\{display:none!important\}/)
  const flowRule = styles.match(/\[class\*="_flowItem"\]:has\(\[data-cited-history\]\)\{display:none!important\}/)
  assert.ok(hideRule)
  assert.ok(flowRule)
  const cite = lateCiteHtml([WHO, FOLLOW])
  const dir = mkdtempSync(join(tmpdir(), 'cite-render-'))
  await esbuild.build({
    entryPoints: [join(root, 'vendor/ds-bot/src/shared/cite.js')],
    bundle: true,
    format: 'iife',
    globalName: 'CiteHide',
    outfile: join(dir, 'cite-hide.js'),
    platform: 'browser',
    logLevel: 'silent',
  })
  const html = `<!doctype html>
<meta charset="utf-8">
<style>
${hideRule[0]}
${flowRule[0]}
</style>
<aside class="sidebar"><div class="preview">${WHO}</div><div class="preview">${FOLLOW}</div></aside>
<div data-conversation-scroll>
  <div id="hist-who" class="x_flowItem_a" data-chat-flow-kind="user"><div class="x_userRow_a"><div class="x_bubble_a"><p>${WHO}</p></div><div class="x_actions_a"><span class="x_timeStart_a">4:09 PM</span></div></div></div>
  <div id="hist-follow" class="x_flowItem_a" data-chat-flow-kind="user"><div class="x_userRow_a"><div class="x_bubble_a"><p>${FOLLOW}</p></div><div class="x_actions_a"><span class="x_timeStart_a">4:10 PM</span></div></div></div>
  <div id="hist-glued" class="x_flowItem_a" data-chat-flow-kind="user"><div class="x_userRow_a"><div class="x_bubble_a">${FOLLOW}4:11 PM</div></div></div>
  <div id="pending" class="x_userRow_a" data-pending-steering><div class="x_bubble_a"><p>${WHO}
未读</p></div></div>
  ${cite}
  <div class="essay">秋水正文</div>
  <div id="later-who" class="x_flowItem_a" data-chat-flow-kind="user"><div class="x_userRow_a"><div class="x_bubble_a"><p>${WHO}</p></div><div class="x_actions_a"><span class="x_timeStart_a">4:12 PM</span></div></div></div>
  <div id="dock" class="bt-route-dock" data-route-dock=""><div class="bt-route-text">${WHO}</div></div>
</div>
<script src="./cite-hide.js"></script>
<script>
CiteHide.hideCitedHostBubbles(document)
document.querySelector('[data-late-cite]').id = 'cite'
const display = (id) => getComputedStyle(document.getElementById(id)).display
document.documentElement.dataset.hist = display('hist-who')
document.documentElement.dataset.follow = display('hist-follow')
document.documentElement.dataset.glued = display('hist-glued')
document.documentElement.dataset.pending = display('pending')
document.documentElement.dataset.later = display('later-who')
document.documentElement.dataset.cite = display('cite')
document.documentElement.dataset.dock = display('dock')
document.documentElement.dataset.side = document.querySelector('.preview').textContent
</script>`
  writeFileSync(join(dir, 'page.html'), html)
  const dumped = spawnSync(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--virtual-time-budget=2000', '--timeout=3000', '--dump-dom', `file://${join(dir, 'page.html')}`,
  ], { encoding: 'utf8', timeout: 45_000 })
  assert.equal(dumped.status, 0, dumped.stderr)
  assert.match(dumped.stdout, /data-hist="none"/)
  assert.match(dumped.stdout, /data-follow="none"/)
  assert.match(dumped.stdout, /data-glued="none"/)
  assert.match(dumped.stdout, /data-pending="none"/)
  assert.match(dumped.stdout, /data-later="(?!none)/)
  assert.match(dumped.stdout, /data-cite="(?!none)/)
  assert.match(dumped.stdout, /data-dock="(?!none)/)
  assert.match(dumped.stdout, /data-side="你们是谁"/)
  assert.match(dumped.stdout, /id="cite"[\s\S]*你们是谁[\s\S]*在干嘛/)
})
