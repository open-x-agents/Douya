import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bufferKey, createInputBuffer, mergeTexts } from '../src/host/buffer.js'

// A clock a test can move, with the same schedule/cancel contract setTimeout has.
function fakeClock(start = Date.parse('2026-10-30T09:00:00Z')) {
  let now = start
  let nextId = 1
  const timers = new Map()
  return {
    now: () => now,
    schedule: (fn, ms) => {
      const id = nextId++
      timers.set(id, { fn, at: now + ms })
      return id
    },
    cancel: id => timers.delete(id),
    advance(ms) {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id)
          timer.fn()
        }
      }
    },
    open: () => timers.size,
  }
}

function setup(options = {}) {
  const clock = fakeClock()
  const flushed = []
  const buffer = createInputBuffer({ now: clock.now, schedule: clock.schedule, cancel: clock.cancel, onFlush: voice => flushed.push(voice), ...options })
  return { clock, flushed, buffer }
}

const line = (text, extra = {}) => ({ chatId: 'c1', senderId: 'u1', text, ...extra })

test('four lines typed in a row become one turn', () => {
  const { clock, flushed, buffer } = setup()
  buffer.push(line('在吗'))
  buffer.push(line('有个事'))
  buffer.push(line('日报那个'))
  buffer.push(line('能不能改成五点半发'))
  assert.equal(flushed.length, 0, 'nothing goes out while the person is still typing')
  clock.advance(3000)
  assert.equal(flushed.length, 1)
  assert.equal(flushed[0].text, '在吗\n有个事\n日报那个\n能不能改成五点半发')
  assert.equal(flushed[0].merged, true)
  assert.equal(flushed[0].messages.length, 4)
})

test('one line on its own is not marked as merged', () => {
  const { clock, flushed, buffer } = setup()
  buffer.push(line('明天几点开会'))
  clock.advance(3000)
  assert.equal(flushed[0].merged, false)
  assert.equal(flushed[0].text, '明天几点开会')
})

test('the window slides while the person keeps typing', () => {
  const { clock, flushed, buffer } = setup()
  buffer.push(line('一'))
  clock.advance(2000)
  buffer.push(line('二'))
  clock.advance(2000)
  assert.equal(flushed.length, 0, 'a second line restarts the window')
  clock.advance(1100)
  assert.equal(flushed.length, 1)
  assert.equal(flushed[0].text, '一\n二')
})

test('the same line sent twice is one thought', () => {
  assert.equal(mergeTexts([{ text: '在吗' }, { text: '在吗' }, { text: ' 在吗 ' }, { text: '在' }]), '在吗\n在')
  assert.equal(mergeTexts([]), '')
})

test('two people talking in the same chat do not merge into one turn', () => {
  const { clock, flushed, buffer } = setup()
  buffer.push(line('我先说', { senderId: 'u1' }))
  buffer.push(line('我也说一个', { senderId: 'u2' }))
  clock.advance(3000)
  assert.equal(flushed.length, 2)
  assert.deepEqual(flushed.map(voice => voice.senderId).sort(), ['u1', 'u2'])
})

test('a person who keeps typing for a while is cut off at the ceiling instead of never sending', () => {
  const { clock, flushed, buffer } = setup({ windowMs: 5000, maxWindowMs: 9000 })
  buffer.push(line('一'))
  clock.advance(4000)
  buffer.push(line('二'))
  clock.advance(4000)
  buffer.push(line('三'))
  clock.advance(1000)
  buffer.push(line('四'))
  assert.equal(flushed.length, 1, 'the ceiling flushes what was typed so far, newest line included')
  assert.equal(flushed[0].text, '一\n二\n三\n四')
  clock.advance(5000)
  assert.equal(flushed.length, 1, 'nothing is left holding a second window open')
})

test('flushing an empty key returns nothing instead of an empty turn', () => {
  const { flushed, buffer } = setup()
  assert.equal(buffer.flush(bufferKey({ chatId: 'c1', senderId: 'u1' })), null)
  assert.equal(flushed.length, 0)
})

test('stop drops what is pending, so a plugin unload does not send half a thought later', () => {
  const { clock, flushed, buffer } = setup()
  buffer.push(line('说到一半'))
  buffer.stop()
  clock.advance(5000)
  assert.equal(flushed.length, 0)
  assert.equal(buffer.size(), 0)
})
