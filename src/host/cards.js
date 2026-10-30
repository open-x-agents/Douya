// Feishu interactive cards. A card is data, so it is built here and tested here; the
// sending lives in feishu.js. Button `value` carries {k, id, op}: what kind of card it
// came from, which record it points at, and what the press means — the callback then
// needs no state of its own to know what was pressed.

import { clockOf, isEmptyReport } from './report.js'
import { SNOOZE_MINUTES } from './constants.js'

export const CARD_KINDS = ['report', 'reminder']
export const OPS = ['report.fill', 'report.view', 'snooze', 'done', 'reschedule']

export { SNOOZE_MINUTES }

const plain = content => ({ tag: 'plain_text', content })
const md = content => ({ tag: 'lark_md', content })

export function button(label, value, type = 'default') {
  return { tag: 'button', type, text: plain(label), value: { k: value.k, id: String(value.id ?? ''), op: value.op } }
}

export function dailyReportCard(report) {
  const lines = []
  if (report.schedule.length > 0) lines.push(report.schedule.map(line => `- ${line}`).join('\n'))
  else lines.push('- 今天没有日程')
  lines.push('')
  lines.push(`**已完成 ${report.stats.done} 项**`)
  if (report.done.length > 0) lines.push(report.done.map(line => `- ${line}`).join('\n'))
  lines.push('')
  lines.push(`**明天计划 ${report.stats.planned} 项**`)
  if (report.plan.length > 0) lines.push(report.plan.map(line => `- ${line}`).join('\n'))
  if (report.notes !== '') {
    lines.push('')
    lines.push(`> ${report.notes}`)
  }
  const empty = isEmptyReport(report)
  return {
    config: { wide_screen_mode: true },
    header: {
      template: empty ? 'grey' : 'blue',
      title: plain(`${report.memberName ?? '日报'} · ${report.date}`),
    },
    elements: [
      { tag: 'div', text: md(lines.join('\n')) },
      { tag: 'note', elements: [plain(`会议 ${report.stats.meetings} 个 · 共 ${report.stats.meetingMinutes} 分钟`)] },
      {
        tag: 'action',
        actions: [
          button('补充今天的进展', { k: 'report', id: report.memberId, op: 'report.fill' }, 'primary'),
          button('看本周', { k: 'report', id: report.memberId, op: 'report.view' }),
        ],
      },
    ],
  }
}

export function reminderCard(reminder) {
  const when = clockOf(reminder.startLocal ?? reminder.startAt)
  const place = reminder.location ? `\n地点：${reminder.location}` : ''
  const lead = reminder.snoozed ? '（已推迟）' : `${reminder.leadMinutes} 分钟后`
  return {
    config: { wide_screen_mode: true },
    header: { template: reminder.snoozed ? 'grey' : 'orange', title: plain(`⏰ ${reminder.title}`) },
    elements: [
      { tag: 'div', text: md(`**${when} 开始**${lead}${place}`) },
      {
        tag: 'action',
        actions: [
          button(`推迟 ${SNOOZE_MINUTES} 分钟`, { k: 'reminder', id: reminder.id, op: 'snooze' }),
          button('已完成', { k: 'reminder', id: reminder.id, op: 'done' }, 'primary'),
          button('改时间', { k: 'reminder', id: reminder.id, op: 'reschedule' }),
        ],
      },
    ],
  }
}

// `card.action.trigger` payloads come from outside the team; anything that does not look
// exactly like a button press of ours is refused by name rather than guessed at.
export function readAction(payload) {
  const openId = payload?.operator?.open_id
  if (typeof openId !== 'string' || openId === '') return { ok: false, reason: 'no-operator' }
  const value = payload?.action?.value
  if (value === null || typeof value !== 'object') return { ok: false, reason: 'no-value' }
  const kind = value.k
  const op = value.op
  if (!CARD_KINDS.includes(kind)) return { ok: false, reason: 'unknown-card' }
  if (!OPS.includes(op)) return { ok: false, reason: 'unknown-op' }
  return { ok: true, openId, kind, id: String(value.id ?? ''), op }
}
