// Composio 的多 app 骨架：一个 app 一行。
//
// 加一个 app 只许改三处：这里加一行、`src/sources/composio/<app>.js` 一个适配器、
// `test/composio/<app>.contract.test.js` 一份契约测试。`report.js` / `cards.js` / 面板不改。
//
// 本文件不联网、不 import `index.js`，也不 import 任何信源层代码（#9/#10/#11），
// 所以在只有 `src/host/**` 的 main 上也能独立跑绿。
//
// `actions[]` 是人工 review 过的白名单，只放读动作：名字不是证据，`capabilities.js` 的
// `readOnlyHint` 快照才是。启动时 `assertReadOnlyRegistry()` 会把这条规则变成「启动失败」。

import { isReadOnlyIn, SNAPSHOT } from './capabilities.js'

export const REGISTRY_ERROR = 'E_WRITE_ACTION'

export const registry = [
  {
    toolkit: 'gmail',
    label: '邮件',
    adapter: './gmail.js',
    readScope: 'metadata',
    actions: [
      'GMAIL_FETCH_EMAILS',
      'GMAIL_FETCH_MESSAGE_BY_THREAD_ID',
      'GMAIL_LIST_THREADS',
      'GMAIL_GET_PROFILE',
    ],
  },
  {
    toolkit: 'googlecalendar',
    label: '谷歌日历',
    adapter: './googlecalendar.js',
    readScope: 'metadata',
    actions: [
      'GOOGLECALENDAR_EVENTS_LIST',
      'GOOGLECALENDAR_EVENTS_INSTANCES',
      'GOOGLECALENDAR_SYNC_EVENTS',
      'GOOGLECALENDAR_GET_CURRENT_DATE_TIME',
    ],
  },
  {
    toolkit: 'notion',
    label: 'Notion',
    adapter: './notion.js',
    readScope: 'metadata',
    actions: [
      'NOTION_SEARCH_NOTION_PAGE',
      'NOTION_QUERY_DATABASE',
      'NOTION_FETCH_ROW',
      'NOTION_FETCH_DATA',
    ],
  },
  {
    toolkit: 'slack',
    label: 'Slack',
    adapter: './slack.js',
    readScope: 'metadata',
    actions: [
      'SLACK_FETCH_CONVERSATION_HISTORY',
      'SLACK_LIST_CONVERSATIONS',
      'SLACK_FIND_CHANNELS',
      'SLACK_RETRIEVE_CONVERSATION_INFORMATION',
    ],
  },
]

// 面板 / 卡片要显示的中文名从注册表来：`composio:notion` 与 `notion` 都认。
// 查不到返回 null，调用方再回落显示 slug —— 加一个 app 只要加一行，这里不用改。
export function labelOf(sourceIdOrToolkit) {
  if (typeof sourceIdOrToolkit !== 'string') return null
  const toolkit = sourceIdOrToolkit.startsWith('composio:')
    ? sourceIdOrToolkit.slice('composio:'.length).split(':')[0]
    : sourceIdOrToolkit.split(':')[0]
  const row = registry.find(item => item.toolkit === toolkit)
  return row?.label ?? null
}

// 启动校验：注册表里任何一条动作不是读动作（或快照里根本没有它）就同步抛，
// 不是打一条告警 —— 告警会被日志吞掉，写动作却已经进了白名单。
export function assertReadOnlyRegistry(rows = registry, capabilities = SNAPSHOT) {
  if (!Array.isArray(rows) || rows.length === 0) {
    const error = new Error('E_REGISTRY_SHAPE: registry 必须是非空数组')
    error.code = 'E_REGISTRY_SHAPE'
    throw error
  }
  for (const row of rows) {
    const toolkit = row?.toolkit
    const actions = row?.actions
    if (typeof toolkit !== 'string' || !Array.isArray(actions) || actions.length === 0) {
      const error = new Error(`E_REGISTRY_SHAPE: 注册表有一行没有 toolkit 或 actions（${String(toolkit)}）`)
      error.code = 'E_REGISTRY_SHAPE'
      throw error
    }
    for (const action of actions) {
      if (isReadOnlyIn(capabilities, toolkit, action)) continue
      const error = new Error(
        `${REGISTRY_ERROR}: ${toolkit} 的 ${String(action)} 不是只读动作（快照 ${String(capabilities?.at ?? '')}）`,
      )
      error.code = REGISTRY_ERROR
      error.toolkit = toolkit
      error.action = action
      throw error
    }
  }
  return true
}
