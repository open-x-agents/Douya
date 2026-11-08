import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFutureService } from '../src/web/future-plans.js'
import { createStore } from '../src/host/store.js'
import { readIndexHtml } from '../packages/dsh-muse-ui/static-serve.js'
import { validateUiOp } from '../src/ui/ops.js'

const memory = { id: 'viking://~/memories/preferences/study.md', text: 'I want to learn Mandarin by reading a little each week.', tags: ['preference'] }
const proposed = { op: 'propose', title: 'Read Mandarin', goal: 'Read a short story comfortably', step: 'Choose one short story and read its first paragraph this week.', memoryId: memory.id }
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'odm-future-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'state.json'), store = createStore(path)
  await store.load()
  const events = []
  const service = createFutureService({ store, memories: async () => ({ available: true, memories: [memory] }), emit: e => events.push(e), ...options })
  return { service, store, path, events }
}

test('empty Future asks for interests; no generated plans', async t => {
  const { service } = await fixture(t)
  const result = await service.get()
  assert.deepEqual(result.plans, [])
  assert.equal(result.interests[0].text, memory.text)
})
test('proposal uses real evidence verbatim and stays inactive', async t => {
  const { service, events } = await fixture(t)
  const result = await service.apply({ ...proposed, why: 'Invented fitness preference' })
  assert.equal(result.ok, true)
  assert.equal(result.plan.status, 'proposed')
  assert.equal(result.plan.basis.text, memory.text)
  assert.equal(result.plan.steps[0].done, false)
  assert.equal(events[0].kind, 'future')
})
test('cannot invent memory or leave evidence blank', async t => {
  const { service } = await fixture(t)
  assert.equal((await service.apply({ ...proposed, memoryId: 'nonexistent' })).ok, false)
  assert.equal((await service.apply({ ...proposed, memoryId: undefined })).ok, false)
  assert.equal((await service.get()).plans.length, 0)
})
test('requires useful goal and weekly step', async t => {
  const { service } = await fixture(t)
  for (const key of ['title', 'goal', 'step']) assert.equal((await service.apply({ ...proposed, [key]: '  ' })).ok, false)
})
test('direct create and Chief accept require agreement', async t => {
  const { service } = await fixture(t)
  assert.equal((await service.apply({ ...proposed, op: 'create' })).ok, false)
  const { plan } = await service.apply(proposed)
  assert.equal((await service.apply({ op: 'accept', id: plan.id })).ok, false)
  const accepted = await service.apply({ op: 'accept', id: plan.id, userAgreed: true })
  assert.equal(accepted.plan.status, 'active')
  assert.ok(accepted.plan.acceptedAt)
})
test('page Accept is consent; proposed steps cannot be checked', async t => {
  const { service } = await fixture(t)
  const { plan } = await service.apply(proposed)
  assert.equal((await service.apply({ op: 'step', id: plan.id, stepId: plan.steps[0].id })).ok, false)
  assert.equal((await service.apply({ op: 'accept', id: plan.id }, { by: 'user' })).plan.status, 'active')
})
test('page cannot impersonate Chief to create or edit', async t => {
  const { service } = await fixture(t)
  assert.equal((await service.apply({ ...proposed, op: 'create', userAgreed: true }, { by: 'user' })).ok, false)
  assert.equal((await service.apply({ ...proposed }, { by: 'user' })).ok, false)
})
test('explicit chat interest works without OpenViking', async t => {
  const { service } = await fixture(t, { memories: async () => { throw Error('offline') } })
  assert.equal((await service.get()).available, false)
  const result = await service.apply({ ...proposed, memoryId: undefined, interestQuote: 'I want to read Mandarin.' })
  assert.equal(result.plan.basis.source, 'user')
  assert.equal((await service.apply(proposed)).ok, false)
})
test('check, undo, append, archive preserve progress and immutable evidence', async t => {
  const { service } = await fixture(t)
  const { plan } = await service.apply({ ...proposed, op: 'create', userAgreed: true })
  const input = { op: 'step', id: plan.id, stepId: plan.steps[0].id }
  assert.equal((await service.apply(input)).plan.steps[0].done, true)
  assert.equal((await service.apply({ ...input, done: false })).plan.steps[0].done, false)
  await service.apply(input)
  const updated = await service.apply({ op: 'update', id: plan.id, step: 'Read a second paragraph.', basis: { text: 'fake' } })
  assert.equal(updated.plan.steps.length, 2)
  assert.equal(updated.plan.steps[0].done, true)
  assert.equal(updated.plan.basis.text, memory.text)
  const edited = await service.apply({ op: 'update', id: plan.id, stepId: updated.plan.steps[1].id, step: 'Read two sentences instead.' })
  assert.equal(edited.plan.steps.length, 2)
  assert.equal(edited.plan.steps[1].text, 'Read two sentences instead.')
  assert.equal(edited.plan.steps[0].done, true)
  assert.equal((await service.apply({ op: 'archive', id: plan.id })).plan.status, 'archived')
  assert.equal((await service.apply(input)).ok, false)
})
test('plans persist across restart and digest replacement', async t => {
  const { service, store, path } = await fixture(t)
  const staleDigestState = structuredClone(store.get())
  const { plan } = await service.apply({ ...proposed, op: 'create', userAgreed: true })
  await service.apply({ op: 'step', id: plan.id, stepId: plan.steps[0].id })
  await store.save({ ...staleDigestState, cards: [] }, { digest: true })
  const restarted = createStore(path); await restarted.load()
  assert.equal(restarted.get().futurePlans[0].steps[0].done, true)
})
test('concurrent updates serialize without losing a checked step', async t => {
  const { service } = await fixture(t)
  const { plan } = await service.apply({ ...proposed, op: 'create', userAgreed: true })
  await Promise.all([service.apply({ op: 'step', id: plan.id, stepId: plan.steps[0].id }), service.apply({ op: 'update', id: plan.id, step: 'Next paragraph' })])
  const result = await service.get()
  assert.equal(result.plans[0].steps.length, 2)
  assert.equal(result.plans[0].steps[0].done, true)
})
test('invalid id, step and op have visible errors, never silently succeed', async t => {
  const { service } = await fixture(t)
  assert.equal((await service.apply({ op: 'step', id: 'missing' })).ok, false)
  const { plan } = await service.apply({ ...proposed, op: 'create', userAgreed: true })
  assert.equal((await service.apply({ op: 'step', id: plan.id, stepId: 'missing' })).ok, false)
  assert.equal((await service.apply({ op: 'nonsense', id: plan.id })).ok, false)
})
test('served Muse app includes separate Future UI, escaped content and localized chrome', async () => {
  const html = await readIndexHtml()
  assert.match(html, /id="v-future"/)
  assert.match(html, /data-view="future"/)
  assert.match(html, /window.loadFuture = load/)
  assert.match(html, /esc\(p.goal\)/)
  assert.match(html, /esc\(p.basis\?\.text\)/)
  assert.match(html, /离想成为的自己/)
  assert.match(html, /role="status" aria-live="polite"/)
})

test('Chief can navigate to Future by key or ZH name', () => {
  assert.equal(validateUiOp({ op: 'navigate', page: 'future' }, {}).op.page, 'future')
  assert.equal(validateUiOp({ op: 'navigate', page: '未来' }, {}).op.page, 'future')
})

test('unrelated full-state writes cannot rewind Future progress', async t => {
  const { service, store } = await fixture(t)
  const { plan } = await service.apply({ ...proposed, op: 'create', userAgreed: true })
  const stale = structuredClone(store.get())
  await service.apply({ op: 'step', id: plan.id, stepId: plan.steps[0].id })
  await store.save({ ...stale, prefs: { autoLayout: 'off' } })
  assert.equal(store.get().futurePlans[0].steps[0].done, true)
})

test('dsh host Future route reads plans and only accepts browser-safe operations', async t => {
  const { registerMuseHostRoutes } = await import('../src/web/dsh-host-routes.js')
  const { service } = await fixture(t)
  const routes = new Map()
  registerMuseHostRoutes({ effect: fn => fn(), connection: { fetch: { register: route => routes.set(route.path, route) } } }, { router: { futureGet: () => service.get(), futureApply: (input, opts) => service.apply(input, opts) } })
  const route = routes.get('/api/opendigitalmate/future')
  const get = await route.fetch(new Request('http://local/api/opendigitalmate/future'))
  assert.deepEqual((await get.json()).plans, [])
  const { plan } = await service.apply(proposed)
  const post = body => route.fetch(new Request('http://local/api/opendigitalmate/future', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).then(r => r.json())
  assert.equal((await post({ ...proposed, op: 'create', userAgreed: true })).ok, false)
  assert.equal((await post({ op: 'accept', id: plan.id })).plan.status, 'active')
})
test('creating a goal that is already proposed activates it instead of adding a twin', async t => {
  const { service } = await fixture(t)
  const first = await service.apply(proposed)
  const created = await service.apply({ ...proposed, op: 'create', userAgreed: true, title: ' read  mandarin ' })
  assert.equal(created.ok, true)
  assert.equal(created.plan.id, first.plan.id)
  assert.equal(created.plan.status, 'active')
  const { plans } = service.snapshot()
  assert.equal(plans.length, 1)
  const again = await service.apply(proposed)
  assert.equal(again.ok, false)
  assert.match(again.error, /already exists/)
})
