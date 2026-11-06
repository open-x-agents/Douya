import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auxSources } from '../src/digest/runner.js'

test('calendar is read through the newest ACTIVE account', () => {
  const aux = auxSources([
    { id: 'ca_old', status: 'EXPIRED', toolkit: { slug: 'googlecalendar' }, updated_at: '2026-10-31' },
    { id: 'ca_a', status: 'ACTIVE', toolkit: { slug: 'googlecalendar' }, updated_at: '2026-11-04T06:43:00Z' },
    { id: 'ca_b', status: 'ACTIVE', toolkit: { slug: 'googlecalendar' }, updated_at: '2026-11-04T06:48:00Z' },
    { id: 'gm', status: 'ACTIVE', toolkit: { slug: 'gmail' } },
  ])
  assert.equal(aux.googlecalendar.account.id, 'ca_b')
  assert.equal(aux.googlecalendar.label, '日历')
  assert.equal(aux.gmail, undefined) // gmail has its own source bot
})

test('a connected-but-broken source shows as failed with the reason instead of vanishing', () => {
  const aux = auxSources([
    { id: 'c1', status: 'EXPIRED', toolkit: { slug: 'googlecalendar' } },
    { id: 's1', status: 'INITIATED', toolkit: { slug: 'slack' } },
  ])
  assert.equal(aux.googlecalendar.status, 'failed'); assert.match(aux.googlecalendar.error, /EXPIRED/)
  assert.equal(aux.slack.status, 'failed'); assert.match(aux.slack.error, /INITIATED/)
  assert.deepEqual(auxSources([]), {})
})

test('Today header source line comes from live ACTIVE connected sources, incl. Calendar', async () => {
  const { todaySourcesText } = await import('../src/web/api.js')
  const acc = (slug, status = 'ACTIVE') => ({ status, toolkit: { slug } })
  assert.equal(todaySourcesText([acc('googlecalendar'), acc('github'), acc('gmail'), acc('slack'), acc('notion', 'EXPIRED')], [], 'en'), 'Gmail, GitHub, Slack, Calendar')
  assert.equal(todaySourcesText([acc('googlecalendar'), acc('github'), acc('gmail'), acc('slack')], [], 'zh'), 'Gmail、GitHub、Slack、日历')
  assert.equal(todaySourcesText([acc('gmail')], [{ source: 'github' }], 'en'), 'Gmail')
  assert.equal(todaySourcesText(null, [{ source: 'github' }, { source: 'bot' }, { source: 'system' }], 'en'), 'GitHub')
  assert.equal(todaySourcesText([], [], 'en'), 'No sources yet')
  assert.equal(todaySourcesText([], [], 'zh'), '暂无数据')
})
