import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cardSnapshotText, cardFull, cardItems } from '../src/web/card-snapshot.js'
import { breakdownFromRecords, summarizeTiming, progressLabel, ensureSessionCompat } from '../src/web/muse-chat-core.js'
import { tidyRepoCopy } from '../src/web/aggregation.js'

const FLYBOT = {
  id: 'cluster_github_ThinkFlowLab_FlyBot_1', source: 'github', type: 'project-cluster', status: 'active',
  title: 'CI gate signature fix in progress', body: 'ThinkFlowLab/FlyBot 过去 24h 主要在推进 CI gate 签名（Issue #2124 / PR #2309）。',
  url: 'https://github.com/ThinkFlowLab/FlyBot', nextAction: '先看「bug(ci): deleting the signature step…」的最新回复',
  blocks: [
    { type: 'tags', tags: [{ text: '进行中' }, { text: '3 件等别人' }] },
    { type: 'stat-row', stats: [{ label: '你开的 PR', value: 3 }, { label: '待解决 issue', value: 21 }] },
    { type: 'link-list', links: [
      { title: 'Re: [ThinkFlowLab/FlyBot] bug(ci): deleting the signature step from test.yml still passes (Issue #2124)', url: 'https://mail.google.com/mail/u/0/#inbox/a1', type: 'email-important' },
      { title: 'Re: [ThinkFlowLab/FlyBot] ci: the gate signature is a job of its own (PR #2309)', url: 'https://mail.google.com/mail/u/0/#inbox/a2', type: 'email-important' },
      { title: 'Re: [ThinkFlowLab/FlyBot] client: the Settings error list offers the remaining errors (PR #2268)', url: 'https://mail.google.com/mail/u/0/#inbox/a3', type: 'email-important' },
    ] },
  ],
}

test('card snapshot carries id, title, source, numbers, next step, link and every related item with its status', () => {
  const t = cardSnapshotText(FLYBOT, { 'https://mail.google.com/mail/u/0/#inbox/a3': { status: 'done' } })
  assert.match(t, /^【当前卡片】id=cluster_github_ThinkFlowLab_FlyBot_1 · 来源 github/)
  assert.match(t, /标题：CI gate signature fix in progress/)
  assert.match(t, /数字：.*你开的 PR 3.*待解决 issue 21/)
  assert.match(t, /下一步：先看/)
  assert.match(t, /相关条目（共 3 条，2 条待处理）/)
  assert.match(t, /1\. Re: \[ThinkFlowLab\/FlyBot\] bug\(ci\).*待处理.*#inbox\/a1/)
  assert.match(t, /3\. .*PR #2268.*已完成/)
  assert.ok(t.length < 2600, `snapshot stays small (${t.length})`)
})

test('snapshot includes Slack message text and sender; stays bounded with many items', () => {
  const links = Array.from({ length: 40 }, (_, i) => ({ title: `msg ${i}`, url: `https://x.slack.com/archives/C1/p${1793711011345569 + i}`, type: 'slack', from: 'opportunity-radar', at: '2026-11-03T14:00:00Z', replies: 2, text: `正文 ${i} `.repeat(80) }))
  const t = cardSnapshotText({ id: 's1', source: 'slack', type: 'slack-cluster', title: 'Slack', blocks: [{ type: 'link-list', links }] })
  assert.match(t, /来自 opportunity-radar · 11\/3 22:00 · 2 条回复/)
  assert.match(t, /内容：正文 0/)
  assert.match(t, /共 40 条.*列前 12 条/)
  assert.ok(t.length <= 2600)
  assert.equal(cardFull({ id: 's1', blocks: [{ type: 'link-list', links }] }).items.length, 40)
  assert.equal(cardItems(FLYBOT).length, 3)
})

test('turn breakdown from session records: first token, model vs tool time, retries', () => {
  const R = [
    { type: 'turn/end', time: 900 },
    { type: 'turn/start', time: 1000 },
    { type: 'step/start', time: 1010 }, { type: 'request/header', time: 1011, data: { header: { system: 'x'.repeat(100), tools: [{ a: 1 }, { b: 2 }] } } },
    { type: 'text-chunks', time: 3010 }, { type: 'tool/call', time: 3500, data: { name: 'odm_current_card' } },
    { type: 'tool/result', time: 3600 }, { type: 'step/end', time: 3600 },
    { type: 'llm/retry', time: 3700 },
    { type: 'step/start', time: 3601 }, { type: 'assistant/chunk', time: 5601 }, { type: 'step/end', time: 6601 },
    { type: 'turn/end', time: 6602 },
  ]
  const b = breakdownFromRecords(R, 995)
  const s = summarizeTiming({ ...b, recvAt: 500, contextAt: 505, promptAt: 990, detectedAt: 6700 })
  assert.equal(s.firstTokenMs, 2000)
  assert.equal(s.modelCalls, 2)
  assert.deepEqual(s.tools, [{ name: 'odm_current_card', ms: 100 }])
  assert.equal(s.modelMs, 2590 + 3000 - 100)
  assert.equal(s.retries, 1)
  assert.equal(s.turnEndToDetectMs, 98)
  assert.equal(s.toolCount, 2)
  assert.equal(s.queueToTurnStartMs, 10)
})

test('progress labels name the source being queried', () => {
  assert.equal(progressLabel('odm_github_get_issue'), '正在查 GitHub…')
  assert.equal(progressLabel('odm_gmail_fetch_emails'), '正在查邮件…')
  assert.equal(progressLabel('odm_slack_search_messages'), '正在查 Slack…')
  assert.equal(progressLabel('odm_current_card'), '正在看卡片…')
  assert.equal(progressLabel('bash'), '正在跑命令…')
})

test('Session.toolHistory compat is added only when missing, on the prototype, once', () => {
  class OldSession { deriveMessages() { return [] } }
  const s1 = new OldSession(), s2 = new OldSession()
  assert.equal(ensureSessionCompat(s1), true)
  assert.equal(typeof s2.toolHistory, 'function')
  assert.equal(s2.toolHistory(), undefined)
  assert.equal(ensureSessionCompat(s2), false)
  class NewSession { toolHistory() { return ['kept'] } }
  assert.equal(ensureSessionCompat(new NewSession()), false)
  assert.deepEqual(new NewSession().toolHistory(), ['kept'])
})

test('repo tile copy drops zero-count phrases but keeps real numbers', () => {
  const a = tidyRepoCopy('CI gate signature fix in progress, 0 reviews pending', 'ThinkFlowLab/FlyBot 过去 24h 合并了 0 个 PR，主要围绕 CI gate 签名（Issue #2124）推进；还有 0 个 PR 等待 review。')
  assert.equal(a.headline, 'CI gate signature fix in progress')
  assert.doesNotMatch(a.summary, /0 个/)
  assert.match(a.summary, /主要在推进 CI gate 签名/)
  const b = tidyRepoCopy('Shipped X, 2 reviews pending', 'r 过去 24h 合并了 3 个 PR，主要是 X；还有 2 个 PR 等待 review。')
  assert.equal(b.headline, 'Shipped X, 2 reviews pending')
  assert.match(b.summary, /合并了 3 个 PR.*2 个 PR 等待 review/)
})

test('stored repo tile with the repo-wide "157 PR" next step is repaired to a concrete related item', async () => {
  const { fixRepoCard } = await import('../src/web/repo-copy.js')
  const old = { ...FLYBOT, title: 'CI gate signature fix in progress, 0 reviews pending', body: 'ThinkFlowLab/FlyBot 过去 24h 合并了 0 个 PR，主要围绕 CI gate 签名推进；还有 0 个 PR 等待 review。', nextAction: '逐个推进 157 个 PR 的 review 与合并', actions: [{ label: '查看 157 个 PR', value: 'https://github.com/ThinkFlowLab/FlyBot/pulls', primary: true }] }
  const fixed = fixRepoCard(old)
  assert.doesNotMatch(JSON.stringify(fixed), /157|0 个 PR|0 reviews/)
  assert.match(fixed.nextAction, /^先看「bug\(ci\): deleting the signature step/)
  assert.equal(fixed.actions[0].label, '看 #2124 的最新进展')
  assert.deepEqual(fixRepoCard(fixed), fixed)
})
