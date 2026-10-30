import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { test } from 'node:test'
import { resolveSendMode } from '../vendor/ds-bot/src/shared/send-mode.js'
import { applyRoomStreamFrame, clearDraftIfPosted } from '../vendor/ds-bot/src/shared/room-draft.js'

test('vendored ds-bot is present with issue #3 helpers', () => {
  assert.equal(existsSync('vendor/ds-bot/package.json'), true)
  assert.equal(existsSync('vendor/ds-bot/VENDOR_FROM'), true)
  const channel = readFileSync('vendor/ds-bot/src/host/channel.js', 'utf8')
  assert.match(channel, /resolveSendMode/)
  assert.doesNotMatch(channel, /mode: 'queue',\n\s*content:/)
  const cells = readFileSync('vendor/ds-bot/src/client/cells.js', 'utf8')
  assert.match(cells, /streaming/)
  assert.match(cells, /draftForDisplay/)
})

test('send mode and room draft helpers behave as issue #3 requires', () => {
  assert.equal(resolveSendMode({ running: true }), 'steer')
  assert.equal(resolveSendMode({ requested: 'queue', running: true }), 'queue')
  let draft = applyRoomStreamFrame(undefined, { type: 'start', attemptId: 'x' }, { botId: 'b' })
  draft = applyRoomStreamFrame(draft, { type: 'chunk', attemptId: 'x', chunk: { type: 'text-delta', text: 'live' } }, { botId: 'b' })
  assert.equal(draft.text, 'live')
  assert.equal(clearDraftIfPosted(draft, [{ botId: 'b', text: 'live' }]), undefined)
})
