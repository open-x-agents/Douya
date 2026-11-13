// Composio v3 控制面的纯传输层（#32 S3）。
//
// 这一层只做三件事：拼 URL、发请求、把失败分类。它**不认识** Gmail / Notion / Slack 的字段——
// 那些属于各 app 的适配器；也不实现任何写动作，注册表的只读白名单才是准绳。
//
// 三条会咬人的约定（都有测试，来自 2026-10-31T12:15Z 的真探测）：
//   - 账号表的过滤参数是**复数**：`?toolkit_slugs=<slug>&user_ids=<user>`。写成单数
//     `toolkit_slug` / `user_id` 会被服务端**静默忽略**，返回全部 30 条账号，「按人」就悄悄变成
//     「按所有人」。所以 `listAccounts()` 只收复数键，传单数键直接抛 `E_ACCOUNT_QUERY`。
//   - 对第三方（Gmail / 日历 …）的请求永远是 `POST /tools/execute/proxy` 且 body 里 `method: 'GET'`；
//     POST 只落在 Composio 的 `/tools/execute/` 上，别处一个都没有。
//   - key 只从调用方传入，不进日志、不进仓库、不进错误消息。
//
// 本文件不联网（fetch 可注入）、不读环境变量、不加依赖。

import { SNAPSHOT } from './capabilities.js'

export const API_BASE = SNAPSHOT.base_url
export const API_ERROR = 'E_COMPOSIO'
export const API_KEY_ERROR = 'E_COMPOSIO_KEY'
export const ACCOUNT_QUERY_ERROR = 'E_ACCOUNT_QUERY'
export const PROXY_METHOD_ERROR = 'E_PROXY_METHOD'
export const PROXY_ENDPOINT_ERROR = 'E_PROXY_ENDPOINT'
export const DEFAULT_LIMIT = 100

const SINGULAR_KEYS = ['toolkitSlug', 'toolkit_slug', 'userId', 'user_id']

function coded(code, message, extra = {}) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  Object.assign(error, extra)
  return error
}

function textOf(body) {
  if (!body || typeof body !== 'object') return typeof body === 'string' ? body.toLowerCase() : ''
  const values = [
    body.message,
    body.error?.message,
    body.error?.code,
    body.code,
    body.description,
    body.error_description,
  ]
  return values
    .filter(value => typeof value === 'string' || typeof value === 'number')
    .join(' ')
    .toLowerCase()
}

const SCOPE_MARKERS = [
  'insufficientpermissions',
  'insufficient_permissions',
  'insufficient permissions',
  'insufficientperm',
  'insufficient_scope',
  'insufficient scope',
]

// 把所有非 2xx 归成 `{ kind, status, reason }`：
//   auth       401 / 403（不是缺权限时）
//   scope      403 且服务端说 insufficientPermissions —— 账号是好的，只是少了权限
//   missing    404
//   rate_limit 429（`retry_after_ms` 单独挂在抛出的错误上）
//   client     其它 4xx
//   server     5xx
//   network    请求根本没发出去 / 没拿到响应（status = null）
//   ok         2xx
// 只在失败时调用它也安全：2xx 返回 kind: 'ok'。
export function callError(response = {}) {
  const status = Number.isFinite(Number(response.status)) ? Number(response.status) : null
  if (status === null) return { kind: 'network', status: null, reason: 'network-error' }
  if (status >= 200 && status < 300) return { kind: 'ok', status, reason: null }

  const text = textOf(response.body)

  if (status === 401) return { kind: 'auth', status, reason: 'unauthorized' }
  if (status === 403) {
    return SCOPE_MARKERS.some(marker => text.includes(marker))
      ? { kind: 'scope', status, reason: 'scope' }
      : { kind: 'auth', status, reason: 'forbidden' }
  }
  if (status === 404) return { kind: 'missing', status, reason: 'not-found' }
  if (status === 429) return { kind: 'rate_limit', status, reason: 'rate-limited' }
  if (status >= 500) return { kind: 'server', status, reason: 'server-error' }
  return { kind: 'client', status, reason: 'request-rejected' }
}

function retryAfterMs(headers) {
  const raw = typeof headers?.get === 'function' ? headers.get('retry-after') : headers?.['retry-after']
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null
}

function queryValue(value) {
  if (Array.isArray(value)) {
    return value
      .filter(item => item !== undefined && item !== null && String(item).length > 0)
      .map(item => String(item))
      .join(',')
  }
  if (value === undefined || value === null) return null
  return String(value)
}

function baseOf(baseUrl) {
  const value = typeof baseUrl === 'string' && baseUrl.length > 0 ? baseUrl : API_BASE
  return value.replace(/\/+$/, '')
}

function assertComposioApiOptions(options = {}) {
  if (typeof options.apiKey !== 'string' || options.apiKey.length === 0) {
    throw coded(API_KEY_ERROR, '缺 COMPOSIO_API_KEY（key 只从调用方传，不读环境变量、不落仓库）')
  }
  if (typeof options.fetch !== 'function' && typeof globalThis.fetch !== 'function') {
    throw coded(API_ERROR, '没有可用的 fetch（Node 18+ 自带，或显式注入）')
  }
}

// 参数校验必须在**发请求之前同步抛**：等到 await 才发现拿错了参数，调用方已经把
// 「按人」当成「按所有人」用了一轮。所以这些方法都是普通函数（返回 Promise），不是 async 函数。
export function createComposioApi(options = {}) {
  const { apiKey, baseUrl = API_BASE, fetch: injected } = options
  assertComposioApiOptions(options)
  const fetchImpl = injected ?? globalThis.fetch
  const base = baseOf(baseUrl)

  async function request(method, path, { query, body } = {}) {
    const url = new URL(`${base}${path}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      const encoded = queryValue(value)
      if (encoded !== null && encoded.length > 0) url.searchParams.set(key, encoded)
    }

    const headers = { 'x-api-key': apiKey, 'user-agent': 'douya' }
    if (body !== undefined) headers['content-type'] = 'application/json'

    let response
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (cause) {
      const error = coded(API_ERROR, 'network-error', {
        kind: 'network',
        status: null,
        reason: 'network-error',
      })
      error.cause = cause
      throw error
    }

    const text = await response.text()
    let parsed = null
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = text
      }
    }

    if (!response.ok) {
      const classified = callError({ status: response.status, body: parsed })
      // 错误消息只带 method + path + 分类：不带 key、不带响应正文（正文可能含别人的数据）。
      const error = coded(API_ERROR, `${method} ${path} → ${classified.status} ${classified.reason}`, {
        kind: classified.kind,
        status: classified.status,
        reason: classified.reason,
        retry_after_ms: classified.kind === 'rate_limit' ? retryAfterMs(response.headers) : null,
      })
      throw error
    }

    return parsed
  }

  return {
    baseUrl: base,

    // `GET /tools?toolkit_slug=<slug>&limit=100` —— 这个端点的单数参数是真的生效的
    // （真探测用它取数）；复数陷阱只在 `/connected_accounts`。
    listTools({ toolkitSlug, limit = DEFAULT_LIMIT, cursor } = {}) {
      if (toolkitSlug !== undefined && (typeof toolkitSlug !== 'string' || toolkitSlug.length === 0)) {
        throw coded(API_ERROR, 'listTools 的 toolkitSlug 必须是非空字符串')
      }
      return request('GET', '/tools', {
        query: { toolkit_slug: toolkitSlug, limit, cursor },
      })
    },

    // 账号表：只收复数键，且必须同时给「哪个 app」和「哪个人」。
    // 少了 userIds 就变成「所有人的账号」，那正是这条参数陷阱要防的事。
    listAccounts(query = {}) {
      if (!query || typeof query !== 'object' || Array.isArray(query)) {
        throw coded(ACCOUNT_QUERY_ERROR, 'listAccounts 只收一个对象：{ toolkitSlugs, userIds, limit }')
      }
      for (const key of Object.keys(query)) {
        if (['toolkitSlugs', 'userIds', 'limit'].includes(key)) continue
        if (SINGULAR_KEYS.includes(key)) {
          throw coded(
            ACCOUNT_QUERY_ERROR,
            `listAccounts 只收复数键 toolkitSlugs / userIds；${key} 会被 Composio 静默忽略（单数请求返回全部 30 条）`,
          )
        }
        throw coded(ACCOUNT_QUERY_ERROR, `listAccounts 不认识参数 ${key}`)
      }

      const toolkitSlugs = queryValue(query.toolkitSlugs)
      const userIds = queryValue(query.userIds)
      if (!toolkitSlugs) throw coded(ACCOUNT_QUERY_ERROR, 'listAccounts 必须给 toolkitSlugs（复数）')
      if (!userIds) throw coded(ACCOUNT_QUERY_ERROR, 'listAccounts 必须给 userIds（复数）：没有「人」就没有按人授权')

      return request('GET', '/connected_accounts', {
        query: { toolkit_slugs: toolkitSlugs, user_ids: userIds, limit: query.limit ?? DEFAULT_LIMIT },
      })
    },

    // 读第三方数据只走这一个口：Composio 控制面是 POST，真正发到第三方的永远是 GET。
    proxyGet({ connectedAccountId, endpoint, method } = {}) {
      if (method !== undefined && String(method).toUpperCase() !== 'GET') {
        throw coded(PROXY_METHOD_ERROR, `proxyGet 只发 GET，不接受 ${String(method)}`)
      }
      if (typeof connectedAccountId !== 'string' || connectedAccountId.length === 0) {
        throw coded(PROXY_ENDPOINT_ERROR, 'proxyGet 需要 connectedAccountId')
      }
      if (typeof endpoint !== 'string' || !endpoint.startsWith('/')) {
        throw coded(PROXY_ENDPOINT_ERROR, 'proxyGet 的 endpoint 必须是以 / 开头的第三方路径')
      }
      return request('POST', '/tools/execute/proxy', {
        body: {
          connected_account_id: connectedAccountId,
          method: 'GET',
          endpoint,
        },
      })
    },

    // 执行注册表白名单里的一个动作。本层不判只读——那是 `assertReadOnlyRegistry()` 的活。
    executeTool({ toolSlug, connectedAccountId, userId, arguments: args } = {}) {
      if (typeof toolSlug !== 'string' || !/^[A-Za-z0-9_]+$/.test(toolSlug)) {
        throw coded(API_ERROR, 'executeTool 的 toolSlug 只允许字母、数字与下划线')
      }
      const body = { arguments: args ?? {} }
      if (connectedAccountId !== undefined) body.connected_account_id = connectedAccountId
      if (userId !== undefined) body.user_id = userId
      return request('POST', `/tools/execute/${toolSlug}`, { body })
    },
  }
}
