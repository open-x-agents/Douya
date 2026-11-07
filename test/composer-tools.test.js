// Composer attach / mic must stay in the real Today dock (regression after UX packs).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')

test('Today composer exposes attach + mic + file picker', () => {
  assert.match(html, /id="todayAttachBtn"/)
  assert.match(html, /id="todayMicBtn"/)
  assert.match(html, /id="todayFilePick"/)
  assert.match(html, /id="todayAttachBtn"[^>]*aria-label="(?:Attach|添加图片或文件)"/)
  assert.match(html, /id="todayMicBtn"[^>]*aria-label="(?:Voice input|语音输入)"/)
  assert.match(html, /data-i18n="composer\.attach_title"|composer\.attach/)
  assert.match(html, /data-i18n="composer\.mic"/)
  assert.match(html, /makeComposer\(\{[\s\S]*?attachBtnId: 'todayAttachBtn'[\s\S]*?micBtnId: 'todayMicBtn'/)
})

test('attach keeps ＋ glyph; mic is Lucide SVG (no emoji)', () => {
  assert.match(html, /composer-tools-restore/)
  assert.match(html, /todayAttachBtn[\s\S]*?ct-glyph[\s\S]*?＋/)
  assert.match(html, /todayMicBtn[\s\S]*?composer-mic[\s\S]*?<svg viewBox="0 0 24 24"/)
  assert.match(html, /rect x="9" y="2\.5" width="6" height="12" rx="3"/)
  // mic button must not use emoji
  const micChunk = html.split('id="todayMicBtn"')[1].slice(0, 500)
  assert.doesNotMatch(micChunk, /🎤/)
  assert.doesNotMatch(html, /\.composer-tools button\{[^}]*font-size:0/)
  assert.match(html, /#todayAttachBtn,#todayMicBtn\{display:grid!important/)
})

test('typing-stable chips do not target composer-tools', () => {
  assert.match(html, /chat-chips\.is-typing/)
  assert.doesNotMatch(html, /composer-tools\.is-typing/)
  assert.match(html, /never hide composer-tools while typing/)
})
