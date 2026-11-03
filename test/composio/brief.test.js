// 多源 brief（#32 S4）：10 条以上 fact、每条都能指回输入里的 ref、现成的 e2e 闸认这份 brief。
//
// 第 1 条用例证明「可追源」：ref 集合是从 fixture 的**回放 body** 推出来的，不经过适配器，
// 免得拿适配器的输出给自己作证。第 2、3 条用例复用 `test/e2e/real-model-checks.mjs` 的
// `judgePanel()`：给 3 条 fact 的面板视图必须过闸，给 10 条必须被 `E_FACT_COUNT` 拦住 ——
// 「10 条 fact 能直接过闸」是假的，闸只收 1–3 条。

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildBrief } from '../../src/sources/composio/brief.js'
import { createGmailAdapter } from '../../src/sources/composio/gmail.js'
import { createGoogleCalendarAdapter } from '../../src/sources/composio/googlecalendar.js'
import { createNotionAdapter } from '../../src/sources/composio/notion.js'
import { createSlackAdapter } from '../../src/sources/composio/slack.js'
import { judgePanel } from '../e2e/real-model-checks.mjs'
import {
  accountForOf,
  accountsOf,
  briefFromFixture,
  fixtureRefs,
  loadScenario,
  transportFor,
} from './helpers.mjs'

const loaded = loadScenario('all-ok')

// 输入侧（不是 brief 侧）的观察：面板视图的 `sources` 用它，追源断言用它。
async function observationsOfAll(scenario) {
  const accounts = accountsOf(scenario.scenario)
  const accountFor = accountForOf(accounts, scenario.scenario.userId)
  const transport = transportFor(scenario)
  const adapters = [
    createGmailAdapter({ account: accountFor('gmail'), transport }),
    createGoogleCalendarAdapter({ account: accountFor('googlecalendar'), transport }),
    createNotionAdapter({
      account: accountFor('notion'),
      transport,
      rootId: scenario.scenario.config.notion.rootId,
    }),
    createSlackAdapter({ account: accountFor('slack'), transport }),
  ]
  const observations = []
  for (const adapter of adapters) {
    const page = await adapter.list(scenario.scenario.since, undefined)
    observations.push(...page.observations)
  }
  return observations
}

test('ten facts from four apps all point at refs the input really has', async () => {
  const calls = []
  const { brief } = await briefFromFixture('all-ok', { calls })

  assert.ok(brief.facts.length >= 10, `facts 只有 ${brief.facts.length} 条`)
  assert.equal(brief.complete, true)
  assert.deepEqual(brief.unread_sources, [])
  assert.equal(brief.gap_text, '')
  assert.equal(brief.at, loaded.scenario.now)

  const inputRefs = fixtureRefs(loaded)
  const toolkits = new Set()
  for (const fact of brief.facts) {
    assert.match(fact.evidence_ref, /^composio:[a-z_]+:(thread|event|page|message|file)\/[A-Za-z0-9_.@/+~-]+$/)
    assert.ok(inputRefs.has(fact.evidence_ref), `facts 指出了输入里没有的 ref：${fact.evidence_ref}`)
    assert.ok(fact.evidence_ref.startsWith(`${fact.source}:`), `fact 的 source 与 ref 不一致：${fact.source}`)
    toolkits.add(fact.evidence_ref.split(':')[1])
  }
  assert.ok(toolkits.size >= 3, `只用到 ${toolkits.size} 个 app`)

  // 每个 app 一条 source 记录，key 就是 source id。
  for (const toolkit of ['gmail', 'googlecalendar', 'notion', 'slack']) {
    const record = brief.sources[`composio:${toolkit}`]
    assert.ok(record, `缺 source 记录 composio:${toolkit}`)
    assert.equal(record.state, 'ok')
    assert.equal(record.ok, true)
    assert.equal(record.partial, false)
    assert.equal(typeof record.account_id, 'string')
    assert.equal(record.latency_ms, 0, '注入的固定时钟下 latency 是 0')
  }
})

// issue #81 的用例名就是这一句；闸本身只收 1–3 条 fact，所以喂给它的是 brief 的**三 fact 面板视图**
// （10 条的 brief 过不了闸 —— 下一条用例证明这一点）。
test('the existing e2e gate accepts a composio brief', async () => {
  const { brief } = await briefFromFixture('all-ok')
  const observations = await observationsOfAll(loaded)

  const panel = {
    headline: '今天四路都通，三件事要动',
    advice: '先看评审',
    facts: brief.facts.slice(0, 3),
    unread_sources: brief.unread_sources,
  }
  const fixture = {
    sources: observations.map(observation => ({
      ref: observation.ref,
      source: observation.source,
      title: observation.title,
      excerpt: observation.excerpt,
    })),
    unreadable: [],
  }

  const { problems } = judgePanel({ panel, fixture, label: 'composio all-ok' })
  assert.deepEqual(problems, [], `闸报错：${JSON.stringify(problems)}`)
})

test('ten facts do not pass the same gate, which is why the view takes three', async () => {
  const { brief } = await briefFromFixture('all-ok')
  const observations = await observationsOfAll(loaded)

  const panel = {
    headline: '今天四路都通，三件事要动',
    advice: '先看评审',
    facts: brief.facts,
    unread_sources: brief.unread_sources,
  }
  const fixture = {
    sources: observations.map(observation => ({
      ref: observation.ref,
      source: observation.source,
      title: observation.title,
      excerpt: observation.excerpt,
    })),
    unreadable: [],
  }

  const { problems } = judgePanel({ panel, fixture, label: 'composio all-ok' })
  assert.ok(
    problems.some(problem => problem.code === 'E_FACT_COUNT'),
    `10 条 fact 也没被条数拦住：${JSON.stringify(problems)}`,
  )
})

test('a source that cannot be read is named in unread_sources and in gap_text', async () => {
  const { brief } = await briefFromFixture('drop-googlecalendar')

  assert.equal(brief.complete, false)
  assert.deepEqual(brief.unread_sources, ['composio:googlecalendar'])
  assert.match(brief.gap_text, /谷歌日历/)
  assert.ok(brief.facts.length > 0, '掉一个 app 时其它 app 照样进早报')
  assert.equal(brief.sources['composio:googlecalendar'].state, 'missing')
  assert.equal(brief.sources['composio:googlecalendar'].ok, false)
  assert.equal(brief.sources['composio:googlecalendar'].latency_ms, null, '没发请求就没有延迟')
})

test('the brief is built from the injected clock, never from the wall clock', async () => {
  const now = () => new Date('2026-01-01T00:00:00.000Z')
  const brief = await buildBrief({
    accountFor: () => ({ state: 'missing', reason: 'no-person', account_id: null }),
    now,
  })
  assert.equal(brief.at, '2026-01-01T00:00:00.000Z')
  assert.equal(brief.facts.length, 0)
  assert.equal(brief.complete, false)
  assert.equal(brief.sources['composio:gmail'].reason, 'no-person')
  assert.match(brief.gap_text, /没连上/)
})
