import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('today page: one pinned line above the cards, escaped, with a done button', () => {
  const src = read('packages/dsh-muse-ui/static/index.html')
  const list = src.slice(src.indexOf('function renderCardList(cards)'), src.indexOf('function openDock('))
  assert.ok(list.includes('renderDutyLine('), 'renderCardList draws the line')
  assert.ok(list.indexOf('renderDutyLine(') < list.indexOf('renderNextHero('), 'the line is the first block, before the hero')
  assert.ok(list.indexOf('bindDutyLine(container') > list.indexOf('container.innerHTML = html;'), 'the line is bound after the grid is rebuilt')

  assert.match(src, /\.duty-line\{/)
  assert.match(src, /data-duty-done/)
  assert.match(src, /fetch\('\/api\/opendigitalmate\/duty'/)

  const start = src.indexOf('function renderDutyLine(')
  const fn = src.slice(start, src.indexOf('\n  function ', start + 10))
  assert.match(fn, /escapeHtml\(/)
  assert.doesNotMatch(fn, /\$\{duty\.text\}/, 'the raw note never reaches innerHTML')
  assert.match(fn, /data-duty-done/)
})

test('duty: the browser route writes by=user, the stand-alone server has the path too', () => {
  const dsh = read('src/web/dsh-host-routes.js')
  assert.match(dsh, /\/api\/opendigitalmate\/duty/)
  assert.match(dsh, /dutyOp\(await readJson\(request\), \{ by: 'user' \}\)/)

  const api = read('src/web/api.js')
  const mount = api.slice(api.indexOf('export function mountApiRoutes'), api.indexOf('export default {'))
  assert.match(mount, /url\.pathname === '\/api\/opendigitalmate\/duty'/)
  assert.match(mount, /router\.dutyOp\(/)
})

test('duty: i18n keys exist in en and zh', async () => {
  const { t } = await import('../src/i18n/index.js')
  const keys = ['duty.add', 'duty.placeholder', 'duty.done', 'duty.set_toast', 'duty.done_toast', 'duty.by_bot', 'duty.by_user', 'duty.eyebrow']
  for (const key of keys) {
    assert.notEqual(t(key, 'en'), key, `en is missing ${key}`)
    assert.notEqual(t(key, 'zh'), key, `zh is missing ${key}`)
  }
})

test('duty: typing a note survives a cards event', () => {
  const src = read('packages/dsh-muse-ui/static/index.html')
  const start = src.indexOf('async function applyUiEvent(e)')
  const slice = src.slice(start, src.indexOf('async function applyOpEvent(', start))
  assert.match(slice, /dutyBusy\(\)/, 'the cards branch checks for an unfinished draft')
  assert.doesNotMatch(slice, /if \(e\.kind === 'cards'\) \{\s*await loadToday\(\)/, 'a cards event no longer reloads over the draft')
  assert.match(src, /function dutyBusy\(\)/)
})
