// UX polish pack: swipe auto-commit + rubber-band, haptic, done tuck, typing-stable chips, mobile zoom, a11y.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../src/client/index.html', import.meta.url), 'utf8')

test('swipe past threshold auto-commits with rubber-band', () => {
  assert.match(html, /swipe-commit/)
  assert.match(html, /rubber = 0\.42/)
  assert.match(html, /Math\.abs\(raw\) > Math\.max\(w \* 0\.55, 168\)/)
  assert.match(html, /runQuickDone\(card\)/)
  assert.match(html, /runQuickAsk\(card\)/)
  assert.match(html, /const damp = /)
})

test('soft haptic via navigator.vibrate where supported', () => {
  assert.match(html, /function softHaptic/)
  assert.match(html, /navigator\.vibrate/)
  assert.match(html, /softHaptic\('commit'\)/)
  assert.match(html, /softHaptic\('snooze'\)/)
})

test('done cards tuck toward 今天搞定了什么', () => {
  assert.match(html, /function markDoneTuck/)
  assert.match(html, /tuck-done/)
  assert.match(html, /@keyframes doneTuck/)
  assert.match(html, /just-tucked/)
  assert.match(html, /今天搞定了什么/)
})

test('suggestion chips collapse while typing (no layout shove)', () => {
  assert.match(html, /function syncComposerTyping/)
  assert.match(html, /chat-chips\.is-typing/)
  assert.match(html, /chips\.classList\.toggle\('is-typing'/)
  assert.match(html, /composer-tip\.is-typing/)
})

test('mobile density + zoom sticky chat on narrow', () => {
  assert.match(html, /\.w-acts \.step\.primary\{width:100%/)
  assert.match(html, /today-chat-msgs\{min-height:52vh\}/)
  assert.match(html, /position:sticky;bottom:0/)
  assert.match(html, /100dvh/)
  assert.match(html, /env\(safe-area-inset-bottom\)/)
})

test('swipe rails expose aria labels; focus-visible rings', () => {
  assert.match(html, /aria-label="滑动快捷操作"/)
  assert.match(html, /aria-label="完成这张卡"/)
  assert.match(html, /:focus-visible/)
  assert.match(html, /prefers-reduced-motion:reduce\)\{[\s\S]*?tuck-done/)
})
