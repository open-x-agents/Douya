// Desktop / PC-first pack: hover QA + kbd hints, pointer swipe, j/k/e/c/s IME-safe, two-col zoom, toast.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')

test('desktop hover qa-bar with keyboard hint glyphs', () => {
  assert.match(html, /UX desktop pack/)
  assert.match(html, /hover:hover\) and \(pointer:fine\)/)
  assert.match(html, /is-kb-focus \.qa-bar/)
  assert.match(html, /t\('qa\.done_title'\)/)
  assert.match(html, /<span class="kbd">C<\/span>/)
  assert.match(html, /<span class="kbd">S<\/span>/)
})

test('pointer/mouse drag swipe shares touch thresholds', () => {
  assert.match(html, /matchMedia\('\(pointer: fine\)'\)\.matches/)
  assert.match(html, /face\.addEventListener\('pointerdown'/)
  assert.match(html, /setPointerCapture/)
  assert.match(html, /e\.pointerType === 'touch'/)
  assert.match(html, /Math\.abs\(raw\) > Math\.max\(w \* 0\.55, 168\)/)
})

test('IME-safe j/k/e/c/s and ? help; Esc dismisses chips', () => {
  assert.match(html, /function setKbFocus/)
  assert.match(html, /function openKbHelp/)
  assert.match(html, /function dismissChatChips/)
  assert.match(html, /key === 'j' \|\| key === 'J'/)
  assert.match(html, /key === 'k' \|\| key === 'K'/)
  assert.match(html, /runQuickDone\(card\)/)
  assert.match(html, /openSnoozeSheet\(card\)/)
  assert.match(html, /e\.isComposing \|\| e\.keyCode === 229/)
  assert.match(html, /deskTypingTarget/)
  assert.match(html, /dockOpen/)
  assert.match(html, /t\('kb\.title'\)/)
})

test('desktop two-column zoom + larger Today conversation', () => {
  assert.match(html, /min-width:901px\)\{[\s\S]*?today-chat\.open \.today-chat-sheet\{max-height:min\(720px,78vh\)/)
  assert.match(html, /tile-zoom-modal\{height:90vh!important/)
  assert.match(html, /z-split\{grid-template-columns:minmax\(0,1\.2fr\) minmax\(400px,480px\)/)
  assert.match(html, /today-chat\.in-zoom \.today-chat-input\{position:sticky;bottom:0/)
})

test('desktop undo toast clears the dock', () => {
  assert.match(html, /ui-toast\{left:auto;right:28px;bottom:108px/)
})
