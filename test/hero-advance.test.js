// Regression: the hero kept showing 「审 FlyBot #2353」 (按安排，现在) after its card was done — suggested blocks were
// picked by time only. A block whose cards are no longer open work, or that the user marked done, must be skipped.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { pickNextThing, blockResolved, blockDoneKey } from '../src/web/card-prep.js'

const now = new Date(2026, 10, 4, 20, 5)
const pr = (over = {}) => ({ id: 'flybot', type: 'project-cluster', source: 'github', title: 'FlyBot', priority: 'high', waiting: 'others', status: 'active',
  blocks: [{ type: 'link-list', links: [{ title: '#2353', url: 'https://github.com/o/FlyBot/pull/2353', type: 'pr-review' }] }], ...over })
const tt = blocks => ({ id: 'tt', type: 'timetable', status: 'active', blocks: [{ type: 'timetable', fixedBlocks: [], suggestedBlocks: blocks }] })
const plan = [
  { start: '20:00', end: '20:20', title: '审 FlyBot #2353', category: 'review', cardIds: ['flybot'] },
  { start: '20:20', end: '20:30', title: '收尾小事', category: 'admin' },
  { start: '20:30', end: '21:30', title: '休息放松', category: 'break' },
]

test('current block shows while its card is still open', () => {
  const nx = pickNextThing({ cards: [pr(), tt(plan)], now })
  assert.equal(nx.kind, 'block'); assert.equal(nx.title, '审 FlyBot #2353'); assert.match(nx.why, /^现在/)
  assert.equal(nx.buttons[0].kind, 'blockdone'); assert.equal(nx.buttons[0].label, '完成了')
  assert.equal(nx.blockKey, blockDoneKey(plan[0], now))
})
test('card done / removed from Today → hero advances to the next block', () => {
  for (const cards of [[tt(plan)], [pr({ status: 'done' }), tt(plan)], [pr({ status: 'snoozed' }), tt(plan)], [pr({ status: 'merged' }), tt(plan)]]) {
    const nx = pickNextThing({ cards, now })
    assert.equal(nx.kind, 'block'); assert.equal(nx.title, '收尾小事'); assert.match(nx.why, /^接下来 20:20/); assert.equal(nx.live, false); assert.equal(nx.live, false)
  }
})
test('every item on the card handled (reviewed / merged / closed) → block resolved', () => {
  const itemStatus = { 'https://github.com/o/FlyBot/pull/2353': { status: 'done', by: 'user' } }
  assert.equal(blockResolved(plan[0], { cards: [pr()], itemStatus, now }), true)
  assert.equal(pickNextThing({ cards: [pr(), tt(plan)], itemStatus, now }).title, '收尾小事')
})
test('user marked the block done from the hero → advances, and survives a re-plan with shifted times', () => {
  const doneBlocks = [blockDoneKey(plan[0], now)]
  assert.equal(pickNextThing({ cards: [pr(), tt(plan)], doneBlocks, now }).title, '收尾小事')
  const replanned = [{ ...plan[0], start: '20:02', end: '20:25', cardIds: ['flybot_new'] }, ...plan.slice(1)]
  assert.equal(pickNextThing({ cards: [pr({ id: 'flybot_new' }), tt(replanned)], doneBlocks, now }).title, '收尾小事')
})
test('a block with no cards is only resolved by the user', () => {
  assert.equal(blockResolved(plan[1], { cards: [], now }), false)
  assert.equal(blockResolved(plan[1], { cards: [], doneBlocks: [blockDoneKey(plan[1], now)], now }), true)
})
test('all remaining blocks done → all-done state, not a stale block', () => {
  const doneBlocks = plan.map(b => blockDoneKey(b, now))
  const nx = pickNextThing({ cards: [tt(plan)], doneBlocks, now })
  assert.equal(nx.kind, 'none'); assert.equal(nx.title, '今天的安排都做完了')
})
test('server passes the done-block ledger; route + hero button are wired', () => {
  const api = fs.readFileSync(new URL('../src/web/api.js', import.meta.url), 'utf8')
  const routes = fs.readFileSync(new URL('../src/web/dsh-host-routes.js', import.meta.url), 'utf8')
  const html = fs.readFileSync(new URL('../src/client/index.html', import.meta.url), 'utf8')
  assert.match(api, /pickNextThing\(\{ cards: activeCards, itemStatus: state\.itemStatus \|\| \{\}, doneBlocks: state\.timetableDone \|\| \[\] \}\)/)
  assert.match(api, /async timetableBlockDone\(/)
  assert.match(routes, /path: '\/api\/opendigitalmate\/timetable-block'/)
  assert.match(html, /nx\.kind === 'block' \? \(nx\.live === false \? '按安排，接下来' : '按安排，现在'\)/)
  assert.match(html, /nx\.kind === 'block' \? \(nx\.live === false \? '按安排，接下来' : '按安排，现在'\)/)
  assert.match(html, /if \(step\.kind === 'blockdone'\) \{ await markBlockDone\(step, btn\); return; \}/)
  assert.match(html, /function markBlockDone[\s\S]{0,900}label: '撤销'[\s\S]{0,200}loadToday\(\{ force: true \}\)/)
})
