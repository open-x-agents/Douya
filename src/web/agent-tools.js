import { normalizeEmail, groupEmails, groupPullRequests, groupIssues } from './chat-groups.js'
// Composio-backed tools for ds-bot agent integration
// Each tool wraps a Composio v3 tools/execute call

/**
 * Create ds-bot tool definitions backed by Composio
 * @param {object} composioClient - Composio client instance
 * @returns {Array} Array of ds-bot tool definitions
 */
export function createComposioTools(composioClient) {
  if (!composioClient) {
    return []
  }

  return [
    {
      name: 'github_list_repos',
      description: '获取当前用户的 GitHub 仓库列表，按更新时间排序',
      inputSchema: {
        type: 'object',
        properties: {
          per_page: {
            type: 'number',
            description: '返回的仓库数量（默认 20）',
            default: 20,
          },
          sort: {
            type: 'string',
            enum: ['created', 'updated', 'pushed', 'full_name'],
            description: '排序方式',
            default: 'updated',
          },
        },
      },
      async execute({ per_page = 20, sort = 'updated' }) {
        try {
          const result = await composioClient.executeAction(
            'GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER',
            { per_page, sort }
          )
          result.items = result.items || result.data?.repositories || result.repositories || result.data?.data?.repositories
          
          if (!result.data?.repositories || result.data.repositories.length === 0) {
            return { repos: [], count: 0 }
          }

          return {
            repos: result.data.repositories.map(repo => ({
              name: repo.name,
              fullName: repo.full_name,
              description: repo.description || '',
              url: repo.html_url,
              stars: repo.stargazers_count || 0,
              language: repo.language || '',
              updatedAt: repo.updated_at,
            })),
            count: result.data.repositories.length,
          }
        } catch (error) {
          return { error: error.message, repos: [], count: 0 }
        }
      },
    },

    {
      name: 'github_search_my_prs',
      description: '搜索当前用户相关的 Pull Requests（我创建的、我被请求审查的、提到我的）',
      inputSchema: {
        type: 'object',
        properties: {
          state: {
            type: 'string',
            enum: ['open', 'closed'],
            description: 'PR 状态',
            default: 'open',
          },
          query_type: {
            type: 'string',
            enum: ['involves_me', 'review_requested', 'authored_by_me'],
            description: '查询类型',
            default: 'involves_me',
          },
        },
      },
      async execute({ state = 'open', query_type = 'involves_me' }) {
        try {
          const search = async q => {
            const r = await composioClient.executeAction('GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS', { q, per_page: 30 })
            return r.data?.items || r.data?.data?.items || []
          }
          const base = `is:pr is:${state}`
          const mainQ = query_type === 'review_requested' ? `${base} review-requested:@me`
            : query_type === 'authored_by_me' ? `${base} author:@me` : `${base} involves:@me`
          const [items, reviewItems] = await Promise.all([
            search(mainQ),
            query_type === 'review_requested' ? Promise.resolve([]) : search(`${base} review-requested:@me`).catch(() => []),
          ])
          const reviewIds = new Set(reviewItems.map(i => i.id))
          const all = [...items, ...reviewItems.filter(i => !items.some(x => x.id === i.id))]
          const pullRequests = all.map(pr => ({
            number: pr.number,
            title: pr.title,
            state: pr.state,
            url: pr.html_url,
            repo: pr.repository_url?.split('/').slice(-2).join('/') || (pr.html_url?.match(/github\.com\/([^/]+\/[^/]+)/) || [])[1] || 'unknown',
            author: pr.user?.login || 'unknown',
            reviewRequested: query_type === 'review_requested' || reviewIds.has(pr.id),
            createdAt: pr.created_at,
            updatedAt: pr.updated_at,
          }))
          return { count: pullRequests.length, groups: groupPullRequests(pullRequests), pullRequests: pullRequests.slice(0, 15) }
        } catch (error) {
          return { error: error.message, pullRequests: [], count: 0 }
        }
      },
    },

    {
      name: 'github_list_my_issues',
      description: '获取分配给当前用户的 GitHub Issues',
      inputSchema: {
        type: 'object',
        properties: {
          state: {
            type: 'string',
            enum: ['open', 'closed', 'all'],
            description: 'Issue 状态',
            default: 'open',
          },
        },
      },
      async execute({ state = 'open' }) {
        try {
          const result = await composioClient.executeAction(
            'GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER',
            { state, per_page: 30 }
          )
          
          if (!result.data?.issues || result.data.issues.length === 0) {
            return { issues: [], count: 0 }
          }

          const issues = result.data.issues.map(issue => ({
              number: issue.number,
              title: issue.title,
              state: issue.state,
              url: issue.html_url,
              repo: issue.repository_url?.split('/').slice(-2).join('/') || (issue.html_url?.match(/github\.com\/([^/]+\/[^/]+)/) || [])[1] || 'unknown',
              labels: (issue.labels || []).map(l => l.name),
              createdAt: issue.created_at,
              updatedAt: issue.updated_at,
            }))
          return { issues, count: issues.length, groups: groupIssues(issues) }
        } catch (error) {
          return { error: error.message, issues: [], count: 0 }
        }
      },
    },

    {
      name: 'gmail_fetch_emails',
      description: '获取 Gmail 邮件',
      inputSchema: {
        type: 'object',
        properties: {
          max_results: {
            type: 'number',
            description: '返回的邮件数量',
            default: 5,
          },
          query: {
            type: 'string',
            description: 'Gmail 搜索查询（例如：is:unread, from:example@example.com）',
            default: 'in:inbox',
          },
        },
      },
      async execute({ max_results = 40, query = 'in:inbox newer_than:2d' }) {
        try {
          const n = Math.min(Math.max(Number(max_results) || 40, 30), 50)
          const result = await composioClient.executeAction(
            'GMAIL_FETCH_EMAILS',
            { max_results: n, query, include_payload: false, verbose: false }
          )
          const raw = result.data?.messages || result.data?.data?.messages || []
          if (raw.length === 0) return { messages: [], count: 0, groups: [] }
          const messages = raw.map(normalizeEmail)
          return {
            count: messages.length,
            unread: messages.filter(m => m.labels.includes('UNREAD')).length,
            groups: groupEmails(messages),
            // compact sample only; the reply must summarize groups, not list these
            sample: messages.slice(0, 8).map(m => ({ subject: m.subject, from: m.from })),
          }
        } catch (error) {
          return { error: error.message, messages: [], count: 0 }
        }
      },
    },

    {
      name: 'slack_search_messages',
      description: '搜索最近的 Slack 消息（默认最近 2 天），按频道/私信预聚合',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Slack 搜索语法，例如 after:2026-01-01、in:#general、from:@someone' },
          days: { type: 'number', description: '回看天数（query 为空时使用）', default: 2 },
        },
      },
      async execute({ query, days = 2 } = {}) {
        try {
          const since = new Date(Date.now() - Math.max(1, Number(days) || 2) * 86400000).toISOString().split('T')[0]
          const result = await composioClient.executeAction('SLACK_SEARCH_MESSAGES', { query: query || `after:${since}`, count: 100, sort: 'timestamp' })
          const matches = result.data?.messages?.matches || []
          const byChan = new Map()
          for (const m of matches) {
            const ch = m.channel || {}
            const key = ch.id || 'unknown'
            if (!byChan.has(key)) byChan.set(key, { ch, items: [] })
            byChan.get(key).items.push(m)
          }
          const groups = [...byChan.values()].sort((a, b) => b.items.length - a.items.length).map(({ ch, items }) => {
            const isDm = !!(ch.is_im || ch.is_mpim)
            const people = [...new Set(items.map(m => m.username || m.user).filter(Boolean))]
            return {
              key: `slack:${ch.id}`, label: isDm ? `私信 · ${people[0] || ''}` : `#${ch.name || ch.id}`, icon: 'slack',
              count: items.length, waiting: isDm,
              why: `${items.length} 条消息${people.length ? `，来自 ${people.slice(0, 3).join('、')}` : ''}`,
              nextAction: isDm ? '回复这条私信' : '打开频道看最新讨论',
              links: items.slice(0, 3).map(m => ({ title: String(m.text || '').replace(/\s+/g, ' ').slice(0, 80), url: m.permalink })),
            }
          })
          return { count: matches.length, groups, sample: matches.slice(0, 8).map(m => ({ channel: m.channel?.name, user: m.username, text: String(m.text || '').slice(0, 120) })) }
        } catch (error) {
          return { error: error.message, groups: [], count: 0 }
        }
      },
    },

    {
      name: 'calendar_list_events',
      description: '读 Google 日历的事件（实时调用，以最新一次结果为准）。ok:true 时 count=0 表示这段时间确实没有日程；ok:false 时说明原因（not_connected = 没连上，需在「信源状态」连接），不要把失败说成没有日程。',
      inputSchema: {
        type: 'object',
        properties: {
          time_min: {
            type: 'string',
            description: '开始时间 (ISO 8601)',
          },
          time_max: {
            type: 'string',
            description: '结束时间 (ISO 8601)',
          },
          max_results: {
            type: 'number',
            description: '返回的事件数量',
            default: 10,
          },
        },
      },
      async execute({ time_min, time_max, max_results = 10 }) {
        try {
          // Default to today if no time range specified
          if (!time_min) {
            const now = new Date()
            time_min = new Date(now.setHours(0, 0, 0, 0)).toISOString()
          }
          if (!time_max) {
            const now = new Date()
            time_max = new Date(now.setHours(23, 59, 59, 999)).toISOString()
          }

          const result = await composioClient.executeAction(
            'GOOGLECALENDAR_EVENTS_LIST',
            { calendarId: 'primary', timeMin: time_min, timeMax: time_max, maxResults: max_results, singleEvents: true, orderBy: 'startTime' }
          )
          return calendarEventsResult(result, { time_min, time_max })
        } catch (error) {
          return calendarErrorResult(error, { time_min, time_max })
        }
      },
    },
  ]
}

/** Composio said the call did not run (HTTP error, or 200 with successful:false). */
export function composioFailure(result) {
  if (!result || typeof result !== 'object') return 'empty response'
  if (result.successful === false || result.error) return String(result.error || 'successful=false')
  return null
}

/**
 * A calendar read the model can trust: success says so explicitly (an empty list is a verified empty range on a
 * connected account), and a failure never looks like "0 events".
 */
export function calendarEventsResult(result, { time_min, time_max } = {}) {
  const failed = composioFailure(result)
  if (failed) return calendarErrorResult(new Error(failed), { time_min, time_max })
  const data = result.data || {}
  const items = Array.isArray(data.items) ? data.items : null
  if (!items) return calendarErrorResult(new Error('Google Calendar 返回里没有 items 字段'), { time_min, time_max })
  const events = items.map(event => ({
    id: event.id,
    summary: event.summary || '(无标题)',
    start: event.start?.dateTime || event.start?.date,
    end: event.end?.dateTime || event.end?.date,
    allDay: !event.start?.dateTime,
    location: event.location || '',
    attendees: (event.attendees || []).length,
    url: event.htmlLink || '',
  }))
  return {
    ok: true,
    connected: true,
    calendar: data.summary || 'primary',
    timeZone: data.timeZone || null,
    range: { from: time_min, to: time_max },
    count: events.length,
    events,
    note: events.length
      ? '本次调用成功（Google 日历已连接）。此前任何连接错误都已过时。'
      : '本次调用成功（Google 日历已连接）：这段时间日历里确实没有事件。此前任何连接错误都已过时，不要再说没连上。',
  }
}

export function calendarErrorResult(error, { time_min, time_max } = {}) {
  const msg = String(error?.message || error || '')
  const notConnected = /ConnectedAccountNotFound|No connected account found|no active connection/i.test(msg)
  return {
    ok: false,
    connected: notConnected ? false : null,
    reason: notConnected ? 'not_connected' : 'call_failed',
    range: { from: time_min, to: time_max },
    error: msg.slice(0, 400),
    note: notConnected
      ? 'Google 日历当前没有已连接的账号，所以读不到日程（不是「没有日程」）。请用户在豆芽「信源状态」里点 Google 日历的「连接」完成授权，然后再查一次。'
      : '日历调用失败，结果未知（不是「没有日程」）。',
    ...(notConnected ? { connect: { source: 'googlecalendar', where: '信源状态 → Google 日历 → 连接' } } : {}),
  }
}

/**
 * Enhanced system prompt for card-based responses with real tool data
 */
export const AGENT_SYSTEM_PROMPT = `你是「豆芽」（Open Digital Mate），用户的数字同事。

## 核心职责
- 管理任务和日程
- 监控 GitHub（仓库、PR、Issue）
- 查收 Gmail 邮件
- 查看 Slack 频道与私信
- 提醒 Google Calendar 事件

## 可用工具
你可以调用以下工具获取真实数据：

1. **github_list_repos** - 列出用户的 GitHub 仓库
   参数: { per_page?: number, sort?: 'created'|'updated'|'pushed' }
   
2. **github_search_my_prs** - 列出 Pull Requests
   参数: { state?: 'open'|'closed'|'all', per_page?: number }
   
3. **github_list_my_issues** - 列出 Issues
   参数: { state?: 'open'|'closed'|'all', per_page?: number }
   
4. **gmail_fetch_emails** - 获取最近的邮件（默认 40 封、newer_than:2d，系统已预先聚合为 groups）
   参数: { max_results?: number(30-50), query?: string }
   
5. **slack_search_messages** - 搜索最近的 Slack 消息（已按频道/私信预聚合为 groups）
   参数: { query?: string, days?: number }

6. **calendar_list_events** - 获取日历事件
   参数: { timeMin?: string, timeMax?: string, maxResults?: number }

## 工具调用协议

当你需要真实数据时，返回 JSON：
\`\`\`json
{
  "tool_calls": [
    {
      "name": "github_search_my_prs",
      "arguments": { "state": "open", "per_page": 10 }
    }
  ]
}
\`\`\`

系统会执行工具并将结果返回给你，然后你再基于真实数据回复用户。

## 严格禁止
1. **绝对禁止编造数据**：
   - 不能虚构项目、任务、PR、Issue、邮件、日程
   - 不能臆造数字、名称、链接
   - 如果需要数据，调用工具；如果没有工具或工具返回空，诚实告知
   
2. **不使用工具 ID 作为按钮值**：
   - ❌ 错误：{label: "查看 PR", value: "github_pull_requests"}
   - ✅ 正确：{label: "查看我的 GitHub PR", value: "查看我的 GitHub PR"}


## 聚合原则（最重要，Muse / today.ai 风格）
工具结果里如果有 \`groups\`（系统已按类别预聚合：需要你回复的人 / CI 失败 / PR 讨论·仓库 / 等你 review / 服务通知 / 营销 等），你必须：
1. **按组回复，绝不逐条列举邮件或 PR**。不要为单封邮件或单个 PR 生成卡片。
2. text = 1–2 句按优先级的总结：先说等你处理的（waiting="you"）有几组几件、最该先做什么，再一句带过 FYI。
3. cards 每组一张，type="group"，字段：key（照抄 groups[].key）、title（组名）、count、waiting（you|others|fyi）、why（为什么重要，可改写得更具体）、nextAction（一个具体动作，动词+对象）、links（照抄 groups[].links，最多 3 个，禁止编造链接）。
4. 顺序：waiting=you 在前，FYI（营销、订阅、社交）放最后，可合并成一张。
5. GitHub 查询同理：问 PR 时调用 github_search_my_prs（系统会同时取等你 review 的 PR 并按仓库分组）；问 issue 调用 github_list_my_issues。

示例：
\`\`\`json
{"text":"38 封新邮件里有 2 组需要你：CI 在 2 个仓库失败了 3 次，先修 pr-guard；其余是 PR 通知和促销。",
 "cards":[{"type":"group","key":"ci","title":"CI 失败","count":3,"waiting":"you","why":"…","nextAction":"先看 owner/repo 最近一次失败日志","links":[{"title":"…","url":"…"}]}]}
\`\`\`

## 最终回复格式
当你收到工具结果后，必须返回 JSON：
\`\`\`json
{
  "text": "1-2句话总结（不超过50字）",
  "cards": [
    {
      "type": "info|action|choice|task|event",
      "title": "卡片标题",
      "description": "详细说明（可选）",
      "url": "链接（可选）",
      "actions": [
        {
          "label": "按钮文字",
          "value": "人类可读的完整文本（如'查看我的所有仓库'）"
        }
      ]
    }
  ]
}
\`\`\`

### 卡片类型说明
- **info**: 信息展示（title, description, url）
- **action**: 单个操作（title, description, actions）
- **choice**: 多个选项（title, actions）
- **task**: 任务卡片（title, status, description）
- **event**: 日程卡片（title, time, location）
- **error**: 错误提示（title, description）

## 工作流程

先调用工具拿到真实数据，再按工具结果组织回复；回复里的每个数字、标题、人名、链接都必须来自工具结果，不得使用任何示例或占位内容。

### 示例 3：无数据时
用户："我的项目"

如果 GitHub 未连接或返回空，不要调用工具，直接回复：
\`\`\`json
{
  "text": "你还没有连接 GitHub",
  "cards": [{
    "type": "action",
    "title": "连接数据源",
    "description": "连接后即可查看你的项目和 PR",
    "actions": [{"label": "前往设置页面", "value": "打开设置"}]
  }]
}
\`\`\`

## 按钮值规则
所有按钮的 value 必须是用户能说出口的完整句子：
- ✅ "查看我的 GitHub PR"
- ✅ "打开设置页面"
- ✅ "标记任务'修复bug'为完成"
- ❌ "view_prs"
- ❌ "github_pull_requests"
- ❌ "open_settings"

点击按钮后，value 会作为新的用户消息发送给你，所以它必须是合理的人类问句。

## 记住
1. 需要真实数据时，先调用工具
2. 基于工具返回的真实数据生成卡片
3. 没有数据时诚实告知并引导用户连接
4. 按钮值必须是人类语言
5. 回复简洁，信息用卡片展示
6. 绝不编造任何数据
`
