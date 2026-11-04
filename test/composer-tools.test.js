// Composer attach / mic must stay in the real Today dock (regression after UX packs).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../src/client/index.html', import.meta.url), 'utf8')

test('Today composer exposes attach + mic + file picker', () => {
  assert.match(html, /id="todayAttachBtn"/)
  assert.match(html, /id="todayMicBtn"/)
  assert.match(html, /id="todayFilePick"/)
  assert.match(html, /aria-label="添加图片或文件"/)
  assert.match(html, /aria-label="语音输入"/)
  assert.match(html, /makeComposer\(\{[\s\S]*?attachBtnId: 'todayAttachBtn'[\s\S]*?micBtnId: 'todayMicBtn'/)
})

test('attach/mic stay visible (no font-size:0 wipe; restore glyphs)', () => {
  assert.match(html, /composer-tools-restore/)
  assert.match(html, /ct-glyph/)
  assert.match(html, /＞|＋|ct-glyph[\s\S]*?＋/)
  assert.match(html, /ct-glyph[\s\S]*?🎤/)
  assert.doesNotMatch(html, /\.composer-tools button\{[^}]*font-size:0/)
  assert.match(html, /#todayAttachBtn,#todayMicBtn\{display:grid!important/)
})

test('typing-stable chips do not target composer-tools', () => {
  assert.match(html, /chat-chips\.is-typing/)
  assert.doesNotMatch(html, /composer-tools\.is-typing/)
  assert.match(html, /never hide composer-tools while typing/)
})
