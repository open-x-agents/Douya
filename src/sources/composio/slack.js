// Slack 适配器（#32 S4）：只读频道消息，不发消息、不改频道、不删消息。
//
// Slack 的两个读动作走 Composio 的 toolkit 动作口：`SLACK_LIST_CONVERSATIONS` 与
// `SLACK_FETCH_CONVERSATION_HISTORY` —— 这两个名字本来就在注册表白名单里，快照里带
// `readOnlyHint`；发消息 / 改频道这类写动作一个都不在注册表里，这里也没有它的方法。
//
// 一条消息 → 一条观察：`ref = composio:slack:message/<channel>/<ts>`（ts 里的 `.` 在
// ref 字符集里是合法的）。取的是频道里的消息文本，不追回复、不读文件、不点表情。

import { authOf } from './accounts.js'
import { accountIdOf, assertAdapter, executeOf, observationOf, refFor } from './adapter.js'

export const id = 'composio:slack'
export const readScope = 'metadata'
export const MAX_CHANNELS = 5
export const MAX_MESSAGES = 10
export const OBJECT = 'message'

export const LIST_TOOL = 'SLACK_LIST_CONVERSATIONS'
export const HISTORY_TOOL = 'SLACK_FETCH_CONVERSATION_HISTORY'

const firstLine = value =>
  String(value ?? '')
    .split('\n')[0]
    .trim()

const cut = (value, size) => {
  const text = String(value ?? '')
  return text.length > size ? `${text.slice(0, size)}…` : text
}

// Composio 的动作结果有两种外壳：v3 的 `{ data }` 与旧版的 `{ response_data }`。
function payloadOf(result) {
  if (result && typeof result === 'object') {
    if (result.data && typeof result.data === 'object') return result.data
    if (result.response_data && typeof result.response_data === 'object') return result.response_data
  }
  return result ?? {}
}

function isoOfTs(ts) {
  const seconds = Number(String(ts ?? '').split('.')[0])
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return new Date(seconds * 1000).toISOString()
}

// 一条消息 → 一条观察。`excerpt` 是消息文本的前 160 字（这是消息本身的可见内容，
// 不是「读正文」的越界：Slack 的读动作返回的就是它）。
export function observationOfMessage(message, channel = {}) {
  const ts = String(message?.ts ?? '')
  if (ts === '') throw new Error('E_SLACK_SHAPE: 消息没有 ts')
  const channelId = String(channel?.id ?? message?.channel ?? '')

  const text = String(message?.text ?? '')
  const name = String(channel?.name ?? channelId)
  const title = cut(firstLine(text) || '(无内容)', 60)

  return observationOf({
    source: id,
    ref: refFor('slack', OBJECT, `${channelId}/${ts}`),
    external_id: `${channelId}/${ts}`,
    title,
    excerpt: `#${name}；${cut(text, 160)}`,
    at: isoOfTs(ts),
    due_at: null,
    due_kind: null,
    people: [message?.user],
    state: 'open',
  })
}

export function createSlackAdapter({ account, transport } = {}) {
  const auth = authOf(account)
  const proxy = executeOf(transport, 'slack adapter')

  const adapter = {
    id,
    readScope,

    auth() {
      return { ...auth }
    },

    async list(since) {
      const accountId = accountIdOf(account, 'slack adapter')
      const listed = payloadOf(
        await proxy.executeTool({
          toolSlug: LIST_TOOL,
          connectedAccountId: accountId,
          arguments: { limit: MAX_CHANNELS, types: 'public_channel' },
        }),
      )
      const channels = Array.isArray(listed?.channels) ? listed.channels : []

      const sinceSeconds = Number(Date.parse(String(since ?? ''))) / 1000
      const oldest = Number.isFinite(sinceSeconds) ? String(Math.floor(sinceSeconds)) : undefined

      const observations = []
      for (const channel of channels.slice(0, MAX_CHANNELS)) {
        const history = payloadOf(
          await proxy.executeTool({
            toolSlug: HISTORY_TOOL,
            connectedAccountId: accountId,
            arguments: {
              channel: channel?.id,
              limit: MAX_MESSAGES,
              ...(oldest ? { oldest } : {}),
            },
          }),
        )
        const messages = Array.isArray(history?.messages) ? history.messages : []
        for (const message of messages.slice(0, MAX_MESSAGES)) {
          if (String(message?.ts ?? '') === '') continue
          observations.push(observationOfMessage(message, channel))
        }
      }

      // 频道列表是一次性取的（最多 5 个频道），消息按 `oldest` 截断，不需要翻页。
      return { observations, cursor: null }
    },

    async get(ref) {
      const prefix = refFor('slack', OBJECT, '')
      const text = String(ref ?? '')
      if (!text.startsWith(prefix)) return null
      const rest = text.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash <= 0) return null
      const channelId = rest.slice(0, slash)
      const ts = rest.slice(slash + 1)
      if (ts === '') return null

      const accountId = accountIdOf(account, 'slack adapter')
      const history = payloadOf(
        await proxy.executeTool({
          toolSlug: HISTORY_TOOL,
          connectedAccountId: accountId,
          arguments: { channel: channelId, latest: ts, inclusive: true, limit: 1 },
        }),
      )
      const messages = Array.isArray(history?.messages) ? history.messages : []
      const message = messages.find(item => String(item?.ts ?? '') === ts)
      if (!message) return null
      return observationOfMessage(message, { id: channelId })
    },
  }

  assertAdapter(adapter, 'slack adapter')
  return adapter
}

export { assertAdapter }

// 注册表 / `brief.js` 的默认加载只认 `create`：加一个 app 只加一行 + 一个文件。
export const create = createSlackAdapter
