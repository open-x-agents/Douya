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
  assert.match(ui.root.innerHTML, /<div class="future-kicker">Douya \/ Future<\/div>/)
  assert.doesNotMatch(ui.root.innerHTML, /<article/)
  ui.setLocale('zh')
  assert.match(ui.root.innerHTML, /你想慢慢培养什么/)
  assert.match(ui.root.innerHTML, /<div class="future-kicker">豆芽 \/ 未来<\/div>/)
  assert.doesNotMatch(ui.root.innerHTML, /Douya \/ Future/)
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

test('sidebar groups product pages before Sources and keeps Today selected', async () => {
  const html = await readFile(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
  const nav = [...html.matchAll(/<div class="nav(?: on)?" data-view="([^"]+)"/g)]
  assert.deepEqual(nav.map(match => match[1]), ['today', 'future', 'memory', 'sources', 'settings'])
  assert.match(nav[0][0], /class="nav on"/)
  assert.equal(nav.filter(match => match[0].includes('nav on')).length, 1)
})

test('next step offers Do this with Douya, seeds chat with plan/step context, and reports completion', async () => {
  const active = { id: 'p1', status: 'active', title: 'Become a steady maintainer', goal: 'Land real fixes', basis: { source: 'user', text: 'I want to ship OSS' }, steps: [{ id: 's1', text: 'Turn orbit #2116 review into a PR', done: false }] }
  let state = { ok: true, available: true, plans: [active] }
  const listeners = {}, calls = [], root = { innerHTML: '', addEventListener: (name, fn) => { listeners[name] = fn } }
  const window = { ODMi18n: { getLocale: () => 'en' }, addEventListener: () => {}, futureChat: (value, opts) => calls.push({ chat: value, opts }) }
  const fetch = async () => ({ ok: true, json: async () => structuredClone(state) })
  runInNewContext(source, { window, document: { getElementById: () => root }, fetch })
  await window.loadFuture()
  assert.match(root.innerHTML, /data-op="do"[^>]*>Do this with Douya/)
  assert.match(root.innerHTML, /data-op="schedule"/)
  const btn = op => ({ dataset: { op }, closest: sel => sel === '[data-step-id]' ? { dataset: { stepId: 's1' } } : { dataset: { plan: 'p1' } } })
  listeners.click({ target: { closest: () => btn('do') } })
  assert.equal(calls[0].opts.send, true)
  for (const bit of ['plan p1', 'step s1', 'Land real fixes', 'I want to ship OSS', 'orbit #2116', 'odm_future_get', 'confirm card']) assert.ok(calls[0].chat.includes(bit), bit)
  listeners.click({ target: { closest: () => btn('schedule') } })
  assert.match(calls[1].chat, /timetable/)
  // Douya marks it done from chat: the card shows proof, progress, a status line, and the new next step.
  state = { ok: true, available: true, plans: [{ ...active, steps: [{ ...active.steps[0], done: true, evidence: 'PR #12 opened' }, { id: 's2', text: 'Address review on PR #12', done: false }] }] }
  await window.loadFuture()
  assert.match(root.innerHTML, /future-evidence">✓ PR #12 opened/)
  assert.match(root.innerHTML, /1 \/ 2 steps complete/)
  assert.match(root.innerHTML, /Step done: Turn orbit #2116 review into a PR · PR #12 opened Up next: Address review on PR #12/)
  assert.match(root.innerHTML, /data-step-id="s2"/)
  assert.doesNotMatch(root.innerHTML, /data-step-id="s1"/)
})
