// Today tile motion: done-today must not flash on refresh; hover QA expands smoothly.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')

test('done-today cardIn runs only on first stagger, not on every paint', () => {
  assert.match(html, /cardAppearStagger > \.tile\.done-today\{animation:cardIn/)
  // Standing rule keeps the warm-glass look but must not restart fade-in on innerHTML replace.
  assert.doesNotMatch(html, /(?:^|\n)\s*\.tile\.done-today\{[^}]*animation:cardIn/)
  assert.match(html, /lastCardListHtml/)
  assert.match(html, /if \(html === lastCardListHtml && container\.querySelector/)
  assert.doesNotMatch(html, /listEl\.classList\.add\('is-refreshing'\)/)
})

test('hover QA bar expands with grid-template-rows, not an instant display toggle', () => {
  assert.match(html, /\.qa-bar\{display:grid;grid-template-rows:0fr/)
  assert.match(html, /transition:grid-template-rows 220ms var\(--ease-out\)/)
  assert.match(html, /swipeable:hover \.qa-bar[^\n]*grid-template-rows:1fr/)
  assert.match(html, /class="qa-bar-in"/)
  assert.doesNotMatch(html, /swipeable:hover \.qa-bar[^\n]*display:flex/)
  assert.match(html, /prefers-reduced-motion:reduce\)[\s\S]*?\.qa-bar\{animation:none!important;transition:none!important/)
})
