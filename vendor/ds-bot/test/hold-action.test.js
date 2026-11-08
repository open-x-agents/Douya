import assert from 'node:assert/strict'
import { test } from 'node:test'
import { settleHoldAction } from '../src/client/hold-action.js'

test('a failed confirm or retry fulfills and keeps the host message', async () => {
  const rejections = []
  const onRejection = (error) => { rejections.push(error) }
  process.on('unhandledRejection', onRejection)
  try {
    const confirm = await settleHoldAction(() => Promise.reject(Object.assign(new Error('Could not save the binding'), { code: 'bot/save' })))
    const retry = await settleHoldAction(() => Promise.reject(Object.assign(new Error('Could not save the hold'), { code: 'bot/save' })))
    const saved = await settleHoldAction(() => Promise.resolve({ saved: true, delivered: false }))
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(confirm, { ok: false, message: 'Could not save the binding' })
    assert.deepEqual(retry, { ok: false, message: 'Could not save the hold' })
    assert.deepEqual(saved, { ok: true, message: '' })
    assert.deepEqual(rejections, [])
  } finally {
    process.off('unhandledRejection', onRejection)
  }
})
