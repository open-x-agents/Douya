// S1–S5a: a group-wide stop empties the group Session's inbox of its relays, and the
// rules that pick them keep the text out of the log exactly once. No @deepseek-ai import.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isRoomRelay, postLine, relayMessages, relayText } from '../../vendor/ds-bot/src/host/group-stop.js'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const source = path => readFileSync(join(root, path), 'utf8')

// One function of groups.js, from its first line to the next one at the same indent.
const bodyOf = (text, header) => {
  const start = text.indexOf(header)
  assert.notEqual(start, -1, `${header} is gone`)
  const rest = text.slice(start + header.length)
  const end = rest.search(/\n {2}(?:async )?function /)
  return end === -1 ? rest : rest.slice(0, end)
}

const relay = (id, roomId, role, form = 'relay') => ({ id, content: [], source: { kind: 'bot', form, roomId, role } })

test('S1 relayMessages picks only this room\'s round-opening relays', () => {
  const inbox = {
    nextTurn: [
      relay('t1', 'r1', 'post'),
      { id: 't2', content: [], source: { kind: 'user' } },
      relay('t3', 'r2', 'post'),
    ],
    nextStep: [
      relay('s1', 'r1', 'kickoff'),
      relay('s2', 'r1', 'resume'),
      relay('s3', 'r1', 'post', 'message'),
      relay('s4', 'r1', undefined),
    ],
  }
  assert.deepEqual(relayMessages(inbox, 'r1').map(message => message.id), ['t1', 's1', 's2'])
  assert.equal(isRoomRelay({ kind: 'bot', form: 'relay', roomId: 'r1', role: 'post' }, 'r1'), true)
  assert.equal(isRoomRelay({ kind: 'user' }, 'r1'), false)
  assert.deepEqual(relayMessages({}, 'r1'), [])
})

test('S2 relayText drops the group-post header', () => {
  assert.equal(relayText([{ type: 'text', text: '[Group post from Writer]\nhi' }]), 'hi')
  assert.equal(relayText([{ type: 'text', text: 'hi' }]), 'hi')
  assert.equal(relayText([{ type: 'text', text: '[Group post from Writer]' }]), '')
  assert.equal(relayText([]), '')
})

test('S4 postLine keeps events as kind lines and late text as a line', () => {
  const room = { id: 'r1' }
  const sender = { id: 'b', name: 'Writer' }
  assert.deepEqual(postLine({ room, sender, extra: { stopped: true } }), { who: 'Writer', botId: 'b', kind: 'stopped', text: '' })
  assert.deepEqual(postLine({ room, sender, extra: { done: true } }), { who: 'Writer', botId: 'b', kind: 'done', text: '' })
  assert.deepEqual(postLine({ room, sender, extra: { resumed: true, again: true } }), { who: 'Writer', botId: 'b', kind: 'cut', text: '' })
  assert.deepEqual(postLine({ room, sender, extra: { resumed: true } }), { who: 'Writer', botId: 'b', kind: 'resumed', text: '' })
  assert.deepEqual(postLine({ room, sender, text: 'hi' }), { who: 'Writer', botId: 'b', text: 'hi' })
  // A body that still carries the header is not written twice.
  assert.deepEqual(postLine({ room, sender, text: '[Group post from Writer]\nhi' }), { who: 'Writer', botId: 'b', text: 'hi' })
  assert.equal(postLine({ room, sender, text: '', extra: { failed: { code: 'x' } } }), undefined)
  assert.equal(postLine({ room, sender, text: '' }), undefined)
  const files = [{ name: 'a.png', bytes: 12 }]
  assert.deepEqual(postLine({ room, sender, text: '', files }), { who: 'Writer', botId: 'b', text: '[File "a.png" (12 bytes) attached]', files })
  // A late post keeps the quote of what it answers.
  assert.deepEqual(postLine({ room, sender, text: 'hi', extra: { late: true, quoteText: '原句', quoteSeq: 3 } }), { who: 'Writer', botId: 'b', text: 'hi', quote: { roomId: 'r1', seq: 3 } })
  assert.deepEqual(postLine({ room, sender, text: 'hi', extra: { late: true, quoteText: '原句', quoteSeq: 3, quoteRoomId: 'r2' } }), { who: 'Writer', botId: 'b', text: 'hi', quote: { roomId: 'r2', seq: 3 } })
})

test('S5a groups.js drains the room inbox on a group-wide stop', () => {
  const groups = source('vendor/ds-bot/src/host/groups.js')
  assert.match(groups, /from '\.\/group-stop\.js'/)
  const drop = bodyOf(groups, 'async function dropRoomRelays(room) {')
  assert.match(drop, /relayMessages\(agent\.inbox, room\.id\)/)
  assert.match(drop, /source\.role === 'post' && source\.logged === undefined/)
  assert.match(drop, /postLine\(/)
  assert.match(drop, /appendRoom\(room, line\)/)
  assert.match(drop, /agent\.inbox\.remove\(message\.id\)/)
  const stop = bodyOf(groups, 'async function stopRoomWork(roomId) {')
  assert.match(stop, /await dropRoomRelays\(room\)/)
})
