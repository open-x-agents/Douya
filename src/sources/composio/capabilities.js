// Composio 的能力快照：2026-10-31T12:15–12:19Z 的一次真探测
// （`GET /toolkits`、`GET /tools?toolkit_slug=…&limit=100`、`GET /connected_accounts`，凭证只放在环境变量里、不打印也不落仓库）。
//
// 这里只收「注册表白名单 + 两组实测反例 + 计数」，不收整份只读清单，也不存 `tools_count`
// （那是 toolkit 版本总数，gmail 61，不是这次能看到的动作数）。名单是**当时的事实**，不是规则：
// 收录条件是 `tags` 含 `readOnlyHint` 且 `is_deprecated !== true`。
//
// 只读判定只看 tag，不看名字：名字会撒谎两个方向。
//   - `GOOGLECALENDAR_CALENDAR_LIST_INSERT` 名字带 `_LIST`，没有 tag → 是写；
//   - `LINEAR_CREATE_LINEAR_ISSUE_DETAILS` 名字带 `CREATE`，有 tag → 是读。
//
// 本文件不联网、不打印 key、不写仓库 `data/`。

export const SNAPSHOT = {
  at: '2026-10-31T12:15:56.454Z',
  base_url: 'https://backend.composio.dev/api/v3',
  toolkits: {
    gmail: {
      visible: 23,
      read_only_tagged: 11,
      capped: false,
      read_only: [
        'GMAIL_FETCH_EMAILS',
        'GMAIL_FETCH_MESSAGE_BY_THREAD_ID',
        'GMAIL_LIST_THREADS',
        'GMAIL_GET_PROFILE',
      ],
      not_read_only: ['GMAIL_SEND_EMAIL'],
    },
    googlecalendar: {
      visible: 28,
      read_only_tagged: 11,
      capped: false,
      read_only: [
        'GOOGLECALENDAR_EVENTS_LIST',
        'GOOGLECALENDAR_EVENTS_INSTANCES',
        'GOOGLECALENDAR_SYNC_EVENTS',
        'GOOGLECALENDAR_GET_CURRENT_DATE_TIME',
      ],
      not_read_only: ['GOOGLECALENDAR_CALENDAR_LIST_INSERT'],
    },
    notion: {
      visible: 28,
      read_only_tagged: 12,
      capped: false,
      read_only: [
        'NOTION_SEARCH_NOTION_PAGE',
        'NOTION_QUERY_DATABASE',
        'NOTION_FETCH_ROW',
        'NOTION_FETCH_DATA',
      ],
      not_read_only: ['NOTION_INSERT_ROW_DATABASE'],
    },
    slack: {
      // `/tools` 返回的条数正好等于 limit 100，这是截断，不是总数。
      visible: 100,
      read_only_tagged: 37,
      capped: true,
      read_only: [
        'SLACK_FETCH_CONVERSATION_HISTORY',
        'SLACK_LIST_CONVERSATIONS',
        'SLACK_FIND_CHANNELS',
        'SLACK_RETRIEVE_CONVERSATION_INFORMATION',
      ],
    },
    // 第 5 个 app 的候选（S6 才进注册表）：先记下来，加 app 时不用再探测一次。
    googledrive: {
      visible: 51,
      read_only_tagged: 21,
      capped: false,
      read_only: [
        'GOOGLEDRIVE_LIST_FILES',
        'GOOGLEDRIVE_GET_FILE_METADATA',
        'GOOGLEDRIVE_FIND_FILE',
        'GOOGLEDRIVE_GET_ABOUT',
      ],
    },
    // 只看不接：用来证明「名字像写也可以是读」，不进注册表。
    linear: {
      visible: 21,
      read_only_tagged: 13,
      capped: false,
      read_only: ['LINEAR_CREATE_LINEAR_ISSUE_DETAILS'],
    },
  },
}

// 一个动作只读，当且仅当它在**这份快照**的 `read_only` 名单里。
// 不在名单里（包括快照里根本没有这个 toolkit / 这个动作）一律判 false：fail-closed，不猜名字。
export function isReadOnlyIn(snapshot, toolkit, action) {
  const row = snapshot?.toolkits?.[toolkit]
  if (!row || !Array.isArray(row.read_only)) return false
  return row.read_only.includes(action)
}

export function isReadOnly(toolkit, action) {
  return isReadOnlyIn(SNAPSHOT, toolkit, action)
}

// 快照的取得时间：缓存 / 结论都靠它说清「这是哪天的事实」。
export const SNAPSHOT_AT = SNAPSHOT.at
