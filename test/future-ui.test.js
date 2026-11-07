// Run the standalone Future UI module in a tiny DOM harness, without a browser dependency.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
const source = await readFile(new URL('../packages/dsh-muse-ui/static/future.js', import.meta.url), 'utf8')
function mount(state, { fail = false } = {}) {
  const listeners = {}, events = {}, calls = [], root = { innerHTML: '', addEventListener: (name, fn) => { listeners[name] = fn } }
  let locale = 'en'
  const window = { ODMi18n: { getLocale: () => locale }, addEventListener: (name, fn) => { events[name] = fn }, futureChat: value => calls.push({ chat: value }) }
  const fetch = async (url, options) => {
    if (fail) throw Error('network')
    if (options?.method === 'POST') {
      const input = JSON.parse(options.body); calls.push(input)
      const p = state.plans.find(p => p.id === input.id)
      if (input.op === 'accept') p.status = 'active'
      if (input.op === 'archive') p.status = 'archived'
      if (input.op === 'step') p.steps.find(s => s.id === input.stepId).done = input.done
      return { ok: true, json: async () => ({ ok: true, plan: p }) }
    }
    return { ok: true, json: async () => state }
  }
  runInNewContext(source, { window, document: { getElementById: () => root }, fetch })
  function click(op, id) {
    const btn = { dataset: { op }, closest: () => id ? { dataset: { plan: id } } : null }
    listeners.click({ target: { closest: () => btn } })
  }
  return { root, window, calls, click, listeners, setLocale: l => { locale = l; events['odm:locale']() } }
}
const plan = () => ({ id: 'p', status: 'proposed', title: '<img src=x onerror=alert(1)>', goal: 'Read & learn', basis: { source: 'user', text: 'I like <Mandarin>' }, steps: [{ id: 's', text: 'Read a paragraph', done: false }] })
const flush = () => new Promise(resolve => setImmediate(resolve))

test('empty state is friendly, bilingual, and does not invent plans', async () => {
  const ui = mount({ ok: true, available: true, plans: [] })
  await ui.window.loadFuture()
  assert.match(ui.root.innerHTML, /What would you like to grow/)
  assert.doesNotMatch(ui.root.innerHTML, /<article/)
  ui.setLocale('zh')
  assert.match(ui.root.innerHTML, /你想慢慢培养什么/)
  ui.click('ask')
  assert.match(ui.calls[0].chat, /真实兴趣/)
})
test('plan text is escaped, proposal cannot check steps, Accept enables progress', async () => {
  const ui = mount({ ok: true, available: true, plans: [plan()] })
  await ui.window.loadFuture()
  assert.match(ui.root.innerHTML, /&lt;img src=x/)
  assert.doesNotMatch(ui.root.innerHTML, /<img src=x/)
  assert.match(ui.root.innerHTML, /data-step="s"[^>]+disabled/)
  assert.match(ui.root.innerHTML, /data-op="accept"/)
  ui.click('accept', 'p'); await flush()
  assert.deepEqual(ui.calls[0], { op: 'accept', id: 'p' })
  assert.match(ui.root.innerHTML, /Plan accepted/)
  assert.doesNotMatch(ui.root.innerHTML, /data-step="s"[^>]+disabled/)
  ui.listeners.change({ target: { closest: () => ({ dataset: { step: 's' }, checked: true, closest: () => ({ dataset: { plan: 'p' } }) }) } })
  await flush()
  assert.match(ui.root.innerHTML, /100%/)
  assert.match(ui.root.innerHTML, /small step forward/)
  ui.click('archive', 'p'); await flush()
  assert.match(ui.root.innerHTML, /<details/)
  assert.match(ui.root.innerHTML, /Archived plans/)
})
test('unavailable memories do not hide plans and refresh failures show feedback', async () => {
  const ui = mount({ ok: true, available: false, plans: [plan()] })
  await ui.window.loadFuture()
  assert.match(ui.root.innerHTML, /Memories are unavailable/)
  assert.match(ui.root.innerHTML, /Read &amp; learn/)
  const broken = mount(null, { fail: true })
  await broken.window.loadFuture()
  assert.match(broken.root.innerHTML, /Could not load or save/)
  assert.match(broken.root.innerHTML, /data-op="refresh"/)
})
