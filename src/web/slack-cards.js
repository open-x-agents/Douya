/**
 * Slack channel/DM cluster → a card that carries the actual messages.
 * Each message becomes a link-list entry (so per-item 打开/完成/忽略 works) with sender, time,
 * markdown text, thread reply count and permalink. Summary and next step come from the
 * messages themselves (who needs a reply / mentions you / questions), never a bare "打开频道".
 */

const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s }

/** Slack mrkdwn → the subset of Markdown the client renders safely. */
export function slackToMd(text, users = {}) {
  return String(text || '')
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g, (_, id, n) => `@${n || users[id] || id}`)
    .replace(/<#C[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]+)>/g, '$1')
    .replace(/<(https?:\/\/[^|>\s]+)\|([^>]+)>/g, (_, u, t) => `[${t.replace(/[[\]]/g, '')}](${u})`)
    .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
    .replace(/<mailto:[^|>]+\|([^>]+)>/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,:;!?，。！？]|$)/g, '$1**$2**')
    .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
}

const firstLine = md => clip(String(md || '').split('\n').map(s => s.replace(/[*_`>#]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim()).find(Boolean) || '(空消息)', 90)
const threadTsOf = it => it.metadata?.threadTs || (String(it.url || '').match(/[?&]thread_ts=([\d.]+)/) || [])[1] || null

/**
 * @param {object[]} items normalized slack items of ONE channel/DM
 * @param {{ selfNames?: string[], selfIds?: string[] }} who
 */
export function buildSlackCopy(items, { selfNames = [], selfIds = [] } = {}) {
  const names = new Set(selfNames.filter(Boolean).map(s => s.toLowerCase()))
  const ids = new Set(selfIds.filter(Boolean))
  const isSelf = it => ids.has(it.metadata?.userId) || names.has(String(it.metadata?.user || '').toLowerCase())
  const users = {}
  for (const it of items) if (it.metadata?.userId && it.metadata?.user) users[it.metadata.userId] = it.metadata.user
  const sorted = [...items].sort((a, b) => parseFloat(b.metadata?.ts || 0) - parseFloat(a.metadata?.ts || 0))
  const isDm = !!sorted[0]?.metadata?.isDm

  const msgs = sorted.map(it => {
    const raw = String(it.metadata?.text ?? it.body ?? '')
    const md = slackToMd(raw, users)
    const ts = it.metadata?.ts
    const thread = threadTsOf(it)
    const replies = Number(it.metadata?.replyCount) || sorted.filter(o => o !== it && threadTsOf(o) && threadTsOf(o) === ts).length
    const mentionsMe = [...ids].some(id => raw.includes(`<@${id}`)) || /<!(here|channel|everyone)/.test(raw)
    const human = !it.metadata?.isBot
    const question = human && /[?？]\s*$|[?？]\s|\b(can|could|would) you\b|麻烦|能不能|可以吗|怎么看|请(你|您)/i.test(raw)
    const self = isSelf(it)
    const needsYou = !self && (mentionsMe || (isDm && human) || (question && human))
    return {
      title: firstLine(md),
      url: it.url,
      type: 'slack',
      from: it.metadata?.user || '未知',
      at: ts ? new Date(parseFloat(ts) * 1000).toISOString() : (it.timestamp || null),
      text: clip(md, 1500),
      replies,
      inThread: !!(thread && thread !== ts),
      isBot: !!it.metadata?.isBot,
      self,
      needsYou,
      reason: needsYou ? (mentionsMe ? '提到了你' : isDm ? '私信' : '在问问题') : null,
    }
  })

  const need = msgs.filter(m => m.needsYou)
  const humans = [...new Set(msgs.filter(m => !m.isBot && !m.self).map(m => m.from))]
  const bots = [...new Set(msgs.filter(m => m.isBot).map(m => m.from))]
  const latest = msgs[0]
  let body, nextAction, waiting
  if (need.length) {
    const who = [...new Set(need.map(m => m.from))]
    body = `${need.length} 条等你回应：${who.slice(0, 3).join('、')}${who.length > 3 ? ' 等' : ''}${need[0].reason ? `（${need[0].reason}）` : ''}——「${clip(need[0].title, 40)}」。共 ${msgs.length} 条。`
    nextAction = `回复 ${need[0].from}：「${clip(need[0].title, 26)}」`
    waiting = 'you'
  } else if (!humans.length && bots.length) {
    body = `${msgs.length} 条来自 ${bots.slice(0, 2).join('、')} 的自动推送，最新：「${clip(latest.title, 48)}」。没有人在等你回复。`
    nextAction = msgs.length > 1 ? `扫一眼 ${msgs.length} 条推送：有价值的点开跟进，其余忽略` : `看一眼「${clip(latest.title, 26)}」，没用就忽略`
    waiting = 'fyi'
  } else {
    const hot = msgs.filter(m => m.replies > 0).sort((a, b) => b.replies - a.replies)[0]
    body = `${msgs.length} 条消息，${humans.slice(0, 3).join('、')}${humans.length > 3 ? ` 等 ${humans.length} 人` : ''}在聊${hot ? `；「${clip(hot.title, 36)}」有 ${hot.replies} 条回复` : `：「${clip(latest.title, 40)}」`}。没有直接找你的。`
    nextAction = hot ? `无需回复；想跟进就看「${clip(hot.title, 24)}」的讨论` : `无需回复；有空看 ${latest.from} 的「${clip(latest.title, 24)}」`
    waiting = 'fyi'
  }
  return { msgs, body, nextAction, waiting, needCount: need.length, people: humans, bots, isDm }
}

/** Learn the user's own Slack ids from messages authored under their known display name(s). */
export function selfSlackIds(items, selfNames = []) {
  const names = new Set(selfNames.filter(Boolean).map(s => s.toLowerCase()))
  return [...new Set(items.filter(i => names.has(String(i.metadata?.user || '').toLowerCase()) || names.has(String(i.metadata?.realName || '').toLowerCase())).map(i => i.metadata?.userId).filter(Boolean))]
}
