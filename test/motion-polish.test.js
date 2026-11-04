// Muse/Amie-grade motion contracts: soft easing, transform/opacity, reduced-motion kill switch.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../src/client/index.html', import.meta.url), 'utf8')

test('motion tokens: soft ease-out + longer sheet duration', () => {
  assert.match(html, /--ease:cubic-bezier\(\.22,\.82,\.24,1\)/)
  assert.match(html, /--ease-sheet:cubic-bezier\(\.32,\.72,\.22,1\)/)
  assert.match(html, /--dur:220ms/)
  assert.match(html, /--dur-sheet:420ms/)
})

test('card lifecycle: appear stagger, soft doneOut, badge pop', () => {
  assert.match(html, /@keyframes cardIn\{from\{opacity:0;transform:translateY\(10px\)/)
  assert.match(html, /cardAppearStagger/)
  assert.match(html, /@keyframes doneOut[\s\S]*?scale\(\.94\) translateY\(-8px\)/)
  assert.match(html, /leaving-done\{[\s\S]*?animation:doneOut \.9s/)
})

test('zoom open/close reverse + overlay fade (no display jump)', () => {
  assert.match(html, /@keyframes zoomFromTile/)
  assert.match(html, /@keyframes zoomToTile/)
  assert.match(html, /modal\.classList\.add\('zoom-out'\)/)
  assert.match(html, /\.tile-zoom-overlay\{[^}]*opacity:0;visibility:hidden;pointer-events:none/)
})

test('dock sheet uses transform/opacity with sheet easing; chips fade in', () => {
  assert.match(html, /today-chat-sheet\{[^}]*transform:translateY\(14px\) scale\(\.985\)/)
  assert.match(html, /transition:max-height var\(--dur-sheet\) var\(--ease-sheet\)/)
  assert.match(html, /chat-chips fade with sheet/)
})

test('timetable now-line pulses; soft-block drag stays on transform', () => {
  assert.match(html, /@keyframes nowPulse/)
  assert.match(html, /\.tt-bar\{transition:left var\(--dur\)/)
  assert.match(html, /\.tile\.work\.dragging\{opacity:\.72;transform:scale\(\.985\)/)
})

test('prefers-reduced-motion disables decorative motion', () => {
  assert.match(html, /prefers-reduced-motion:reduce\)\{[\s\S]*?animation:none!important;transition:none!important/)
  assert.match(html, /tt-now,\.tt-now::before,\.sprout-pop/)
})
