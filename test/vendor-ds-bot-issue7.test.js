import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { applyRoomStreamFrame, clearDraftIfPosted, draftForDisplay } from '../vendor/ds-bot/src/shared/room-draft.js'
import { resolveSendMode } from '../vendor/ds-bot/src/shared/send-mode.js'
import { PANEL_PAGE_ROUTE, PANEL_ROUTE } from '../src/host/constants.js'

test('vendored ds-bot wires group live draft + busy steer', () => {
  assert.equal(existsSync('vendor/ds-bot/src/shared/room-draft.js'), true)
  const groups = readFileSync('vendor/ds-bot/src/host/groups.js', 'utf8')
  assert.match(groups, /applyRoomStreamFrame/)
  assert.match(groups, /agent\/assistant-stream/)
  const channel = readFileSync('vendor/ds-bot/src/host/channel.js', 'utf8')
  assert.match(channel, /clearDraftIfPosted/)
  assert.match(channel, /draft \? \{ draft \}/)
  assert.match(channel, /resolveSendMode/)
  const cells = readFileSync('vendor/ds-bot/src/client/cells.js', 'utf8')
  assert.match(cells, /draftForDisplay/)
  assert.match(cells, /streaming: true/)
  const client = readFileSync('vendor/ds-bot/client.js', 'utf8')
  assert.match(client, /draftForDisplay/)
})

test('room draft stream/finalize helpers and panel /api path', () => {
  let draft = applyRoomStreamFrame(undefined, { type: 'start', attemptId: 'a' }, { botId: 'b' })
  draft = applyRoomStreamFrame(draft, { type: 'chunk', attemptId: 'a', chunk: { type: 'text-delta', text: 'hi' } }, { botId: 'b' })
  assert.equal(draft.text, 'hi')
  assert.equal(clearDraftIfPosted(draft, [{ botId: 'b', text: 'hi' }]), undefined)
  assert.equal(draftForDisplay(draft, [{ botId: 'b', text: 'hi there' }]), undefined)
  assert.equal(resolveSendMode({ running: true }), 'steer')
  assert.equal(PANEL_ROUTE.startsWith('/api/'), true)
  assert.equal(PANEL_PAGE_ROUTE.startsWith('/api/'), true)
})
