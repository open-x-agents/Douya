import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
const from = html.indexOf('let inlineHistoryLoaded = false')
const to = html.indexOf('// ===== Multimodal composer')
assert.ok(from > 0 && to > from, 'inline history loader block found')

// Same slice as chat-dock-history.test.js: the page's loader body, bound to one closure so a second
// open of the dock reuses the same `inlineHistoryLoaded`.
function loader() {
  const appended = []
  const body = {
    childElementCount: 0,
    get scrollTop() { return 0 }, set scrollTop(_v) {},
    get scrollHeight() { return 0 },
    appendChild(el) { appended.push(el); this.childElementCount = appended.length; return el },
  }
  const makeEl = () => ({ className: '', innerHTML: '', appendChild() {} })
  const $ = () => body
  const src = html.slice(from, to)
  const factory = new Function('$', 'document', 'odmLang', 'odmHeaders', 'fillUserBubble', 'renderMd', 'chatTime', 'citesEl', 'renderSurface', 'dockPrompt', 'shapeReply', 'stickTodayChat', 'fetch', `${src}; return ensureInlineBotHistory`)
  return {
    appended,
    run: (fetchImpl) => factory(
      $, { createElement: makeEl }, () => 'zh', () => ({}),
      (el, text) => { el.innerHTML = String(text) },
      s => String(s), () => '00:00', () => null, () => makeEl(), () => {}, () => {}, () => {},
      fetchImpl,
    ),
  }
}

const payload = { messages: [{ role: 'user', content: '你是谁' }, { role: 'assistant', content: '我是 Chief。' }] }

test('a failed first history read is retried when the dock is opened again', async () => {
  const { appended, run } = loader()
  const failThenOk = (n => async () => { if (n-- > 0) throw new Error('offline'); return { ok: true, json: async () => payload } })(1)
  const load = run(failThenOk)
  await load()
  assert.equal(appended.length, 0)
  await load()
  assert.deepEqual(appended.map(b => b.className), ['bubble me', 'bubble bot'])
})
