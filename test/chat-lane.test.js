import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createChatLane, combineRequests, MERGE_NOTE } from '../src/web/chat-lane.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

// A fake Chief: one session, answers "回复：<what it was told>" for each turn; follow-ups steered in
// before the reply are part of the same answer.
function fakeChief({ latency = 60 } = {}) {
  const turns = []
  const run = async (req, hooks) => {
    const heard = [req.message]
    hooks.setSteer(async (more) => { heard.push(more) })
    await sleep(latency)
    hooks.closeSteer()
    const text = `回复：${heard.join(' + ')}`
    turns.push(heard)
    return { ok: true, status: 'answered', text }
  }
  return { run, turns }
}

test('rapid double send → one turn, one reply covering both; the first request is marked merged', async () => {
  const chief = fakeChief()
  const lane = createChatLane({ run: chief.run, windowMs: 50 })
  const a = lane.submit({ message: 'A: 我最喜欢的颜色是绿色', turn: 't_a' })
  await sleep(10)
  const b = lane.submit({ message: 'B: 我最喜欢的水果是芒果', turn: 't_b' })
  const [ra, rb] = await Promise.all([a, b])
  assert.equal(ra.status, 'merged')
  assert.equal(ra.mergedInto, 't_b')
  assert.equal(rb.status, 'answered')
  assert.equal(rb.mergedCount, 2)
  assert.equal(chief.turns.length, 1)
  assert.match(rb.text, /绿色/)
  assert.match(rb.text, /芒果/)
  assert.ok(rb.text.includes(MERGE_NOTE))
})

test('a follow-up while the turn is in flight steers into it → still one reply covering both', async () => {
  const chief = fakeChief({ latency: 120 })
  const lane = createChatLane({ run: chief.run, windowMs: 0 })
  const a = lane.submit({ message: 'A', turn: 't_a' })
  await sleep(30) // A is already prompted
  const b = lane.submit({ message: 'B', turn: 't_b' })
  const [ra, rb] = await Promise.all([a, b])
  assert.equal(ra.status, 'merged')
  assert.equal(rb.text, '回复：A + B')
  assert.equal(chief.turns.length, 1)
})

test('send after the reply finished → a normal separate turn', async () => {
  const chief = fakeChief()
  const lane = createChatLane({ run: chief.run, windowMs: 20 })
  const ra = await lane.submit({ message: 'A', turn: 't_a' })
  const rb = await lane.submit({ message: 'B', turn: 't_b' })
  assert.equal(ra.text, '回复：A')
  assert.equal(rb.text, '回复：B')
  assert.equal(chief.turns.length, 2)
})

test('never two overlapping turns; a message after the steer window closes gets its own reply', async () => {
  let running = 0, maxRunning = 0
  const seen = []
  const run = async (req, hooks) => {
    running++; maxRunning = Math.max(maxRunning, running)
    await sleep(40)
    running--
    seen.push(req.message)
    return { ok: true, status: 'answered', text: `回复：${req.message}` }
  }
  const lane = createChatLane({ run, windowMs: 0 }) // this run never opens steering
  const a = lane.submit({ message: 'A', turn: 't_a' })
  await sleep(10)
  const b = lane.submit({ message: 'B', turn: 't_b' })
  const [ra, rb] = await Promise.all([a, b])
  assert.equal(maxRunning, 1)
  assert.equal(ra.text, '回复：A') // each reply maps to the message it answers
  assert.equal(rb.text, '回复：B')
})

test('different conversations (dock vs card) are serialized but not merged', async () => {
  const chief = fakeChief()
  const lane = createChatLane({ run: chief.run, windowMs: 30 })
  const a = lane.submit({ message: 'dock', turn: 't_a' })
  const b = lane.submit({ message: 'card', cardId: 'c1', turn: 't_b' })
  const [ra, rb] = await Promise.all([a, b])
  assert.equal(ra.text, '回复：dock')
  assert.equal(rb.text, '回复：card')
})

test('a failed steer falls back to its own turn and both callers still get an answer', async () => {
  const turns = []
  const run = async (req, hooks) => {
    hooks.setSteer(async () => { throw new Error('nope') })
    await sleep(50)
    hooks.closeSteer()
    turns.push(req.message)
    return { ok: true, status: 'answered', text: `回复：${req.message}` }
  }
  const lane = createChatLane({ run, windowMs: 0 })
  const a = lane.submit({ message: 'A', turn: 't_a' })
  await sleep(10)
  const b = lane.submit({ message: 'B', turn: 't_b' })
  const [ra, rb] = await Promise.all([a, b])
  assert.equal(ra.text, '回复：A')
  assert.equal(rb.text, '回复：B')
  assert.deepEqual(turns, ['A', 'B'])
})

test('combineRequests keeps the latest context and concatenates attachments', () => {
  const c = combineRequests([
    { message: 'one', viewContext: 'v1', attachments: [{ kind: 'image', name: 'a.png' }] },
    { message: 'two', viewContext: 'v2', attachments: [{ kind: 'file', name: 'b.txt' }] },
  ])
  assert.equal(c.viewContext, 'v2')
  assert.equal(c.attachments.length, 2)
  assert.match(c.message, /1\. one\n2\. two/)
})
