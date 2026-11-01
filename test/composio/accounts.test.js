// 按人授权：解析键是 (toolkit, userId)，四种状态 ok / missing / expired / ambiguous，
// `scope` 由一次子请求的 403 判出。纯函数，不联网、不要 key。
//
// 这里钉死三件真数据上会咬人的事：
//   - 别人的 ACTIVE 账号不是这个人的授权（gmail / slack 真数据就跨 3 个 user_id）；
//   - 同一 (toolkit,user) 有 2 个 ACTIVE 时**绝不静默挑一个**，必须 ambiguous；
//   - 403 少权限是 scope，不是 missing —— 账号是好的，别让人重连。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { authOf, authReasonOf, resolveAccount } from '../../src/sources/composio/accounts.js'

const fixture = JSON.parse(readFileSync(new URL('../fixtures/composio/accounts.json', import.meta.url), 'utf8'))
const accounts = fixture.accounts

test('one active account for this person is ok', () => {
  // slack 在 flybot-187b 名下 1 ACTIVE + 1 EXPIRED：ACTIVE 只要恰好一个就是 ok。
  const resolved = resolveAccount(accounts, { toolkit: 'slack', userId: 'flybot-187b' })
  assert.equal(resolved.state, 'ok')
  assert.equal(resolved.reason, null)
  assert.equal(resolved.account_id, 'ca_slack_flybot_1')
  assert.deepEqual(authOf(resolved), { ok: true, reason: null })
})

test('only an expired account is expired, not missing', () => {
  // notion / googlecalendar 今天各只有 1 个 EXPIRED 账号：说过期，不说没连。
  for (const toolkit of ['notion', 'googlecalendar']) {
    const resolved = resolveAccount(accounts, { toolkit, userId: 'default' })
    assert.equal(resolved.state, 'expired', `${toolkit} 应该是 expired`)
    assert.equal(resolved.reason, 'expired')
    assert.equal(resolved.account_id, null)
  }

  // 账号存在、但还没连好（INITIALIZING）不是 ok，也不算过期 —— 是「没连上」。
  const pending = resolveAccount(accounts, { toolkit: 'notion', userId: 'flybot-7743' })
  assert.equal(pending.state, 'missing')
  assert.equal(pending.reason, 'no-account')
})

test('two active accounts for one person are ambiguous and are never picked silently', () => {
  // gmail 在 default 名下 2 个 ACTIVE：挑错了就是拿别人的邮箱下结论，所以不给 id。
  const resolved = resolveAccount(accounts, { toolkit: 'gmail', userId: 'default' })
  assert.equal(resolved.state, 'ambiguous')
  assert.equal(resolved.reason, 'ambiguous')
  assert.equal(resolved.account_id, null)
  assert.deepEqual(authOf(resolved), { ok: false, reason: 'ambiguous' })
})

test('a 403 insufficient scope is scope, not missing', () => {
  const resolved = resolveAccount(accounts, { toolkit: 'slack', userId: 'flybot-187b' })
  assert.equal(resolved.state, 'ok') // 账号本身是好的：403 不改账号判定

  assert.equal(authReasonOf({
    status: 403,
    body: { error: { code: 'insufficient_permissions', message: 'insufficientPermissions' } },
  }), 'scope')
  assert.equal(authReasonOf({ status: 403, message: 'HTTP 403 insufficientPermissions' }), 'scope')
  assert.equal(authReasonOf({ statusCode: 403, body: { error: { code: 'insufficient_permissions', message: 'Missing scope: channels:read' } } }), 'scope')

  // 判不准就不猜：不是 403、或 403 但没说是权限，都不算 scope（调用方记 error/partial）。
  assert.equal(authReasonOf({ status: 500, message: 'insufficientPermissions' }), null)
  assert.equal(authReasonOf({ status: 429, message: 'rate limited' }), null)
  assert.equal(authReasonOf({ status: 403, message: 'forbidden by network policy' }), null)
  assert.equal(authReasonOf(new Error('boom')), null)
  assert.equal(authReasonOf(null), null)
})

test('no user id is no-person, an unknown person is no-account', () => {
  const noPerson = resolveAccount(accounts, { toolkit: 'gmail' })
  assert.equal(noPerson.state, 'missing')
  assert.equal(noPerson.reason, 'no-person')

  const noAccount = resolveAccount(accounts, { toolkit: 'gmail', userId: 'nobody' })
  assert.equal(noAccount.state, 'missing')
  assert.equal(noAccount.reason, 'no-account')

  // 空的账号表 / 不给表都不是 ok。
  assert.equal(resolveAccount([], { toolkit: 'gmail', userId: 'default' }).state, 'missing')
  assert.equal(resolveAccount(undefined, { toolkit: 'gmail', userId: 'default' }).reason, 'no-account')
  assert.equal(resolveAccount(accounts, { toolkit: 'myspace', userId: 'default' }).reason, 'no-account')
})

test('authOf folds the resolved state into the { ok, reason } shape the adapters take', () => {
  assert.deepEqual(authOf(resolveAccount(accounts, { toolkit: 'notion', userId: 'default' })), { ok: false, reason: 'expired' })
  assert.deepEqual(authOf(resolveAccount(accounts, { toolkit: 'notion', userId: 'flybot-7743' })), { ok: false, reason: 'missing' })
  assert.deepEqual(authOf({ state: 'scope', reason: 'scope', account_id: null }), { ok: false, reason: 'scope' })
  assert.deepEqual(authOf({ state: 'ok', reason: null, account_id: 'x' }), { ok: true, reason: null })
  // 适配器契约只认 { ok, reason } 两个键，多一个字段就可能被写进面板。
  assert.deepEqual(Object.keys(authOf({ state: 'ok', reason: null, account_id: 'x' })).sort(), ['ok', 'reason'])
})

test("accounts of other people and other apps never leak into this person's answer", () => {
  // default 在 gmail 上只有 2 个 ACTIVE（ambiguous）；flybot-7743 的 ACTIVE 不许借过来把它变成 ok。
  assert.equal(resolveAccount(accounts, { toolkit: 'gmail', userId: 'default' }).state, 'ambiguous')
  // flybot-187b 在 slack 上 ok，但他在 notion 上根本没有账号。
  assert.equal(resolveAccount(accounts, { toolkit: 'notion', userId: 'flybot-187b' }).reason, 'no-account')
  // 同一个 user 的别的 app 也不许串（linear 的 EXPIRED 不该让 gmail 变 expired）。
  assert.equal(resolveAccount(accounts, { toolkit: 'gmail', userId: 'flybot-7743' }).state, 'ok')
  // `composio:<toolkit>` 前缀与裸 slug 是同一个 app。
  assert.equal(resolveAccount(accounts, { toolkit: 'composio:notion', userId: 'default' }).state, 'expired')
  assert.equal(resolveAccount(accounts, { toolkit: 'composio:slack', userId: 'flybot-187b' }).state, 'ok')
})
