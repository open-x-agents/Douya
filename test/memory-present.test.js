import test from 'node:test'
import assert from 'node:assert/strict'
import {
  presentMemoryText,
  memoryLeadKind,
  isAchievementKind,
  memorySourceKey,
} from '../packages/dsh-muse-ui/memory-present.js'

test('presentMemoryText: markdown heading → title + summary', () => {
  const p = presentMemoryText('# soul.md - Who You Are\n\nYou are becoming someone.\n\n- Helpful\n- Resourceful')
  assert.equal(p.title, 'soul.md - Who You Are')
  assert.match(p.summary, /becoming someone/)
  assert.equal(p.long, false)
})

test('presentMemoryText: short one-liner stays title-only', () => {
  const p = presentMemoryText('Owner Danyang Chen ships lean Douya slices.')
  assert.equal(p.title, 'Owner Danyang Chen ships lean Douya slices.')
  assert.equal(p.summary, '')
  assert.equal(p.long, false)
})

test('presentMemoryText: long paragraph splits on sentence', () => {
  const p = presentMemoryText(
    'Shipped Memory Glimpse ranking for OpenDigitalMate. Achievements now surface before routine timezone prefs on tip 743877b Asia/Shanghai box test with extra verification notes that keep going for a while.',
  )
  assert.ok(p.title.length <= 72)
  assert.match(p.title, /Shipped Memory Glimpse|Achievements|OpenDigitalMate/i)
  assert.ok(p.summary.length > 0)
})

test('presentMemoryText: very long body marks long=true', () => {
  const body = 'Detail line. ' + 'word '.repeat(80)
  const p = presentMemoryText(`# Milestone ship\n\n${body}`)
  assert.equal(p.title, 'Milestone ship')
  assert.equal(p.long, true)
  assert.ok(p.summary.endsWith('…'))
})

test('memoryLeadKind / isAchievementKind', () => {
  assert.equal(memoryLeadKind(['achievement', 'project']), 'achievement')
  assert.equal(isAchievementKind('milestone'), true)
  assert.equal(isAchievementKind('preference'), false)
})

test('memorySourceKey: openviking uri vs local numeric id', () => {
  assert.equal(memorySourceKey({ source: 'openviking', uri: 'viking://~/memories/x.md' }), 'openviking')
  assert.equal(memorySourceKey({ id: 'viking://~/memories/y.md' }), 'openviking')
  assert.equal(memorySourceKey({ id: 12, text: 'x' }), 'local')
  assert.equal(memorySourceKey({ source: 'dsh-memory' }), 'local')
  assert.equal(memorySourceKey({ id: 'abc' }), 'unknown')
})
