import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../packages/dsh-muse-ui/static/index.html', import.meta.url), 'utf8')

test('a failed chat turn is kept locally and repainted with Retry after reload', () => {
  assert.match(html, /const FAILED_KEY = 'odm\.failedTurns'/)
  // both failure paths remember the message; a success forgets it
  assert.match(html, /typing\.remove\(\); rememberFailed\(msg, data\.text \|\| data\.error\)/)
  assert.match(html, /rememberFailed\(msg, err instanceof ChatFail/)
  assert.match(html, /forgetFailed\(msg\);\n\s+const b = appendInlineBubble\('bot'/)
  // history read paints them after the transcript, retry resends through the dock
  assert.match(html, /paintFailedTurns\(body, messages\);\n\s+stickTodayChat\(true\)/)
  assert.match(html, /forgetFailed\(f\.text\); dockPrompt\(f\.text\)/)
})
