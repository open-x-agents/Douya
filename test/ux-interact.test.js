// Interaction pack contracts: swipe/hover QA, Esc/Enter, 5s undo, progressive disclosure, empty CTAs, dock cue.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')

test('swipe + hover quick actions on work tiles', () => {
  assert.match(html, /class="tile work swipeable/)
  assert.match(html, /swipe-rails/)
  assert.match(html, /qa-bar/)
  assert.match(html, /data-qa="done"/)
  assert.match(html, /data-qa="snooze"/)
  assert.match(html, /data-qa="ask"/)
  assert.match(html, /function bindQuickActions/)
  assert.match(html, /touch-action:pan-y/)
})

test('snooze sheet presets 1h / tomorrow / week', () => {
  assert.match(html, /function openSnoozeSheet/)
  assert.match(html, /snooze:1h/)
  assert.match(html, /snooze:tomorrow/)
  assert.match(html, /snooze:week/)
  assert.match(html, /SNOOZE_LABEL/)
})

test('Esc closes zoom/dock/sheet; Enter focuses closed dock without blocking IME', () => {
  assert.match(html, /e\.key === 'Escape'/)
  assert.match(html, /closeTodayChat\(\)/)
  assert.match(html, /closeSnoozeSheet/)
  assert.match(html, /e\.isComposing || e\.keyCode === 229/)
  assert.match(html, /e\.key === 'Enter'/)
  assert.match(html, /openTodayChat\(\{ byUser: true, contextual: true \}\)/)
})

test('undo toasts default to 5s', () => {
  assert.match(html, /toastTimer = setTimeout\(\(\) => el\.classList\.remove\('show'\), \(extra && extra\.ms\) \|\| 5000\)/)
  assert.doesNotMatch(html, /undoId \|\| extra \? 12000/)
})

test('progressive disclosure: hide 下一步 when primary CTA exists', () => {
  assert.match(html, /const showNext = !!\(na && !primary\)/)
  assert.match(html, /\$\{showNext \?/)
})

test('empty / all-done invitations + dock contextual cue', () => {
  assert.match(html, /data-empty-act="review"/)
  assert.match(html, /data-empty-act="chat"/)
  // One empty state, one Refresh: the first-run tile has no second Refresh button and the idle Now card is skipped.
  assert.doesNotMatch(html, /data-empty-act="digest"/)
  assert.match(html, /nx\.kind === 'none' && !work\.length/)
  assert.match(html, /function paintDockCue/)
  assert.match(html, /function bindEmptyCtas/)
  assert.match(html, /chip-act/)
})

test('scroll vs tap: moved threshold suppresses open', () => {
  assert.match(html, /tile\.dataset\.moved === '1'/)
  assert.match(html, /swipe-open/)
})
