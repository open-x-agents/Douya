// Gmail 适配器（#32 S4）：只读邮件主题与五个邮件头，**不读正文、不碰附件**。
//
// 真跑的路径来自 2026-10-31 的真探测：`/gmail/v1/users/me/threads` 列线程，
// 每条线程再用 `format=metadata&metadataHeaders=From&…&metadataHeaders=Message-ID` 取头 ——
// 这条路径的响应里 `payload` 只有 `{ mimeType, headers }`，没有 `body`、没有 `parts`。
// **`snippet` 一律不读**（它长度 200，是正文的第一段），所以「只读 metadata」是这里的选择，
// 不是靠响应里碰巧没有正文。
//
// 写动作一个都没有：没有发信、没有改标签、没有归档、没有取附件的方法名。

import { authOf } from './accounts.js'
import { accountIdOf, assertAdapter, observationOf, refFor, transportOf } from './adapter.js'

export const id = 'composio:gmail'
export const readScope = 'metadata'
export const MAX_ITEMS = 10
export const OBJECT = 'thread'

const LIST_PATH = '/gmail/v1/users/me/threads'
const METADATA_HEADERS = ['From', 'To', 'Subject', 'Date', 'Message-ID']
const METADATA_QUERY = `format=metadata&${METADATA_HEADERS.map(name => `metadataHeaders=${name}`).join('&')}`

export function threadEndpoint(threadId) {
  return `${LIST_PATH}/${encodeURIComponent(threadId)}?${METADATA_QUERY}`
}

function header(headers, name) {
  const found = (Array.isArray(headers) ? headers : []).find(
    item => String(item?.name ?? '').toLowerCase() === name.toLowerCase(),
  )
  return typeof found?.value === 'string' ? found.value : ''
}

function isoOf(value) {
  const at = Date.parse(String(value ?? ''))
  return Number.isFinite(at) ? new Date(at).toISOString() : null
}

// 一个线程 → 一条观察。`excerpt` 只由邮件头拼成：正文一个字都不进来。
export function observationOfThread(thread) {
  const messages = Array.isArray(thread?.messages) ? thread.messages : []
  const message = messages.length > 0 ? messages[messages.length - 1] : null
  const headers = message?.payload?.headers
  const threadId = String(thread?.id ?? message?.threadId ?? '')
  if (threadId === '') throw new Error('E_GMAIL_SHAPE: 线程没有 id')

  const subject = header(headers, 'Subject') || '(无主题)'
  const from = header(headers, 'From')
  const to = header(headers, 'To')
  const date = header(headers, 'Date')
  const messageId = header(headers, 'Message-ID')

  const excerpt = [
    from ? `From: ${from}` : '',
    to ? `To: ${to}` : '',
    date ? `Date: ${date}` : '',
    messageId ? `Message-ID: ${messageId}` : '',
  ]
    .filter(part => part.length > 0)
    .join('；')

  return observationOf({
    source: id,
    ref: refFor('gmail', OBJECT, threadId),
    external_id: threadId,
    title: subject,
    excerpt,
    at: isoOf(date),
    due_at: null,
    due_kind: null,
    people: [from, to],
    state: 'open',
  })
}

export function createGmailAdapter({ account, transport } = {}) {
  const auth = authOf(account)
  const proxy = transportOf(transport, 'gmail adapter')

  const adapter = {
    id,
    readScope,

    // 授权状态来自 S2 的按人解析（`{ ok, reason }`），适配器不自己判。
    auth() {
      return { ...auth }
    },

    // 列线程：`since` 折成 Gmail 的 `after:<秒>`；`cursor` 是上一页的 pageToken。
    async list(since, cursor) {
      const accountId = accountIdOf(account, 'gmail adapter')
      const params = [`maxResults=${MAX_ITEMS}`]
      const sinceMs = Date.parse(String(since ?? ''))
      if (Number.isFinite(sinceMs)) params.push(`q=after:${Math.floor(sinceMs / 1000)}`)
      if (typeof cursor === 'string' && cursor.length > 0) {
        params.push(`pageToken=${encodeURIComponent(cursor)}`)
      }

      const page = await proxy.proxyGet({
        connectedAccountId: accountId,
        endpoint: `${LIST_PATH}?${params.join('&')}`,
      })
      const threads = Array.isArray(page?.threads) ? page.threads : []

      const observations = []
      for (const thread of threads.slice(0, MAX_ITEMS)) {
        const threadId = String(thread?.id ?? '')
        if (threadId === '') continue
        const full = await proxy.proxyGet({
          connectedAccountId: accountId,
          endpoint: threadEndpoint(threadId),
        })
        observations.push(observationOfThread({ ...full, id: full?.id ?? threadId }))
      }

      return { observations, cursor: page?.nextPageToken ?? null }
    },

    // 按 ref 取一条：ref 形如 `composio:gmail:thread/<id>`，别的 ref 一律 null。
    async get(ref) {
      const prefix = refFor('gmail', OBJECT, '')
      const text = String(ref ?? '')
      if (!text.startsWith(prefix)) return null
      const accountId = accountIdOf(account, 'gmail adapter')
      const threadId = text.slice(prefix.length)
      if (threadId === '') return null
      const full = await proxy.proxyGet({
        connectedAccountId: accountId,
        endpoint: threadEndpoint(threadId),
      })
      return observationOfThread({ ...full, id: full?.id ?? threadId })
    },
  }

  assertAdapter(adapter, 'gmail adapter')
  return adapter
}

export { assertAdapter }

// 注册表 / `brief.js` 的默认加载只认 `create`：加一个 app 只加一行 + 一个文件。
export const create = createGmailAdapter
