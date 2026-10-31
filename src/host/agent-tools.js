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
          // Build query string based on type
          let q = `is:pr is:${state}`;
          if (query_type === 'involves_me') {
            q += ' involves:@me';
          } else if (query_type === 'review_requested') {
            q += ' review-requested:@me';
          } else if (query_type === 'authored_by_me') {
            q += ' author:@me';
          }
          
          const result = await composioClient.executeAction(
            'GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS',
            { q, per_page: 10 }
          )
          
          if (!result.data?.items || result.data.items.length === 0) {
            return { pullRequests: [], count: 0 }
          }

          return {
            pullRequests: result.data.items.map(pr => ({
              number: pr.number,
              title: pr.title,
              state: pr.state,
              url: pr.html_url,
              repo: pr.repository_url?.split('/').slice(-2).join('/') || 'unknown',
              author: pr.user?.login || 'unknown',
              createdAt: pr.created_at,
              updatedAt: pr.updated_at,
            })),
            count: result.data.items.length,
          }
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
            { state, per_page: 10 }
          )
          
          if (!result.data?.issues || result.data.issues.length === 0) {
            return { issues: [], count: 0 }
          }

          return {
            issues: result.data.issues.map(issue => ({
              number: issue.number,
              title: issue.title,
              state: issue.state,
              url: issue.html_url,
              repo: issue.repository_url?.split('/').slice(-2).join('/') || 'unknown',
              labels: (issue.labels || []).map(l => l.name),
              createdAt: issue.created_at,
              updatedAt: issue.updated_at,
            })),
            count: result.data.issues.length,
          }
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
      async execute({ max_results = 5, query = 'in:inbox' }) {
        try {
          const result = await composioClient.executeAction(
            'GMAIL_FETCH_EMAILS',
            { max_results, query }
          )
          
          if (!result.data?.messages || result.data.messages.length === 0) {
            return { messages: [], count: 0 }
          }

          return {
            messages: result.data.messages.map(msg => ({
              id: msg.id,
              threadId: msg.threadId,
              subject: msg.subject || '(无主题)',
              from: msg.from || 'unknown',
              snippet: msg.snippet || '',
              date: msg.internalDate || msg.date,
            })),
            count: result.data.messages.length,
          }
        } catch (error) {
          return { error: error.message, messages: [], count: 0 }
        }
      },
    },

    {
      name: 'calendar_list_events',
      description: '获取 Google Calendar 事件',
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
            { timeMin: time_min, timeMax: time_max, maxResults: max_results }
          )
          
          if (!result.data?.items || result.data.items.length === 0) {
            return { events: [], count: 0 }
          }

          return {
            events: result.data.items.map(event => ({
              id: event.id,
              summary: event.summary || '(无标题)',
              start: event.start?.dateTime || event.start?.date,
              end: event.end?.dateTime || event.end?.date,
              location: event.location || '',
              attendees: (event.attendees || []).length,
            })),
            count: result.data.items.length,
          }
        } catch (error) {
          return { error: error.message, events: [], count: 0 }
        }
      },
    },
  ]
}

/**
 * Enhanced system prompt for card-based responses with real tool data
 */
export const AGENT_SYSTEM_PROMPT = `你是「豆芽」（Open Digital Mate），用户的数字同事。

## 核心职责
- 管理任务和日程
- 监控 GitHub（仓库、PR、Issue）
- 查收 Gmail 邮件
- 提醒 Google Calendar 事件

## 可用工具
你可以调用以下工具获取真实数据：

1. **github_list_repos** - 列出用户的 GitHub 仓库
   参数: { per_page?: number, sort?: 'created'|'updated'|'pushed' }
   
2. **github_list_pull_requests** - 列出 Pull Requests
   参数: { state?: 'open'|'closed'|'all', per_page?: number }
   
3. **github_list_issues** - 列出 Issues
   参数: { state?: 'open'|'closed'|'all', per_page?: number }
   
4. **gmail_list_recent** - 获取最近的邮件
   参数: { maxResults?: number }
   
5. **calendar_list_events** - 获取日历事件
   参数: { timeMin?: string, timeMax?: string, maxResults?: number }

## 工具调用协议

当你需要真实数据时，返回 JSON：
\`\`\`json
{
  "tool_calls": [
    {
      "name": "github_list_pull_requests",
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

## 工作流程示例

### 示例 1：待处理 PR
用户："待处理 PR"

第1步 - 调用工具：
\`\`\`json
{
  "tool_calls": [{
    "name": "github_list_pull_requests",
    "arguments": {"state": "open", "per_page": 5}
  }]
}
\`\`\`

第2步 - 收到工具结果：
\`\`\`json
{
  "pullRequests": [
    {"number": 42, "title": "feat: add composio", "url": "...", "author": "user"}
  ],
  "count": 1
}
\`\`\`

第3步 - 最终回复：
\`\`\`json
{
  "text": "你有 1 个待处理 PR",
  "cards": [{
    "type": "info",
    "title": "feat: add composio",
    "description": "#42 · 作者: user",
    "url": "..."
  }]
}
\`\`\`

### 示例 2：我的仓库
用户："我的仓库"

第1步：
\`\`\`json
{
  "tool_calls": [{
    "name": "github_list_repos",
    "arguments": {"per_page": 10, "sort": "updated"}
  }]
}
\`\`\`

第2步 - 收到结果后：
\`\`\`json
{
  "text": "你有 5 个仓库，最近更新的是 openDigitalMate",
  "cards": [
    {"type":"info","title":"openDigitalMate","description":"3 stars · JavaScript","url":"..."},
    {"type":"info","title":"test-repo","description":"0 stars · Python","url":"..."}
  ]
}
\`\`\`

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
