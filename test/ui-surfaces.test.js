// 豆芽 Intelligent UI P2: temporary views. Strict schema, store-resolved data (no invented links or numbers),
// forms that only produce 待你确认 drafts, and a renderer that never turns data into markup.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { validateSpec } from '../src/ui/validate.js'
import { hydrateSurface, resolveSubmitArgs, storeLinks } from '../src/ui/hydrate.js'
import { createSurfaceService } from '../src/ui/surfaces.js'
import { catalogPrompt, CATALOG } from '../src/ui/catalog.js'
import { ACTIONS } from '../src/web/actions.js'

// load the browser script exactly as a <script> would run it (no module system), then read what it exported
const rendererSandbox = { module: { exports: {} } }
vm.runInNewContext(readFileSync(new URL('../src/client/ui-renderer.js', import.meta.url), 'utf8'), rendererSandbox)
const { createRenderer } = rendererSandbox.module.exports
const DAY = '2026-11-04'
const NOW = Date.parse(`${DAY}T02:00:00Z`)
const FLEDGE = 'https://mail.google.com/mail/u/0/#inbox/19a1a3f2144f1d300'
const PR1 = 'https://github.com/ThinkFlowLab/FlyBot/pull/2320', PR2 = 'https://github.com/ThinkFlowLab/FlyBot/pull/2318'
function fixture() {
  return {
    cards: [
      { id: 'fly', type: 'project-cluster', source: 'github', sourceId: `github:cluster:ThinkFlowLab/FlyBot:${DAY}`, title: 'FlyBot gate and panel fixes', priority: 'high', status: 'active', url: 'https://github.com/ThinkFlowLab/FlyBot',
        blocks: [{ type: 'link-list', links: [{ title: 'gate: find main ruleset (PR #2320)', url: PR1, from: 'Day Dreamer', at: '2026-11-03T10:00:00Z' }, { title: 'Release v0.2.22 (PR #2318)', url: PR2, from: 'bot', at: '2026-11-03T12:00:00Z' }] }] },
      { id: 'fledge', type: 'email-action', source: 'gmail', sourceId: 'gmail:action:gmail:abc', title: '[Fledge] 团队需要你回答：Birfy/jitagent', priority: 'high', waiting: 'you', status: 'active',
        blocks: [{ type: 'link-list', links: [{ title: '[Fledge] 团队需要你回答', url: FLEDGE, from: 'Fledge <fledge@hugoxk.online>', at: '2026-11-04T00:30:00Z' }] }] },
      { id: 'promo', type: 'email-group', source: 'gmail', title: '促销与订阅', priority: 'low', waiting: 'fyi', status: 'active', blocks: [{ type: 'link-list', links: [{ title: 'Sale', url: 'https://mail.google.com/mail/u/0/#inbox/p1' }] }] },
    ],
    itemStatus: { [PR2]: { status: 'done' } },
    surfaces: {},
  }
}
const spec = (components, extra = {}) => ({ title: '测试视图', components, ...extra })
const ok = (input) => { const v = validateSpec(input, { actions: ACTIONS }); assert.equal(v.ok, true, `${v.path}: ${v.error}`); return v.spec }
const bad = (input, re) => { const v = validateSpec(input, { actions: ACTIONS }); assert.equal(v.ok, false, 'should be rejected'); if (re) assert.match(`${v.path} ${v.error}`, re); return v }
const hydrate = (s, state = fixture()) => hydrateSurface({ id: 'sf_t', spec: s, createdAt: new Date(NOW).toISOString() }, state, { now: NOW })

test('schema: whitelist of components and props, sizes, structure', () => {
  ok(spec([{ id: 'root', type: 'Column', children: ['t'] }, { id: 't', type: 'Table', source: { cards: 'needs-you', rows: 'items' }, columns: ['title', 'from', 'at'], sortable: true }]))
  bad(spec([{ id: 'x', type: 'Html', html: '<b>' }]), /不支持的组件/)
  bad(spec([{ id: 'x', type: 'Text', text: 'hi', html: '<b>hi</b>' }]), /不支持的字段「html」/)
  bad(spec([{ id: 'x', type: 'Text', text: 'hi', onclick: 'alert(1)' }]), /onclick/)
  bad(spec([{ id: 'x', type: 'Text', text: '<script>alert(1)</script>' }]), /HTML/)
  bad(spec([{ id: 'x', type: 'Text', text: '<img src=x onerror=alert(1)>' }]), /HTML/)
  bad(spec([{ id: 'x', type: 'Callout', text: 'click javascript:alert(1)' }]), /HTML|脚本/)
  bad(spec([{ id: 'x', type: 'Table', source: { cards: 'needs-you' }, columns: ['title', 'password'] }]), /字段「password」/)
  bad(spec([{ id: 'x', type: 'KeyValue', pairs: [{ label: 'PR 数', value: 157 }] }]), /数字不能自己写/)
  bad(spec([{ id: 'root', type: 'Column', children: ['a'] }, { id: 'a', type: 'Column', children: ['root'] }]), /两次或成环/)
  bad(spec([{ id: 'root', type: 'Column', children: ['ghost'] }]), /没有 id 为「ghost」/)
  const deep = [{ id: 'c0', type: 'Column', children: ['c1'] }, { id: 'c1', type: 'Column', children: ['c2'] }, { id: 'c2', type: 'Column', children: ['c3'] }, { id: 'c3', type: 'Column', children: ['c4'] }, { id: 'c4', type: 'Text', text: 'x' }]
  bad(spec(deep), /嵌套太深/)
  bad(spec(Array.from({ length: 61 }, (_, i) => ({ id: `t${i}`, type: 'Text', text: 'x' }))), /最多 60/)
  bad(spec([{ id: 'x', type: 'Text', text: 'y'.repeat(30000) }]), /太大|太长/)
  bad({ title: 'x', components: [{ id: 'x', type: 'Text', text: 'a' }], script: 'alert(1)' }, /不支持的字段「script」/)
  bad(spec('[not json'), /JSON/)
  ok({ title: 'json string', components: JSON.stringify([{ id: 'x', type: 'Text', text: 'a' }]) })
})

test('buttons can only open a link / card, run a view op or send a prompt — never confirm or send', () => {
  bad(spec([{ id: 'b', type: 'Buttons', buttons: [{ label: '确认执行', do: { confirm: 'act_1' } }] }]), /不能「confirm」/)
  bad(spec([{ id: 'b', type: 'Buttons', buttons: [{ label: '发出', do: { requestAction: 'gmail_send_email' } }] }]), /不能「requestAction」/)
  bad(spec([{ id: 'b', type: 'Buttons', buttons: [{ label: 'x', do: { openLink: 'javascript:alert(1)' } }] }]), /https|脚本|HTML/)
  bad(spec([{ id: 'b', type: 'Buttons', buttons: [{ label: 'x', do: { uiOp: { op: 'deleteAll' } } }] }]), /uiOp\.op/)
  bad(spec([{ id: 'b', type: 'Buttons', buttons: [{ label: 'x', do: { prompt: 'a', openCard: 'fly' } }] }]), /只能有一个/)
  ok(spec([{ id: 'b', type: 'Buttons', buttons: [{ label: '打开', do: { openCard: 'fly' } }, { label: '筛选', do: { uiOp: { op: 'filter', needsYou: true } } }, { label: '问问', do: { prompt: '怎么回？' } }] }]))
})

test('forms: draft only for confirm-risk actions, required args, real fields', () => {
  const fields = [{ name: 'ticket', kind: 'select', label: '工单', options: ['A', 'B'] }, { name: 'body', kind: 'textarea', label: '正文' }]
  bad(spec([{ id: 'f', type: 'Form', fields, submit: { label: '归档', do: { draft: { action: 'gmail_archive', args: { url: FLEDGE } } } } }]), /只能生成需要用户确认/)
  bad(spec([{ id: 'f', type: 'Form', fields, submit: { label: '回', do: { draft: { action: 'gmail_reply', args: { body: { $field: 'body' } } } } } }]), /thread_id.*必填/)
  bad(spec([{ id: 'f', type: 'Form', fields, submit: { label: '回', do: { draft: { action: 'gmail_reply', args: { thread_id: 'x', recipient_email: 'a@b.c', body: '{{nope}}' } } } } }]), /\{\{nope\}\} 不是表单字段/)
  bad(spec([{ id: 'f', type: 'Form', fields, submit: { label: '回', do: { execute: 'x' } } }]), /prompt 或 draft/)
  bad(spec([{ id: 'f', type: 'Form', fields: [{ name: 'x', kind: 'file', label: 'f' }], submit: { label: 'a', do: { prompt: 'x' } } }]), /text \| textarea/)
  ok(spec([{ id: 'f', type: 'Form', fields, submit: { label: '生成待确认', do: { draft: { action: 'gmail_reply', args: { thread_id: { $item: { card: 'fledge', item: FLEDGE }, field: 'threadId' }, recipient_email: { $item: { card: 'fledge', item: FLEDGE }, field: 'from' }, body: '选 {{ticket}}。\n{{body}}' } } } } }]))
})

test('hydrate: rows, links and numbers come from the store; fake references are rejected', () => {
  const t = hydrate(ok(spec([{ id: 'root', type: 'Column', children: ['t', 'kv', 'ch'] },
    { id: 't', type: 'Table', source: { cards: 'needs-you', rows: 'items' }, columns: ['title', 'from', 'cardTitle'], rowActions: [{ label: '打开卡', do: { openCard: '$row.cardId' } }] },
    { id: 'kv', type: 'KeyValue', pairs: [{ label: '需要你处理', value: { $count: { cards: 'needs-you', rows: 'cards' } } }, { label: 'FlyBot 下一步', value: { $card: { card: 'fly', field: 'title' } } }] },
    { id: 'ch', type: 'Chart', kind: 'bar', source: { card: 'fly' }, groupBy: 'status' }])))
  assert.equal(t.ok, true, t.error)
  const rows = t.view.components.t.rows
  assert.deepEqual(rows.map(r => r.url), [FLEDGE])
  assert.equal(rows[0].cells.from, 'Fledge <fledge@hugoxk.online>')
  assert.deepEqual(rows[0].actions[0].do, { openCard: 'fledge' })
  assert.equal(t.view.components.kv.pairs[0].value, '1')
  assert.deepEqual(t.view.components.ch.data.map(d => [d.label, d.value]).sort(), [['已完成', 1], ['待处理', 1]])
  assert.deepEqual(t.view.refs.map(r => r.id).sort(), ['fledge', 'fly'])
  // comparison of FlyBot's PRs: one column per item, statuses from itemStatus
  const c = hydrate(ok(spec([{ id: 'c', type: 'Comparison', source: { card: 'fly', where: { type: 'pr' } }, fields: ['from', 'at', 'status', 'note'], annotations: { [PR1]: '先审这个' } }])))
  assert.deepEqual(c.view.components.c.rows.map(r => [r.url, r.cells.status, r.cells.note]), [[PR1, '待处理', '先审这个'], [PR2, '已完成', '']])
  // fake link / unknown card / annotation on a row that isn't there
  const fake = hydrate(ok(spec([{ id: 'b', type: 'Buttons', buttons: [{ label: '看看', do: { openLink: 'https://github.com/evil/phish/pull/1' } }] }])))
  assert.equal(fake.ok, false); assert.match(fake.error, /卡片里已有的条目链接/)
  const ghost = hydrate(ok(spec([{ id: 't', type: 'Table', source: { card: 'FlyBot' }, columns: ['title'] }])))
  assert.equal(ghost.ok, false); assert.match(ghost.error, /可能是：fly/)
  const ann = hydrate(ok(spec([{ id: 't', type: 'Table', source: { card: 'fly' }, columns: ['title', 'note'], annotations: { 'https://evil.example/x': 'x' } }])))
  assert.equal(ann.ok, false); assert.match(ann.error, /不是这个 source 里的行/)
  const draftFake = hydrate(ok(spec([{ id: 'f', type: 'Form', fields: [{ name: 'b', kind: 'text', label: 'b' }], submit: { label: 'x', do: { draft: { action: 'github_comment', args: { url: 'https://github.com/evil/x/pull/9', body: '{{b}}' } } } } }])))
  assert.equal(draftFake.ok, false); assert.match(draftFake.error, /链接必须是卡片里已有的/)
  assert.ok(storeLinks(fixture()).has(PR1))
})

test('dataModel: $data refs, numbers refused, patch with null deletes', async () => {
  const state = fixture()
  const events = []
  const store = { get: () => state, save: async n => Object.assign(state, n) }
  const svc = createSurfaceService({ store, actions: ACTIONS, emit: e => events.push(e), now: () => NOW })
  const r = await svc.render(spec([{ id: 'root', type: 'Column', children: ['x', 'f'] }, { id: 'x', type: 'Text', text: { $data: 'note' } },
    { id: 'f', type: 'Form', fields: [{ name: 'body', kind: 'textarea', label: '正文', value: { $data: 'draft' } }], submit: { label: '发给豆芽', do: { prompt: '帮我润色：{{body}}' } } }], { dataModel: JSON.stringify({ note: '草稿 v1', draft: '你好' }) }))
  assert.equal(r.success, true, r.error)
  assert.equal(events[0].kind, 'surface')
  assert.equal(events[0].view.components.x.text, '草稿 v1')
  assert.equal(svc.since(NOW - 1).length, 1)
  const u = await svc.update({ surfaceId: r.surfaceId, dataModel: '{"note":"草稿 v2","draft":null}' })
  assert.equal(u.success, true)
  const g = svc.get(r.surfaceId)
  assert.equal(g.view.components.x.text, '草稿 v2')
  assert.equal(g.view.components.f.fields[0].value, '')
  assert.equal(events.at(-1).phase, 'update')
  assert.equal((await svc.update({ surfaceId: r.surfaceId, dataModel: '{"n": 3}' })).success, false)
  assert.equal((await svc.update({ surfaceId: r.surfaceId, dataModel: '{"x":"<script>alert(1)</script>"}' })).success, false)
  assert.equal((await svc.update({ surfaceId: 'sf_nope', dataModel: '{}' })).success, false)
  const p = await svc.submit({ surfaceId: r.surfaceId, component: 'f', values: { body: '下周三前给结论' } })
  assert.deepEqual(p, { success: true, kind: 'prompt', text: '帮我润色：下周三前给结论' })
})

test('form submit → only a pending 待你确认 draft, with args resolved from the store', async () => {
  const state = fixture()
  const store = { get: () => state, save: async n => Object.assign(state, n) }
  const calls = []
  const requestAction = async (name, input) => { calls.push({ name, input }); return { success: true, pending: true, actionId: 'act_test', summary: 's' } }
  const svc = createSurfaceService({ store, actions: ACTIONS, requestAction, now: () => NOW })
  const r = await svc.render(spec([{ id: 'f', type: 'Form', fields: [{ name: 'ticket', kind: 'select', label: '工单', options: [{ label: 'Birfy/jitagent #12', value: 'jitagent#12' }, { label: 'Birfy/jitagent #13', value: 'jitagent#13' }], required: true }, { name: 'body', kind: 'textarea', label: '正文', value: '你好' }],
    submit: { label: '生成待确认', do: { draft: { action: 'gmail_reply', args: { thread_id: { $item: { card: 'fledge', item: FLEDGE }, field: 'threadId' }, recipient_email: { $item: { card: 'fledge', item: FLEDGE }, field: 'from' }, body: '下一个做 {{ticket}}。\n{{body}}' } } } } }]), { cardId: 'fledge' })
  assert.equal(r.success, true, r.error)
  assert.equal((await svc.submit({ surfaceId: r.surfaceId, component: 'f', values: { ticket: 'evil', body: 'x' } })).success, false, 'select must be one of the options')
  assert.equal((await svc.submit({ surfaceId: r.surfaceId, component: 'f', values: { body: 'x' } })).success, false, 'required')
  const s = await svc.submit({ surfaceId: r.surfaceId, component: 'f', values: { ticket: 'jitagent#13', body: '谢谢' } })
  assert.deepEqual(s, { success: true, kind: 'draft', actionId: 'act_test', summary: 's' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'gmail_reply')
  assert.equal(ACTIONS[calls[0].name].risk, 'confirm')
  assert.equal(calls[0].input.thread_id, '19a1a3f2144f1d300')
  assert.equal(calls[0].input.recipient_email, 'fledge@hugoxk.online')
  assert.equal(calls[0].input.body, '下一个做 jitagent#13。\n谢谢')
  assert.equal(calls[0].input.cardId, 'fledge')
  // a draft with a direct action can never be stored, even bypassing validation
  state.surfaces[r.surfaceId].spec.components.f.submit.do.draft.action = 'gmail_archive'
  assert.equal((await svc.submit({ surfaceId: r.surfaceId, component: 'f', values: { ticket: 'jitagent#13' } })).success, false)
  assert.equal(calls.length, 1)
})

test('保存为卡片: a type=view card without sourceId, re-hydrated from the store; idempotent', async () => {
  const state = fixture()
  const store = { get: () => state, save: async n => { if (n.cards) state.cards = [...state.cards, ...n.cards.filter(c => !state.cards.some(x => x.id === c.id))]; Object.assign(state, { ...n, cards: state.cards }) } }
  const svc = createSurfaceService({ store, actions: ACTIONS, now: () => NOW })
  const r = await svc.render(spec([{ id: 't', type: 'Table', source: { cards: 'needs-you', rows: 'items' }, columns: ['title', 'from'] }]))
  const a = await svc.saveAsCard(r.surfaceId)
  assert.equal(a.success, true)
  const card = state.cards.find(c => c.id === a.cardId)
  assert.equal(card.type, 'view'); assert.equal(card.source, 'bot'); assert.equal(card.sourceId, undefined)
  assert.equal((await svc.saveAsCard(r.surfaceId)).already, true)
  assert.equal(state.cards.filter(c => c.type === 'view').length, 1)
  assert.equal(svc.cardView(card).components.t.rows[0].url, FLEDGE)
  assert.equal(state.surfaces[r.surfaceId].expiresAt, null)
})

// ---- renderer XSS / injection: a tiny DOM whose innerHTML throws and that records every attribute -------------
function fakeDoc() {
  const all = []
  class El {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this._t = ''; this.style = {}; this.listeners = {}; this.className = ''; all.push(this)
      const self = this; this.classList = { add: c => { self.className += ` ${c}` }, remove() {}, toggle() {}, contains: () => false } }
    set textContent(v) { this._t = String(v); this.children = [] }
    get textContent() { return this._t + this.children.map(c => c.textContent).join('') }
    set innerHTML(_) { throw new Error('innerHTML must never be used') }
    set outerHTML(_) { throw new Error('outerHTML must never be used') }
    insertAdjacentHTML() { throw new Error('insertAdjacentHTML must never be used') }
    appendChild(c) { this.children.push(c); return c }
    append(...cs) { cs.forEach(c => this.appendChild(c)) }
    removeChild(c) { this.children = this.children.filter(x => x !== c) }
    get firstChild() { return this.children[0] || null }
    setAttribute(k, v) { if (/^on/i.test(k)) throw new Error(`event attribute ${k}`); this.attrs[k] = String(v) }
    removeAttribute(k) { delete this.attrs[k] }
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f) }
  }
  return { all, createElement: t => new El(t), createElementNS: (_, t) => new El(t) }
}
const EVIL = '<img src=x onerror=alert(1)><script>alert(2)</script>'
const evilView = () => ({
  id: 'sf_evil" onmouseover="alert(1)', title: EVIL, root: 'root', generatedBy: '豆芽生成', refs: [{ id: 'fly', title: EVIL }],
  components: {
    root: { type: 'Column', children: ['t', 'c', 'kv', 'tl', 'ch', 'f', 'b', 'x', 'ghost'] },
    t: { type: 'Table', sortable: true, columns: [{ key: 'title', label: EVIL }, { key: 'from', label: 'from' }], rows: [
      { key: 'a', url: 'javascript:alert(1)', cells: { title: EVIL, from: EVIL }, sort: {}, actions: [{ label: EVIL, do: { confirm: 'act_1' } }] },
      { key: 'b', url: 'https://evil.example/phish', cells: { title: 'phish', from: '' }, sort: {}, actions: [] },
      { key: 'c', url: 'https://github.com/o/r/pull/1', cells: { title: 'ok', from: '' }, sort: {}, actions: [] }] },
    c: { type: 'Comparison', columns: [{ key: 'from', label: EVIL }], rows: [{ key: 'a', url: 'data:text/html,<script>alert(1)</script>', title: EVIL, cells: { from: EVIL } }] },
    kv: { type: 'KeyValue', pairs: [{ label: EVIL, value: EVIL }] },
    tl: { type: 'Timeline', rows: [{ at: EVIL, title: EVIL, url: 'vbscript:x' }] },
    ch: { type: 'Chart', kind: 'line', data: [{ label: EVIL, value: 1 }, { label: 'b', value: '2"/><script>' }, { label: 'c', value: 3 }] },
    f: { type: 'Form', fields: [{ name: 'a" onfocus="x', kind: 'select', label: EVIL, options: [{ label: EVIL, value: EVIL }] }], submit: { label: EVIL, kind: 'draft' } },
    b: { type: 'Buttons', buttons: [{ label: EVIL, do: { openLink: 'javascript:alert(1)' } }, { label: 'send', do: { send: true } }] },
    x: { type: 'Iframe', src: 'https://evil.example' },
  },
})
test('renderer: data never becomes markup, unsafe links are plain text, unknown components render nothing', () => {
  const doc = fakeDoc()
  const { render } = createRenderer(doc)
  const calls = []
  const h = { openLink: u => calls.push(['link', u]), openCard: id => calls.push(['card', id]), uiOp: o => calls.push(['op', o]), prompt: t => calls.push(['prompt', t]), submit: async () => ({ ok: true }) }
  const box = render(evilView(), h, { placement: 'chat', onSave() {}, onPanel() {} })
  assert.ok(box.textContent.includes(EVIL), 'malicious strings are shown literally')
  for (const e of doc.all) {
    assert.ok(!['SCRIPT', 'IMG', 'IFRAME', 'OBJECT', 'EMBED', 'STYLE'].includes(e.tagName), `no ${e.tagName}`)
    for (const k of Object.keys(e.attrs)) assert.doesNotMatch(k, /^on/i)
    if (e.href !== undefined) assert.match(e.href, /^https:\/\/([a-z0-9-]+\.)*(github\.com|google\.com|slack\.com)\//, `unsafe href ${e.href}`)
  }
  const anchors = doc.all.filter(e => e.tagName === 'A')
  assert.deepEqual(anchors.map(a => a.href), ['https://github.com/o/r/pull/1'])
  assert.ok(anchors.every(a => a.rel === 'noopener noreferrer' && a.target === '_blank'))
  const poly = doc.all.find(e => e.tagName === 'POLYLINE')
  assert.match(poly.attrs.points, /^[\d., ]+$/, 'chart points are numbers only')
  // buttons: confirm / send / javascript: do nothing
  for (const e of doc.all.filter(x => x.tagName === 'BUTTON')) for (const f of e.listeners.click || []) f({ stopPropagation() {} })
  assert.ok(calls.every(([k]) => ['link', 'card', 'op', 'prompt'].includes(k)))
  assert.ok(!calls.some(([k, v]) => k === 'link' && !/^https:\/\/github\.com/.test(v)))
})
test('renderer + host code: no HTML sinks anywhere in the view path', () => {
  const r = readFileSync(new URL('../src/client/ui-renderer.js', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(r, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|setAttribute\(\s*['"`]on/)
  const html = readFileSync(new URL('../src/client/index.html', import.meta.url), 'utf8')
  const p2 = html.slice(html.indexOf('Intelligent UI (P2)'), html.indexOf('// Tile zoom modal functions'))
  assert.ok(p2.length > 1000)
  assert.doesNotMatch(p2, /innerHTML|insertAdjacentHTML|确认执行/)
  assert.ok(html.includes('<script src="/api/opendigitalmate/ui-renderer.js"></script>'))
})

test('catalog prompt is generated from the catalog; routes + tools are wired', () => {
  const p = catalogPrompt()
  for (const k of Object.keys(CATALOG)) assert.ok(p.includes(`- ${k}：`), k)
  assert.ok(p.length < 3000, 'kept short (sent every turn)')
  const routes = readFileSync(new URL('../src/web/dsh-host-routes.js', import.meta.url), 'utf8')
  assert.ok(routes.includes("'/api/opendigitalmate/surface'") && routes.includes("'/api/opendigitalmate/ui-renderer.js'"))
  assert.match(routes, /surfacesSince\(timing\.recvAt\)/)
  const tools = readFileSync(new URL('../src/web/dsbot-tools.js', import.meta.url), 'utf8')
  assert.ok(tools.includes("name: 'odm_ui_render'") && tools.includes("name: 'odm_ui_update'"))
  assert.equal(resolveSubmitArgs({ a: 'x{{b}}y' }, { b: '1' }, fixture()).a, 'x1y')
})
