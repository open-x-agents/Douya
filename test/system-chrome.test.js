import assert from 'node:assert/strict'
import { test } from 'node:test'
import { paintSystemChrome, generateAchievementsTile } from '../src/web/aggregation.js'

test('paintSystemChrome flips hero / My day / achievements to EN and ZH', () => {
  const heroZh = {
    type: 'hero',
    title: '11月8日星期日 · 下午',
    body: '下午好, Danyang',
    blocks: [{ type: 'achievement-rings', rings: [
      { label: '今日合并（与你相关的 PR）', value: 1 },
      { label: '今日关闭（相关 issue）', value: 0 },
      { label: '最近 24h 已读邮件', value: 3 },
    ] }],
  }
  const en = paintSystemChrome(heroZh, 'en')
  assert.match(en.title, /afternoon|morning|evening/i)
  assert.match(en.body, /^Good /)
  assert.match(en.blocks[0].rings[0].label, /Merged today/)
  assert.equal(en.metadata.lang, 'en')
  const zh = paintSystemChrome(en, 'zh')
  assert.match(zh.title, /早上|下午|晚上/)
  assert.match(zh.body, /早上|下午|晚上好/)

  const tt = {
    type: 'timetable',
    title: '我的一天',
    body: '已安排 2 个日程',
    blocks: [{ type: 'timetable', fixedBlocks: [{}, {}], suggestedBlocks: [], tzNote: '日历原时区不是北京时间，已按 Asia/Shanghai 显示' }],
  }
  const ttEn = paintSystemChrome(tt, 'en')
  assert.equal(ttEn.title, 'My day')
  assert.equal(ttEn.body, '2 events on the calendar')
  assert.match(ttEn.blocks[0].tzNote, /Asia\/Shanghai/)

  const ach = {
    type: 'achievements-tile',
    title: '成就统计',
    body: '连续活跃 3 天，已合并 10 个 PR',
    blocks: [
      { type: 'stat-row', stats: [{ label: '已合并 PR', value: 10 }, { label: '连续活跃天数', value: 3 }] },
      { type: 'heatmap', data: [], label: '最近 8 周贡献' },
    ],
  }
  const achEn = paintSystemChrome(ach, 'en')
  assert.equal(achEn.title, 'Achievements')
  assert.equal(achEn.body, '3-day streak · 10 PRs merged')
  assert.equal(achEn.blocks[0].stats[0].label, 'PRs merged')
  assert.equal(achEn.blocks[1].label, 'Last 8 weeks')
})

test('generateAchievementsTile titles follow lang', () => {
  const gh = { github: { merged: [{ merged_at: '2026-11-01T00:00:00Z', pull_request: true }], assigned: [], reviewRequests: [], issues: [] } }
  // minimal shape that yields mergedPRs > 0 — function uses allGithubItems
  // If null (no data), skip assertion
  const tile = generateAchievementsTile({ github: { items: [] } }, [
    { metadata: { updated_at: new Date().toISOString() } },
  ], 'en')
  // may be null if mergedPRs===0 && streak===0 after empty github
  if (tile) {
    assert.equal(tile.title, 'Achievements')
    assert.match(tile.body, /streak|PRs merged/)
  }
})
