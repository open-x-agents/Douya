import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isRoutinePreference,
  isMemoryHighlight,
  memorySignal,
  rankMemories,
  partitionMemories,
} from '../src/digest/memory-rank.js'

test('routine timezone / UI prefs detected', () => {
  assert.equal(isRoutinePreference({ text: 'User timezone is Asia/Shanghai', tags: ['preference'] }), true)
  assert.equal(isRoutinePreference({ text: 'UI language is English', tags: 'preference' }), true)
  assert.equal(isRoutinePreference({ text: 'Shipped openDigitalMate logos fix', tags: ['achievement'] }), false)
  assert.equal(isRoutinePreference({ text: 'Prefer lean slices only', tags: ['decision'] }), false)
})

test('highlights prefer achievement over routine pin', () => {
  const achievement = { id: 2, text: 'Merged timetable Shanghai fix', tags: ['achievement'], pinned: false, updatedAt: 2 }
  const tz = { id: 1, text: 'User timezone is Asia/Shanghai', tags: ['preference'], pinned: true, updatedAt: 9 }
  assert.equal(isMemoryHighlight(achievement), true)
  assert.equal(isMemoryHighlight(tz), false)
  assert.ok(memorySignal(achievement) > memorySignal(tz))
  const ranked = rankMemories([tz, achievement])
  assert.equal(ranked[0].text, achievement.text)
  const { highlights, everyday } = partitionMemories([tz, achievement])
  assert.equal(highlights[0].text, achievement.text)
  assert.equal(everyday[0].text, tz.text)
})

test('pinned non-routine still leads', () => {
  const pin = { id: 1, text: 'Ship lean slices only', tags: ['decision'], pinned: true, updatedAt: 1 }
  const recent = { id: 2, text: 'Liked the Muse glass cards', tags: ['preference'], pinned: false, updatedAt: 9 }
  assert.equal(rankMemories([recent, pin])[0].id, 1)
})
