// Card polish + Today chat sheet: density contracts for Muse-like faces and a usable phone chat.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')
const face = readFileSync(new URL('../src/ui/face.js', import.meta.url), 'utf8')

test('today chat opens taller (not a skinny 52vh strip)', () => {
  assert.match(html, /\.today-chat\.open \.today-chat-sheet\{[^}]*max-height:min\(640px,72vh\)/)
  assert.doesNotMatch(html, /\.today-chat\.open \.today-chat-sheet\{[^}]*max-height:min\(420px,52vh\)/)
  assert.match(html, /\.today-chat-msgs\{[^}]*min-height:200px/)
})

test('phone chat is a conversation sheet (~82vh) with roomy messages', () => {
  assert.match(html, /proper conversation sheet/)
  assert.match(html, /max-height:min\(82vh,760px\)/)
  assert.match(html, /min-height:48vh/)
})

test('work cards denser: short source labels, hide face desc, quiet next bar', () => {
  assert.match(html, /SRC_SHORT/)
  assert.match(html, /t\('src\.github'\)/)
  assert.match(html, /t\('src\.gmail'\)/)
  assert.match(html, /\.tile\.work\.has-face \.w-desc/)
  assert.match(html, /\.w-next-k\{[^}]*color:var\(--ink3\)/)
  assert.match(html, /Card polish \(Muse density/)
})

test('phone cards: single column, 44px tap targets, no mid-word hard cut on head', () => {
  assert.match(html, /@media \(max-width:620px\)\{[\s\S]*?\.w-acts \.step\.primary\{[^}]*min-height:44px/)
  assert.match(html, /\.w-head\{[^}]*overflow-wrap:anywhere/)
  assert.match(html, /\.grid2\{grid-template-columns:1fr!important/)
})

test('hover micro-feedback stays soft so dense faces are readable', () => {
  assert.match(html, /\.grid2 \.tile\.work:hover\{transform:translateY\(-2px\)/)
  assert.match(html, /\.grid2 \.tile\.work\.has-face:hover\{transform:translateY\(-1px\)/)
})

test('quote face still ships author row + link chip (no 谁说的 chrome)', () => {
  assert.match(html, /f-quote-hd/)
  assert.match(html, /f-linkchip/)
  assert.match(face, /parts: \['quote', 'cta'\]/)
  assert.doesNotMatch(face, /quote: \{ desc: '[^']*', parts: \['quote', 'people'/)
})
