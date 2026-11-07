import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DICTIONARY } from '../src/client/i18n.js'
import { OPEN_DETAIL, OPEN_RECOVERY } from '../src/client/open-error.js'
import { rosterGate } from '../src/client/roster-gate.js'

test('a team that loaded does not show the setup line or an open error', () => {
  assert.deepEqual(rosterGate({ ready: true, hasMain: true, loadError: 'gone' }), { kind: 'team' })
  assert.deepEqual(rosterGate({ ready: true, hasMain: false, loadError: 'gone' }), { kind: 'team' })
  assert.deepEqual(rosterGate({ ready: false, hasMain: true, loadError: 'gone' }), { kind: 'team' })
})

test('before the first state answer the sidebar still says it is setting up', () => {
  assert.deepEqual(rosterGate({ ready: false, hasMain: false }), { kind: 'setup' })
  assert.deepEqual(rosterGate({ ready: false, hasMain: false, loadError: '' }), { kind: 'setup' })
  assert.deepEqual(rosterGate({}), { kind: 'setup' })
})

test('a failed state pull before the team loads is an error, not the setup sentence', () => {
  const detail = 'gateway/service-unavailable'
  assert.deepEqual(rosterGate({ ready: false, hasMain: false, loadError: detail }), { kind: 'error', text: detail })
  assert.equal(DICTIONARY.zh[OPEN_DETAIL], '这个对话打不开。{detail}')
  assert.equal(DICTIONARY.zh[OPEN_RECOVERY], '会话文件恢复可读之后，请重启 DS Bot。刷新这个页面不会重新启动这次失败的进程。')
})

test('the chat alert is registered on the shell, not the session-only composer dock', () => {
  const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/client/index.js'), 'utf8')
  assert.match(index, /shell\.overlay', \{ id: 'bot-open-error'/)
  assert.match(index, /OpenErrorNotice/)
  assert.doesNotMatch(index, /OpenErrorDock|conversation\.input\.dock', \{ id: 'bot-open-error'/)
})

test('the open-error alert paints solid ink, not the pale shimmer', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/client/styles.js'), 'utf8')
  const dock = css.match(/\.bt-open-error\{[^}]+\}/)
  assert.ok(dock, 'conversation open-error rule')
  assert.match(dock[0], /color:var\(--bt-ink\)/)
  assert.doesNotMatch(dock[0], /color:transparent|background-clip|bt-shimmer/)
  const hint = css.match(/\.bt-hint\.bt-open-error\{[^}]+\}/)
  assert.ok(hint, 'sidebar open-error rule')
  assert.match(hint[0], /color:var\(--bt-ink\)/)
})
