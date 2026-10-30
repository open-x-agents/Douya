import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveSendMode } from '../src/shared/send-mode.js'

test('explicit mode wins over running state', () => {
  assert.equal(resolveSendMode({ requested: 'queue', running: true }), 'queue')
  assert.equal(resolveSendMode({ requested: 'steer', running: false }), 'steer')
})

test('idle Session defaults to queue', () => {
  assert.equal(resolveSendMode({ running: false }), 'queue')
  assert.equal(resolveSendMode({}), 'queue')
})

test('running Session defaults to steer so busy follow-ups can join', () => {
  assert.equal(resolveSendMode({ running: true }), 'steer')
  assert.equal(resolveSendMode({ requested: undefined, running: true }), 'steer')
})

test('unknown requested values are ignored', () => {
  assert.equal(resolveSendMode({ requested: 'followup', running: true }), 'steer')
  assert.equal(resolveSendMode({ requested: 'followup', running: false }), 'queue')
})
