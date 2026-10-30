// A one-shot look at what the product actually sends: no Feishu, no network, no key.
// `node scripts/demo.mjs` prints the two cards and the plan behind them.

import { planFor } from '../src/host/reminders.js'
import { buildDailyReport } from '../src/host/report.js'
import { dailyReportCard, reminderCard } from '../src/host/cards.js'

const events = [
  { id: 'e1', summary: '周一站会', start: '2026-10-30T09:30:00+08:00', end: '2026-10-30T09:45:00+08:00', location: '3F 会议室' },
  { id: 'e2', summary: '需求评审', start: '2026-10-30T14:00:00+08:00', end: '2026-10-30T15:00:00+08:00' },
]

const now = Date.parse('2026-10-30T09:00:00+08:00')
const plan = planFor(events, { now, leadMinutes: 10 })
const report = buildDailyReport({
  date: '2026-10-30',
  memberId: 'demo',
  memberName: '数字同事',
  events,
  done: ['把 Feishu 长连接接上', '日报卡片跑通'],
  plan: ['日程提醒联调', '面板接数据'],
  notes: '卡在飞书应用权限上，明天找 IT 开。',
})

console.log('计划中的提醒：')
for (const reminder of plan) console.log(`  ${reminder.fireAt}  提前 ${reminder.leadMinutes} 分钟 → ${reminder.title}`)

console.log('\n日程提醒卡片：')
console.log(JSON.stringify(reminderCard(plan[0]), null, 2))

console.log('\n日报卡片：')
console.log(JSON.stringify(dailyReportCard(report), null, 2))
