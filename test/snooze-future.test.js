import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveSnoozeUntil } from '../src/web/card-ops.js'

const now = Date.parse('2026-11-08T01:57:00Z') // 09:57 Asia/Shanghai

test('snooze rejects a past or invalid until, keeps future ones and the hours default', () => {
  assert.throws(() => resolveSnoozeUntil({ until: '2026-11-08T09:00:00+08:00', now }), /not in the future \(now is 2026-11-08T09:57/)
  assert.throws(() => resolveSnoozeUntil({ until: 'tomorrow morning', now }), /not a date/)
  assert.equal(resolveSnoozeUntil({ until: '2026-11-09T09:00:00+08:00', now }), '2026-11-09T01:00:00.000Z')
  assert.equal(resolveSnoozeUntil({ hours: 2, now }), '2026-11-08T03:57:00.000Z')
  assert.equal(resolveSnoozeUntil({ now }), '2026-11-09T01:57:00.000Z')
})
