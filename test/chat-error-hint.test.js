import test from 'node:test'
import assert from 'node:assert/strict'
import { chatErrorHint } from '../src/web/muse-chat-core.js'

test('stale or unreadable Chief sessions get an actionable hint', () => {
  assert.match(chatErrorHint('session "session-9b67" not found'), /state\.json/)
  assert.match(chatErrorHint('resume failed: cannot safely transform unclassified message source; source v0 artifact'), /新建一个 Chief/)
  assert.match(chatErrorHint('no Main Bot'), /Chief/)
  assert.match(chatErrorHint('The Bot team file x could not be read (saved by a newer DS Bot; update DS Bot).'), /只读/)
  assert.equal(chatErrorHint('rate limited'), '')
})
