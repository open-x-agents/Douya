import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decay, matchThread, openThread, overlap, pruneThreads, scoreThread, titleOf, tokens, touchThread } from '../src/host/threads.js'

const at = iso => Date.parse(iso)
const now = at('2026-10-30T09:00:00Z')
const day = 24 * 60 * 60 * 1000

test('Chinese is matched in pairs, not by single characters', () => {
  const pairs = tokens('周会改到下午')
  assert.ok(pairs.has('周会'))
  assert.ok(pairs.has('下午'))
  assert.ok(!pairs.has('周'), 'a single character is too weak a link')
  assert.ok(tokens('daily REPORT').has('daily'))
  assert.ok(tokens('daily REPORT').has('report'))
})

test('overlap is shared over the smaller side, so a short thread title can still match', () => {
  assert.equal(overlap(new Set(['a', 'b']), new Set(['a', 'b', 'c'])), 1)
  assert.equal(overlap(new Set(['a', 'b']), new Set(['a', 'c'])), 0.5)
  assert.equal(overlap(new Set(), new Set(['a'])), 0)
})

test('a thread comes back to the same topic a week later, on a shorter half-life it does not', () => {
  const thread = openThread({ id: 't1', text: '日报要不要改成五点半发', at: '2026-10-23T09:00:00Z' })
  const match = matchThread('日报五点半还是太早了', [thread], { now, halfLifeHours: 24 * 14 })
  assert.ok(match, 'the topic is the same, only the week is new')
  assert.equal(match.thread.id, 't1')
  const stale = matchThread('日报五点半还是太早了', [thread], { now, halfLifeHours: 6 })
  assert.equal(stale, null, 'a fast half-life forgets it')
})

test('decay halves a score over one half-life and never goes above one', () => {
  assert.equal(decay(0, 72), 1)
  assert.ok(Math.abs(decay(72, 72) - 0.5) < 1e-9)
  assert.ok(Math.abs(decay(144, 72) - 0.25) < 1e-9)
  assert.equal(decay(-5, 72), 1)
})

test('an unrelated message opens nothing instead of drifting into the closest thread', () => {
  const threads = [
    openThread({ id: 't1', text: '日报改成五点半发', at: '2026-10-30T08:00:00Z' }),
    openThread({ id: 't2', text: '会议室预订', at: '2026-10-30T08:10:00Z' }),
  ]
  assert.equal(matchThread('今天天气不错', threads, { now }), null)
})

test('the best of several threads wins', () => {
  const threads = [
    openThread({ id: 't1', text: '日报改成五点半发', at: '2026-10-30T08:00:00Z' }),
    openThread({ id: 't2', text: '日报和会议室', at: '2026-10-30T08:50:00Z' }),
  ]
  const match = matchThread('日报和会议室都定一下', threads, { now })
  assert.ok(match)
  assert.equal(match.thread.id, 't2', 'the more recent and closer thread wins')
})

test('a closed thread scores nothing', () => {
  const thread = { ...openThread({ id: 't1', text: '日报', at: '2026-10-30T08:00:00Z' }), closed: true }
  assert.equal(scoreThread('日报', thread, { now }), 0)
  assert.equal(matchThread('日报', [thread], { now }), null)
})

test('touching a thread adds the new words and moves its time', () => {
  const thread = openThread({ id: 't1', text: '日报', at: '2026-10-29T09:00:00Z' })
  const touched = touchThread(thread, { text: '日报要加一个回执', at: '2026-10-30T09:00:00Z' })
  assert.equal(touched.updatedAt, '2026-10-30T09:00:00.000Z')
  assert.equal(touched.messages, 1)
  assert.ok(touched.keywords.includes('回执'))
  assert.equal(thread.keywords.includes('回执'), false, 'the original record is not edited in place')
})

test('a title is one short line, and long text does not become a paragraph', () => {
  assert.equal(titleOf('  日报\n改成  五点半  '), '日报 改成 五点半')
  assert.equal(titleOf('甲'.repeat(40)).length, 25)
  assert.ok(titleOf('甲'.repeat(40)).endsWith('…'))
})

test('pruning keeps the newest threads and forgets the ancient ones', () => {
  const threads = [
    openThread({ id: 'old', text: '很久以前', at: '2026-06-01T09:00:00Z' }),
    openThread({ id: 'a', text: '昨天', at: new Date(now - day).toISOString() }),
    openThread({ id: 'b', text: '刚才', at: new Date(now - 60_000).toISOString() }),
  ]
  const kept = pruneThreads(threads, { now, max: 2 })
  assert.deepEqual(kept.map(thread => thread.id), ['b', 'a'])
})
