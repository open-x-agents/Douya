// 撤销授权（#32 S4，验收 6）：notion 的账号被撤销后，第二次跑必须是 `missing`，
// 而且早报不空 —— 其它三个 app 照样出事实，缺的那个在 `unread_sources` 与 `gap_text` 里点名。

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildBrief } from '../../src/sources/composio/brief.js'
import {
  accountForOf,
  accountsOf,
  fixtureRegistry,
  loadScenario,
  transportFor,
} from './helpers.mjs'

const loaded = loadScenario('all-ok')

function briefWith(accounts) {
  return buildBrief({
    registry: fixtureRegistry(loaded),
    accountFor: accountForOf(accounts, loaded.scenario.userId),
    transport: transportFor(loaded),
    config: loaded.scenario.config,
    since: loaded.scenario.since,
    now: () => new Date(loaded.scenario.now),
  })
}

test('after a revoke the next run says missing and the brief still carries the other apps', async () => {
  const accounts = accountsOf(loaded.scenario)

  const first = await briefWith(accounts)
  assert.equal(first.sources['composio:notion'].state, 'ok')
  assert.equal(first.sources['composio:notion'].ok, true)
  assert.ok(first.facts.length > 0)
  assert.deepEqual(first.unread_sources, [])

  // 撤销 = 这个人名下不再有 notion 的 ACTIVE 账号（账号被删掉或变成 EXPIRED）。
  const revoked = accounts.filter(account => account?.toolkit?.slug !== 'notion')

  const second = await briefWith(revoked)
  assert.equal(second.sources['composio:notion'].state, 'missing')
  assert.equal(second.sources['composio:notion'].reason, 'no-account')
  assert.equal(second.sources['composio:notion'].account_id, null)
  assert.ok(second.facts.length > 0, '掉了 notion 也照样有早报')
  assert.ok(second.unread_sources.includes('composio:notion'))
  assert.match(second.gap_text, /Notion/)
  assert.match(second.gap_text, /邮件/)

  // 其它三个 app 一条不少。
  for (const toolkit of ['gmail', 'googlecalendar', 'slack']) {
    assert.equal(second.sources[`composio:${toolkit}`].ok, true, `${toolkit} 不该受影响`)
  }
})

test('an expired account is expired, not missing, and it still names the app', async () => {
  const accounts = accountsOf(loaded.scenario).map(account =>
    account?.toolkit?.slug === 'notion' ? { ...account, status: 'EXPIRED' } : account,
  )

  const brief = await briefWith(accounts)
  assert.equal(brief.sources['composio:notion'].state, 'expired')
  assert.equal(brief.sources['composio:notion'].reason, 'expired')
  assert.ok(brief.facts.length > 0)
  assert.ok(brief.unread_sources.includes('composio:notion'))
  assert.match(brief.gap_text, /重新授权/)
})
