import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Buffer } from 'node:buffer'
import {
  normalizeAttachments, buildChatContent, canonicalBase64, isImageModelError,
  IMAGE_MAX_BYTES, FILE_MAX_BYTES,
} from '../src/web/chat-media.js'

const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64') // tiny fake; admission may fail later but normalize accepts type

test('normalizeAttachments: accepts png/jpeg names and rejects oversize / bad types', () => {
  const ok = normalizeAttachments([{ kind: 'image', mediaType: 'image/png', name: 'a.png', data: png }])
  assert.equal(ok.ok, true); assert.equal(ok.items[0].kind, 'image')
  const bad = normalizeAttachments([{ kind: 'file', name: 'x.exe', data: png }])
  assert.equal(bad.ok, false)
  const big = 'A'.repeat(100)
  // craft oversize by claiming bytes via long b64
  const huge = Buffer.alloc(IMAGE_MAX_BYTES + 10).toString('base64')
  const over = normalizeAttachments([{ kind: 'image', mediaType: 'image/png', name: 'h.png', data: huge }])
  assert.equal(over.ok, false)
  assert.match(over.error, /10MB/)
})

test('canonicalBase64 strips data-URL, rejects whitespace, keeps canonical payload', () => {
  assert.equal(canonicalBase64('data:image/png;base64,' + png).b64, png)
  assert.throws(() => canonicalBase64(png + '\n'))
  assert.equal(canonicalBase64(png).b64, png)
})

test('buildChatContent: text-only; native images when preferNative; text fallback inlines file text', async () => {
  const t = await buildChatContent({}, { text: 'hi' })
  assert.deepEqual(t.content, [{ type: 'text', text: 'hi' }])
  const img = await buildChatContent({}, { text: '看图', attachments: [{ kind: 'image', mediaType: 'image/png', name: 'a.png', data: png }] }, { preferNative: true })
  assert.equal(img.mode, 'native')
  assert.ok(img.content.some(p => p.type === 'image' && p.data === png))
  const txt = Buffer.from('hello file body\nline2', 'utf8').toString('base64')
  const f = await buildChatContent({}, { text: '看文件', attachments: [{ kind: 'file', name: 'note.txt', data: txt }] }, { preferNative: false })
  assert.equal(f.mode, 'text')
  assert.match(f.content[0].text, /hello file body/)
  assert.match(f.content[0].text, /note\.txt/)
})

test('isImageModelError detects dsh refusal', () => {
  assert.equal(isImageModelError(new Error('Model "deepseek-chat" does not support image input.')), true)
  assert.equal(isImageModelError(new Error('boom')), false)
})

test('file size cap 20MB', () => {
  const huge = Buffer.alloc(FILE_MAX_BYTES + 1).toString('base64')
  const r = normalizeAttachments([{ kind: 'file', name: 'a.txt', data: huge }])
  assert.equal(r.ok, false)
})
