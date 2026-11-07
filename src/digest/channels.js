// Source bots for the bot digest: one per channel. Adding Calendar or Notion is one entry here plus,
// if its items need a special card shape, a `build` kind in build.js (the generic kind works for any list).
export const CHANNELS = {
  gmail: {
    label: 'Gmail', toolkit: 'gmail', letter: 'm', kind: 'email',
    readTools: ['odm_gmail_fetch_emails'],
    categories: ['single', 'action', 'code', 'security', 'updates', 'social', 'promo'],
    guide: `把邮件分成类别卡：action 需要你处理 / code CI与代码通知 / security 账号与安全 / updates 服务与通知 / social 社交通知 / promo 促销与订阅。
真人来信且需要回复/确认/有截止的，可用 category "single" 单独出卡（全渠道最多 4 张，宁缺毋滥）；其余同类合成一张类别卡。
每个类别最多一张候选卡；不需要处理的类别 needsAction=false。`,
  },
  github: {
    label: 'GitHub', toolkit: 'github', letter: 'g', kind: 'code',
    readTools: ['odm_github_list_repos', 'odm_github_search_my_prs', 'odm_github_list_my_issues'],
    guide: `按仓库出卡（category 填 owner/repo），一个仓库最多一张候选卡。
待你 review 的 PR、指派给你的 issue、你的 PR 有新评论/CI 失败 → needsAction=true；只是动态 → false。
nextStep 写具体动作（例如「先审 #123：xxx」）。`,
  },
  slack: {
    label: 'Slack', toolkit: 'slack', letter: 's', kind: 'chat',
    readTools: ['odm_slack_search_messages'],
    guide: `按频道/私信出卡（category 填频道名），一个频道最多一张候选卡。
有人 @你、问你问题、私信等你回复 → needsAction=true；bot/告警刷屏合成一张 FYI 卡或不出卡。`,
  },
}

/**
 * When to wake which bot (digest only — dock chat always goes to Chief).
 *
 * | Situation | Who runs | Why |
 * |---|---|---|
 * | Toolkit has a CHANNELS entry + ACTIVE Composio account + live items | **Source bot** (gmail/github/slack session) | Owns that channel's candidates |
 * | CHANNELS entry but snapshot rows empty (all done / nothing new) | **Skip** source bot | No LLM turn; strip shows skipped |
 * | Connected calendar (no CHANNELS entry) | **Aux fetch** only | Feeds timeline/hero; no source bot |
 * | Account connected but not ACTIVE | **Skip / failed strip** | Reconnect in Sources |
 * | ≥1 source bot produced candidates | **Chief** merge session | Dedupes, ranks, headline, timeline |
 * | Every source skipped/failed with 0 candidates | **Skip Chief** | Default empty plan; still refresh hero/timetable from aux |
 * | Dock / card chat | **Chief only** | Source bots are digest workers, not chat personas |
 */
export const BOT_ROUTE = Object.freeze({
  chat: 'chief',
  sourceWhen: 'active-account + CHANNELS entry + non-empty snapshot',
  skipSourceWhen: 'empty snapshot (nothing live to propose)',
  auxWhen: 'connected toolkit without CHANNELS entry (e.g. googlecalendar)',
  chiefWhen: 'at least one candidate from a source bot',
  skipChiefWhen: 'zero candidates after source passes',
})

export const channelIds = () => Object.keys(CHANNELS)
export const channelOfToolkit = slug => Object.entries(CHANNELS).find(([, c]) => c.toolkit === slug)?.[0] || null

/** Classify how a connected toolkit should participate in one digest run. */
export function digestRoleForToolkit(slug) {
  const ch = channelOfToolkit(slug)
  if (ch) return { role: 'source-bot', channel: ch }
  if (slug === 'googlecalendar') return { role: 'aux-fetch', channel: slug }
  return { role: 'ignore', channel: null }
}
