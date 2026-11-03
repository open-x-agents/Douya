import assert from 'node:assert/strict'
import { test } from 'node:test'
import { slackToMd, buildSlackCopy, selfSlackIds } from '../src/web/slack-cards.js'

const it = (ts, user, text, extra = {}) => ({
  source: 'slack', url: `https://w.slack.com/archives/C1/p${ts.replace('.', '')}`,
  metadata: { channelId: 'C1', channelName: 'dev', ts, user, userId: extra.userId || `U_${user}`, text, isBot: !!extra.isBot, isDm: !!extra.isDm, threadTs: extra.threadTs || null },
})

test('slack mrkdwn becomes safe markdown', () => {
  const md = slackToMd('Hi <@U1|ann> see <https://x.io/a|the doc> and <https://y.io> *now* &amp; <!here>', {})
  assert.equal(md, 'Hi @ann see [the doc](https://x.io/a) and https://y.io **now** & @here')
})

test('mentions of me drive the summary and next step; every message is kept', () => {
  const items = [
    it('100.1', 'Bob', 'deploy done'),
    it('101.1', 'Ann', 'hey <@UME> can you review the plan?'),
    it('102.1', 'Danyang Chen', 'thanks', { userId: 'UME' }),
    it('103.1', 'Bob', 'reply in thread', { threadTs: '100.1' }),
  ]
  const ids = selfSlackIds(items, ['Danyang Chen'])
  assert.deepEqual(ids, ['UME'])
  const c = buildSlackCopy(items, { selfNames: ['Danyang Chen'], selfIds: ids })
  assert.equal(c.msgs.length, 4)
  assert.equal(c.needCount, 1)
  assert.match(c.nextAction, /^回复 Ann：/)
  assert.equal(c.waiting, 'you')
  const ann = c.msgs.find(m => m.from === 'Ann')
  assert.match(ann.text, /@Danyang Chen can you review/)
  assert.equal(c.msgs.find(m => m.title === 'deploy done').replies, 1)
  assert.ok(c.msgs.every(m => m.url && m.at && m.from))
})

test('bot-only channel says so and never says 打开频道', () => {
  const c = buildSlackCopy([it('1.1', 'radar', 'Opportunity Radar · *Agent skill* for X', { isBot: true }), it('2.1', 'radar', 'Opportunity Radar · Y', { isBot: true })])
  assert.equal(c.waiting, 'fyi')
  assert.match(c.body, /自动推送/)
  assert.doesNotMatch(c.nextAction, /打开/)
})
