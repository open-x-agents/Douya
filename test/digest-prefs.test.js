// Issue #115: standing digest preferences — a 20-entry cap, in-place edit, clear-all, and the HTTP
// surface the Settings card drives. The store is digest.json; every reply carries the fresh list.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_PREFS, createDigestStore } from '../src/digest/runner.js'
import { createApiRouter } from '../src/web/api.js'
import { createConfigStore } from '../src/web/config-store.js'
import { registerMuseHostRoutes } from '../src/web/dsh-host-routes.js'

const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
const routes = readFileSync(new URL('../src/web/dsh-host-routes.js', import.meta.url), 'utf8')

const freshHome = () => mkdtempSync(join(tmpdir(), 'odm-dp-'))

/** Register the dsh host routes against a fake connection so one request can go through the real handler. */
function captureRoutes(router) {
  const specs = new Map()
  const ctx = {
    connection: { fetch: { register: spec => { specs.set(spec.path, spec); return () => {} } } },
    effect: fn => { fn(); return () => {} },
  }
  const ok = registerMuseHostRoutes(ctx, { router, dshHome: freshHome(), log: () => {} })
  return { ok, specs }
}

// Same ctx shape test/dsh-routes-config.test.js builds: an inject-only-free plugin ctx plus a real config store.
async function makeRouter({ botDigest = true } = {}) {
  const home = freshHome()
  writeFileSync(join(home, 'config.json'), JSON.stringify({}))
  const configStore = createConfigStore(join(home, 'config.json'))
  await configStore.load()
  const state = { cards: [], completions: [] }
  const store = { get: () => state, save: async s => Object.assign(state, s), load: async () => state }
  const router = createApiRouter({ store, config: { home, dataDir: home }, configStore })
  const digestStore = createDigestStore(home)
  if (botDigest) router.setBotDigest({ store: digestStore })
  return { router, store, state, home, digestStore }
}

test('keeps at most 20 prefs and evicts the oldest', () => {
  const home = freshHome()
  const ds = createDigestStore(home)
  assert.equal(MAX_PREFS, 20)
  for (let i = 0; i < 25; i++) ds.addPref(`pref ${i}`)
  const prefs = ds.get().prefs
  assert.equal(prefs.length, 20)
  assert.ok(prefs.some(p => p.text === 'pref 24'), 'the newest one stays')
  assert.ok(!prefs.some(p => p.text === 'pref 0') && !prefs.some(p => p.text === 'pref 4'), 'the oldest five went')
  assert.equal(createDigestStore(home).get().prefs.length, 20, 'the cap is on disk too')
})

test('editPref changes the text in place and refuses empty, duplicate and unknown ids', () => {
  const home = freshHome()
  const ds = createDigestStore(home)
  const a = ds.addPref('alpha', { channel: 'gmail' })
  const b = ds.addPref('beta')
  const order = ds.get().prefs.map(p => p.id)

  const edited = ds.editPref(a.id, '  alpha two  ')
  assert.equal(edited.id, a.id, 'the id survives an edit')
  assert.equal(edited.text, 'alpha two')
  assert.equal(edited.channel, 'gmail', 'channel untouched')
  assert.equal(edited.by, 'chief', 'by untouched')
  assert.deepEqual(ds.get().prefs.map(p => p.id), order, 'the array position is untouched')
  assert.ok(edited.at >= a.at, 'at is refreshed')

  // The Save button posts the line back unchanged: that is a success, not a duplicate of itself.
  assert.equal(ds.editPref(a.id, 'alpha two').text, 'alpha two')

  const snapshot = JSON.stringify(ds.get().prefs)
  assert.equal(ds.editPref(a.id, '   '), null, 'blank text is refused')
  assert.equal(ds.editPref('nope', 'x'), null, 'unknown id is refused')
  assert.equal(ds.editPref(b.id, 'alpha two'), null, 'the same text on another pref is refused')
  assert.equal(JSON.stringify(ds.get().prefs), snapshot, 'a refusal writes nothing')

  ds.editPref(b.id, 'x'.repeat(200))
  assert.equal(createDigestStore(home).get().prefs.find(p => p.id === b.id).text.length, 160, 'clipped and persisted')
})

test('clearPrefs removes every pref and persists', () => {
  const home = freshHome()
  const ds = createDigestStore(home)
  assert.equal(ds.clearPrefs(), 0, 'nothing to clear')
  ds.addPref('one'); ds.addPref('two')
  assert.equal(ds.clearPrefs(), 2)
  assert.deepEqual(ds.get().prefs, [])
  assert.deepEqual(createDigestStore(home).get().prefs, [])
})

test('digest-pref router serves the list and every mutation returns the fresh list', async () => {
  const { router } = await makeRouter()
  assert.deepEqual(router.digestPrefs(), { success: true, prefs: [], max: 20 })

  const added = router.addDigestPref({ text: '促销邮件不单独出卡', channel: 'gmail' })
  assert.equal(added.success, true)
  assert.equal(added.prefs.length, 1)
  assert.equal(added.prefs[0].channel, 'gmail')
  assert.equal(added.prefs[0].by, 'user', 'a pref typed in Settings is the user’s own')
  const id = added.prefs[0].id
  assert.equal(router.addDigestPref({ text: '   ' }).error, 'empty')

  const edited = router.editDigestPref({ id, text: '促销与订阅邮件不单独出卡' })
  assert.equal(edited.success, true)
  assert.equal(edited.prefs[0].text, '促销与订阅邮件不单独出卡')
  assert.equal(router.editDigestPref({ id: 'nope', text: 'x' }).error, 'unknown-id')

  router.addDigestPref({ text: '第二条' })
  const secondId = router.digestPrefs().prefs.find(p => p.text === '第二条').id
  assert.equal(router.editDigestPref({ id: secondId, text: '促销与订阅邮件不单独出卡' }).error, 'duplicate')

  const removed = router.removeDigestPref(id)
  assert.equal(removed.success, true)
  assert.equal(removed.removed, true)
  assert.deepEqual(removed.prefs.map(p => p.text), ['第二条'])

  const cleared = router.clearDigestPrefs()
  assert.equal(cleared.cleared, 1)
  assert.deepEqual(cleared.prefs, [])
  assert.deepEqual(router.digestPrefs().prefs, [])

  // Without a bot digest store every method says so instead of throwing (non-dsh mode).
  const { router: bare } = await makeRouter({ botDigest: false })
  const unavailable = { success: false, error: 'bot digest unavailable', prefs: [], max: 20 }
  assert.deepEqual(bare.digestPrefs(), unavailable)
  assert.deepEqual(bare.addDigestPref({ text: 'x' }), unavailable)
  assert.deepEqual(bare.editDigestPref({ id: 'a', text: 'b' }), unavailable)
  assert.deepEqual(bare.removeDigestPref('a'), unavailable)
  assert.deepEqual(bare.clearDigestPrefs(), unavailable)
})

test('digest-pref route lists, adds, edits, removes and clears over HTTP', async () => {
  const { router } = await makeRouter()
  const { ok, specs } = captureRoutes(router)
  assert.equal(ok, true)
  const spec = specs.get('/api/opendigitalmate/digest-pref')
  assert.ok(spec, 'the route is registered')
  assert.deepEqual(spec.methods, ['GET', 'POST'])
  const url = 'http://localhost/api/opendigitalmate/digest-pref'
  const post = async (body) => spec.fetch(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).then(r => r.json())

  assert.deepEqual(await spec.fetch(new Request(url)).then(r => r.json()), { success: true, prefs: [], max: 20 }, 'GET lists')
  const added = await post({ text: '促销邮件不单独出卡', channel: 'gmail' })
  assert.equal(added.success, true)
  assert.equal(added.prefs.length, 1)
  const id = added.prefs[0].id
  const edited = await post({ edit: { id, text: '促销与订阅邮件不单独出卡' } })
  assert.equal(edited.success, true)
  assert.equal(edited.prefs[0].text, '促销与订阅邮件不单独出卡')
  assert.equal((await post({ edit: { id: 'nope', text: 'x' } })).error, 'unknown-id')
  const removed = await post({ remove: id })
  assert.equal(removed.removed, true)
  assert.deepEqual(removed.prefs, [])
  await post({ text: '第二条' })
  assert.equal((await post({ clear: true })).cleared, 1)
  assert.deepEqual((await spec.fetch(new Request(url)).then(r => r.json())).prefs, [])
})

test('digest-pref route exposes GET and POST for list/add/edit/remove/clear', () => {
  const at = routes.indexOf("path: '/api/opendigitalmate/digest-pref'")
  assert.ok(at > 0, 'the route exists')
  const block = routes.slice(at, at + 900)
  assert.match(block, /methods: \['GET', 'POST'\]/)
  assert.match(block, /request\.method === 'GET'/)
  assert.match(block, /router\.digestPrefs\(\)/)
  assert.match(block, /router\.addDigestPref\(/)
  assert.match(block, /router\.editDigestPref\(/)
  assert.match(block, /router\.removeDigestPref\(/)
  assert.match(block, /router\.clearDigestPrefs\(/)
})

test('Settings card lists, edits, deletes and clears digest prefs', () => {
  assert.match(html, /id="digestPrefsCard"/)
  assert.match(html, /id="digestPrefsList"/)
  assert.match(html, /id="digestPrefInput"/)
  assert.match(html, /id="digestPrefAdd"/)
  assert.match(html, /id="digestPrefClear"/)
  assert.match(html, /id="digestPrefsCount"/)
  assert.match(html, /id="digestPrefsMsg"/)
  assert.match(html, /data-pref-save="\$\{escapeHtml\(p\.id\)\}"/)
  assert.match(html, /data-pref-del="\$\{escapeHtml\(p\.id\)\}"/)
  assert.match(html, /async function loadDigestPrefs\(/)
  assert.match(html, /settings\.prefs_count/)
  assert.match(html, /fetch\('\/api\/opendigitalmate\/digest-pref'\)/)
  assert.match(html, /\{ edit: \{ id: saveId, text:/)
  assert.match(html, /\{ remove: b\.getAttribute\('data-pref-del'\) \}/)
  assert.match(html, /\{ clear: true \}/)

  const showView = html.slice(html.indexOf('function showView(view)'), html.indexOf('function closeAllViews'))
  assert.match(showView, /loadDigestPrefs\(\)/, 'opening Settings loads the card')
  const locStart = html.indexOf('function setAppLocale'); const locale = html.slice(locStart, html.indexOf("document.querySelectorAll('.lang-switch')", locStart))
  assert.match(locale, /loadDigestPrefs\(\)/, 'switching language repaints the card')
})

test('Settings prefs card escapes pref text and redraws on language switch', () => {
  assert.match(html, /value="\$\{escapeHtml\(p\.text\)\}"/, 'the owner’s own words are escaped')
  assert.match(html, /data-pref-id="\$\{escapeHtml\(p\.id\)\}"/)
  // applyDom sets textContent, so data-i18n on the list container would wipe the rows it just painted.
  const open = html.indexOf('<div id="digestPrefsList"')
  const tag = html.slice(open, html.indexOf('>', open) + 1)
  assert.ok(open > 0)
  assert.doesNotMatch(tag, /data-i18n/)
  const locStart = html.indexOf('function setAppLocale'); const locale = html.slice(locStart, html.indexOf("document.querySelectorAll('.lang-switch')", locStart))
  assert.match(locale, /loadDigestPrefs\(\)/)
})

test('a card marked 没用 writes one pref and undo removes it', async () => {
  const { router, state } = await makeRouter()
  state.cards = [{ id: 'c1', source: 'gmail', type: 'email-group', title: '社交通知', metadata: { group: 'social' }, status: 'active' }]

  const out = await router.trackCardInteraction('c1', 'not-useful')
  assert.equal(out.success, true)
  const prefs = router.digestPrefs().prefs
  assert.equal(prefs.length, 1)
  assert.ok(prefs[0].text.includes('社交通知') && prefs[0].text.includes('不单独出卡'))
  assert.equal(prefs[0].channel, 'gmail')
  assert.equal(prefs[0].by, 'user')
  assert.equal(prefs[0].id, out.prefId)
  assert.equal(state.cards[0].status, 'dismissed')

  await router.trackCardInteraction('c1', 'undo-not-useful', null, out.prefId)
  assert.deepEqual(router.digestPrefs().prefs, [])
  assert.equal(state.cards[0].status, 'active')
})

test('rapid addPref calls get distinct ids and removePref removes exactly one', () => {
  const home = freshHome()
  const ds = createDigestStore(home)
  for (let i = 0; i < 25; i++) ds.addPref(`相隔很短的偏好 ${i}`)
  const ids = ds.get().prefs.map(p => p.id)
  assert.equal(new Set(ids).size, ids.length, 'fast adds never share an id')

  const home2 = freshHome()
  const ds2 = createDigestStore(home2)
  for (let i = 0; i < 10; i++) ds2.addPref(`偏好 ${i}`)
  const before = ds2.get().prefs.map(p => p.id)
  assert.ok(ds2.removePref(before[3]))
  const after = ds2.get().prefs.map(p => p.id)
  assert.equal(after.length, 9)
  assert.deepEqual(after, before.filter(id => id !== before[3]), 'only that one line went')

  // ids from an older digest.json are opaque strings and still work.
  const home3 = freshHome()
  writeFileSync(join(home3, 'digest.json'), JSON.stringify({ prefs: [{ id: 'pmw5qx844', text: '老偏好', channel: null, by: 'user', at: new Date().toISOString() }] }))
  const ds3 = createDigestStore(home3)
  assert.equal(ds3.editPref('pmw5qx844', '老偏好改过').text, '老偏好改过')
  assert.ok(ds3.removePref('pmw5qx844'))
})

test('Settings prefs card uses Muse buttons, Enter adds, and empty states disable Add / Clear all', () => {
  assert.match(html, /class="btn primary" id="digestPrefAdd"[^>]*disabled/, 'Add is a styled primary button, off until there is text')
  assert.match(html, /class="btn" id="digestPrefClear"[^>]*disabled/, 'Clear all is a styled button, off with nothing to clear')
  assert.match(html, /class="btn" data-pref-save=/)
  assert.match(html, /class="btn" data-pref-del=/)
  assert.match(html, /\.btn:disabled/)
  assert.match(html, /digestPrefClear'\)\.disabled = unavailable \|\| !prefs\.length/)
  assert.match(html, /e\.key === 'Enter' && !e\.isComposing/, 'Enter adds a line, but not mid-IME composition')
  assert.match(html, /id="digestPrefsMsg" class="pref-msg" role="status"/)
})

test('Settings digest-mode note and page title are bilingual, not hard-coded Chinese', () => {
  const mode = html.slice(html.indexOf('async function loadDigestMode'), html.indexOf('// ---- Standing digest preferences'))
  assert.doesNotMatch(mode, /[\u4e00-\u9fff]/, 'no hard-coded CJK in the digest-mode note')
  assert.match(mode, /settings\.digest_mode_saved/)
  assert.match(mode, /settings\.digest_mode_unavailable/)
})
