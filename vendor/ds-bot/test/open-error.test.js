import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DICTIONARY } from '../src/client/i18n.js'
import { OPEN_HTTP, OPEN_NETWORK, OPEN_RECOVERY, OPEN_UNAVAILABLE, classifyOpenError, openErrorView } from '../src/client/open-error-copy.js'
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
  assert.equal(DICTIONARY.zh[OPEN_RECOVERY], '会话文件恢复可读之后，请重启 DS Bot。刷新这个页面不会重新启动这次失败的进程。')
  assert.equal(DICTIONARY.zh[OPEN_HTTP], '这个对话打不开。请求失败（HTTP {status}）。')
  assert.equal(DICTIONARY.zh[OPEN_NETWORK], '这个对话打不开。网络没有连上。这个页面会继续尝试。')
  assert.equal(DICTIONARY.zh[OPEN_UNAVAILABLE], '这个对话打不开。')
})

test('startup failures name only the HTTP status and ask for a restart', () => {
  const leaked = 'EACCES: permission denied, open \'/home/box/.dsh-verify/sessions/session.v4.jsonl.zstd\''
  assert.deepEqual(classifyOpenError('请求失败（HTTP 404）'), { kind: 'startup', status: '404' })
  assert.deepEqual(classifyOpenError('HTTP 503'), { kind: 'startup', status: '503' })
  assert.deepEqual(classifyOpenError('gateway/service-unavailable'), { kind: 'startup' })
  const view = openErrorView('请求失败（HTTP 404）')
  assert.equal(view.restart, true)
  assert.equal(view.text, 'Could not open this chat. The server returned HTTP 404.')
  assert.equal(view.text.includes(leaked), false)
  const hidden = openErrorView(leaked)
  assert.equal(hidden.restart, false)
  assert.equal(hidden.text, 'Could not open this chat.')
  assert.equal(hidden.text.includes('/home/box'), false)
  assert.equal(hidden.text.includes('session.v4'), false)
})

test('a dropped connection keeps trying and does not ask for a restart', () => {
  const view = openErrorView('连不上 DSH，请确认它还在运行。')
  assert.equal(view.restart, false)
  assert.equal(view.text, 'Could not open this chat. The connection failed. This page will keep trying.')
  assert.equal(openErrorView('Could not reach DSH. Check that it is still running.').restart, false)
  assert.equal(openErrorView('HTTP 500').restart, false)
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
