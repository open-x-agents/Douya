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
    body,
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

// One dock click fires pointerdown and then focus, and both open the dock. With the load flag only set
// after the paint, both would read and paint the same transcript twice.
test('two opens during the first read paint the transcript once', async () => {
  const { appended, run } = loader()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const load = run(async () => { await gate; return { ok: true, json: async () => payload } })
  const first = load()
  const second = load()
  release()
  await Promise.all([first, second])
  assert.deepEqual(appended.map(b => b.className), ['bubble me', 'bubble bot'])
})

// The session may not be hydrated yet when the page reloads, and that read answers with an empty list.
// Caching that answer is the original symptom: the dock stays blank for the rest of the page load.
test('an empty first read is read again on the next open instead of pinning a blank dock', async () => {
  const { appended, run } = loader()
  let reads = 0
  const emptyThenHistory = async () => {
    reads += 1
    return { ok: true, json: async () => (reads === 1 ? { messages: [] } : payload) }
  }
  const load = run(emptyThenHistory)
  await load()
  assert.equal(appended.length, 0)
  await load()
  assert.equal(reads, 2)
  assert.deepEqual(appended.map(b => b.className), ['bubble me', 'bubble bot'])
})

// The owner may send while the read is in flight: the live bubble is already the transcript, so the
// restored one must not be painted under it (that would show the prompt twice).
test('a live turn that starts during the read is not duplicated by history', async () => {
  const { appended, body, run } = loader()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const load = run(async () => { await gate; return { ok: true, json: async () => payload } })
  const read = load()
  body.appendChild({ className: 'bubble me' })
  release()
  await read
  assert.deepEqual(appended.map(b => b.className), ['bubble me'])
})
