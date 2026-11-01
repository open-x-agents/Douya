// 3 秒预算（#32 S4）：一个 app 挂住，只让**它**变成 partial，其它 app 照常进早报。
//
// 这里用假时钟，不等真的 3 秒：
//   - `now()` 返回 `t`；
//   - `schedule(fn, ms)` 用真实的 `setTimeout(..., 0)`，回调里先 `t += ms` 再 `fn()`；
//   - 快 app 的 Promise 在微任务里先完成，`runWithBudget` 会 `cancel()` 掉它们的定时器，
//     所以只有挂住的 notion 真的触发超时、也只有它让 `t` 前进 3000。

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildBrief, COMPOSIO_TIMEOUT_MS } from '../../src/sources/composio/brief.js'
import { registry } from '../../src/sources/composio/registry.js'
import { accountForOf, accountsOf, loadScenario, transportFor } from './helpers.mjs'

const loaded = loadScenario('all-ok')

function hangingAdapter(toolkit) {
  return {
    id: `composio:${toolkit}`,
    readScope: 'metadata',
    auth: () => ({ ok: true, reason: null }),
    list: () => new Promise(() => {}),
    get: () => null,
  }
}

test('the composio budget is three seconds', () => {
  assert.equal(COMPOSIO_TIMEOUT_MS, 3000)
})

test('an app that hangs past three seconds is partial and the others still make the brief', async () => {
  let t = 0
  const now = () => new Date(t)
  // 定时器不回 unref：挂住的 promise 本身不让事件循环活着，超时定时器必须让它活着，
  // 否则 node --test 会把这条用例判成「事件循环空了、promise 还挂着」。
  const schedule = (fn, ms) => {
    const timer = setTimeout(() => {
      t += ms
      fn()
    }, 0)
    return { timer, unref: undefined }
  }

  const accounts = accountsOf(loaded.scenario)
  const brief = await buildBrief({
    registry,
    accountFor: accountForOf(accounts, loaded.scenario.userId),
    transport: transportFor(loaded),
    config: loaded.scenario.config,
    since: loaded.scenario.since,
    now,
    schedule,
    cancel: handle => clearTimeout(handle.timer),
    adapters: { notion: () => hangingAdapter('notion') },
  })

  const hung = brief.sources['composio:notion']
  assert.equal(hung.partial, true)
  assert.equal(hung.reason, 'timeout')
  assert.equal(hung.ok, false)
  assert.equal(hung.latency_ms, 3000, '延迟由注入的 now() 量出来，不是墙上时钟')

  for (const toolkit of ['gmail', 'googlecalendar', 'slack']) {
    assert.equal(brief.sources[`composio:${toolkit}`].ok, true, `${toolkit} 应该照常 ok`)
    assert.equal(brief.sources[`composio:${toolkit}`].partial, false)
  }

  assert.equal(brief.complete, false)
  assert.deepEqual(brief.unread_sources, ['composio:notion'])
  assert.match(brief.gap_text, /Notion/)
  assert.ok(brief.facts.length > 0, '挂住一个 app 不影响其它 app 出事实')
  for (const fact of brief.facts) assert.doesNotMatch(fact.evidence_ref, /^composio:notion:/)
})

test('an error in one app is partial too, not a dead brief', async () => {
  const failing = {
    id: 'composio:notion',
    readScope: 'metadata',
    auth: () => ({ ok: true, reason: null }),
    list: () => {
      throw new Error('boom')
    },
    get: () => null,
  }

  const accounts = accountsOf(loaded.scenario)
  const brief = await buildBrief({
    registry,
    accountFor: accountForOf(accounts, loaded.scenario.userId),
    transport: transportFor(loaded),
    config: loaded.scenario.config,
    since: loaded.scenario.since,
    adapters: { notion: () => failing },
  })

  assert.equal(brief.sources['composio:notion'].partial, true)
  assert.equal(brief.sources['composio:notion'].reason, 'error')
  assert.ok(brief.facts.length > 0)
  assert.equal(brief.sources['composio:gmail'].ok, true)
})
