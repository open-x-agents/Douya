import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
const from = html.indexOf('let inlineHistoryLoaded = false')
const to = html.indexOf('// ===== Multimodal composer')
assert.ok(from > 0 && to > from, 'inline history loader block found')

// The dock loader is a slice of the page's own script: run exactly that slice with the page's helpers faked.
function loadBubbles({ fetchImpl }) {
  const appended = []
  const body = {
    childElementCount: 0,
    get scrollTop() { return 0 }, set scrollTop(_v) {},
    get scrollHeight() { return 0 },
    appendChild(el) { appended.push(el); this.childElementCount = appended.length; return el },
  }
  const makeEl = () => ({ className: '', innerHTML: '', appendChild() {} })
  const doc = { createElement: makeEl }
  const $ = () => body
  const src = html.slice(from, to)
  const factory = new Function('$', 'document', 'odmLang', 'odmHeaders', 'fillUserBubble', 'renderMd', 'chatTime', 'citesEl', 'renderSurface', 'dockPrompt', 'shapeReply', 'stickTodayChat', 'fetch', `${src}; return ensureInlineBotHistory`)
  const fn = factory(
    $, doc, () => 'zh', () => ({}),
    (el, text) => { el.innerHTML = String(text) },
    s => String(s), () => '00:00', () => null, () => makeEl(), () => {}, () => {}, () => {},
    fetchImpl,
  )
  return { fn, appended }
}

test('the dock paints the restored transcript', async () => {
  const payload = { sessionId: 'dsbot-chief', messages: [
    { role: 'user', content: '你是谁', at: '2026-11-04T01:31:22.000Z' },
    { role: 'assistant', content: '我是 Chief。', at: '2026-11-04T01:31:25.000Z' },
    { role: 'user', content: '在干嘛', at: '2026-11-04T01:31:24.000Z' },
    { role: 'assistant', content: '待命中。', at: '2026-11-04T01:31:29.000Z' },
  ] }
  const { fn, appended } = loadBubbles({ fetchImpl: async () => ({ ok: true, json: async () => payload }) })
  await fn()
  assert.deepEqual(appended.map(b => b.className), ['bubble me', 'bubble bot', 'bubble me', 'bubble bot'])
  assert.match(appended[0].innerHTML, /你是谁/)
  assert.match(appended[3].innerHTML, /待命中/)
})
