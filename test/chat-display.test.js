import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatDisplay, stripAttachNote, legacyAttachments } from '../src/web/chat-display.js'
import { historyMessages } from '../src/web/dsbot-chat.js'
import { combineRequests } from '../src/web/chat-lane.js'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const line = (o) => JSON.stringify(o)
const userRec = (text, rpcId, extra = []) => line({ type: 'user/message', data: { source: { kind: 'user', rpcId }, message: { role: 'user', content: [{ type: 'text', text }, ...extra] } } })
const botRec = (text) => line({ type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } })

test('display record: bubble text + image ref saved by content hash; served path only for our refs', () => {
  const home = mkdtempSync(join(tmpdir(), 'odm-disp-'))
  const d = createChatDisplay({ home })
  const items = d.record('rpc-1', [{ text: '看看这张图', attachments: [{ kind: 'image', name: 'token.png', mediaType: 'image/png', data: PNG }, { kind: 'file', name: 'note.txt', mediaType: 'text/plain', data: Buffer.from('hello').toString('base64') }] }])
  assert.equal(items[0].text, '看看这张图')
  const [img, file] = items[0].attachments
  assert.match(img.ref, /^[a-f0-9]{64}\.png$/)
  assert.ok(existsSync(d.imagePath(img.ref)))
  assert.equal(file.ref, undefined); assert.equal(file.name, 'note.txt'); assert.equal(file.bytes, 5)
  assert.equal(d.imagePath('../../etc/passwd'), null)
  // persisted
  assert.deepEqual(createChatDisplay({ home }).lookup('rpc-1'), items)
})

test('history: a recorded prompt shows only the user words + attachments, never the 【附件】 note', () => {
  const home = mkdtempSync(join(tmpdir(), 'odm-disp-'))
  const d = createChatDisplay({ home })
  d.record('rpc-a', [{ text: '图里写的口令是什么？', attachments: [{ kind: 'image', name: 'token.png', mediaType: 'image/png', data: PNG }] }])
  const raw = [
    userRec('【当前视图】今天页\n\n图里写的口令是什么？\n\n【附件】\n图片「token.png」（9KB，mediaType=image/png）', 'rpc-a', [{ type: 'image', attachment: { mediaType: 'image/png', bytes: 9000 } }]),
    botRec('ODM-VIS-1234'),
  ].join('\n')
  const h = historyMessages(raw, { display: d })
  assert.equal(h[0].content, '图里写的口令是什么？')
  assert.equal(h[0].attachments[0].name, 'token.png')
  assert.ok(h[0].attachments[0].ref)
  assert.equal(JSON.stringify(h).includes('【附件】'), false)
})

test('history: a merged turn comes back as one bubble per message', () => {
  const home = mkdtempSync(join(tmpdir(), 'odm-disp-'))
  const d = createChatDisplay({ home })
  const c = combineRequests([{ message: 'A: 绿色' }, { message: 'B: 芒果' }])
  d.record('rpc-m', c.displayItems)
  const h = historyMessages([userRec(`【当前视图】x\n\n${c.message}`, 'rpc-m'), botRec('记住了')].join('\n'), { display: d })
  assert.deepEqual(h.map(m => m.content), ['A: 绿色', 'B: 芒果', '记住了'])
})

test('legacy history (no record): note stripped, chips from structured parts', () => {
  const raw = [
    userRec('只根据附件回答：token 是什么？\n\n【附件】\n文件「note.txt」全文：\n```\nThe secret is X\n```', 'old-1', [{ type: 'file', receiptId: 'r1' }]),
    userRec('【当前视图】今天页\n\n请看我附上的内容。\n\n【附件】\n图片「a.png」（9KB，mediaType=image/png）', 'old-2', [{ type: 'image', attachment: { mediaType: 'image/png', bytes: 9216 } }]),
    userRec('（补充一条，请和上一条一起回答，一次回复）\nB: 我最喜欢的动物是猫', 'old-3'),
  ].join('\n')
  const h = historyMessages(raw)
  assert.equal(h[0].content, '只根据附件回答：token 是什么？')
  assert.deepEqual(h[0].attachments.map(a => [a.kind, a.name]), [['file', 'note.txt']])
  assert.equal(h[1].content, '')
  assert.deepEqual(h[1].attachments.map(a => [a.kind, a.name, a.bytes]), [['image', 'a.png', 9216]])
  assert.equal(h[2].content, 'B: 我最喜欢的动物是猫')
  assert.equal(JSON.stringify(h).includes('【附件】'), false)
})

test('stripAttachNote / legacyAttachments edge cases', () => {
  assert.equal(stripAttachNote('hi'), 'hi')
  assert.equal(stripAttachNote('【附件】\n图片「x.png」'), '')
  assert.deepEqual(legacyAttachments([], '【附件】\n图片「x.png」（1KB）').map(a => a.name), ['x.png'])
})
