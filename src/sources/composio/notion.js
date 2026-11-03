// Notion 适配器（#32 S4）：只读页面标题与创建时间，不建页、不改块、不写数据库行。
//
// Notion 的「列一份东西」在 API 里是「读某个父块的子块」：`GET /v1/blocks/<root>/children`
// （带 `start_cursor` 分页，是本仓里唯一真用游标的适配器），单条用 `GET /v1/pages/<id>`。
// 两个都是 GET；Notion 的 search / database query 都是 POST，本单一个都不用。
//
// `rootId` 由调用方给（`buildBrief` 的 `config.notion.rootId`，CLI 从 `COMPOSIO_NOTION_ROOT`
// 或 fixture 的 scenario 读）。不给就抛 `E_NOTION_ROOT` —— 让该源记 `error` + `partial`，
// 不猜一个根页面，也不静默返回空列表把「没连上」伪装成「今天没事」。

import { authOf } from './accounts.js'
import { accountIdOf, assertAdapter, coded, observationOf, refFor, transportOf } from './adapter.js'

export const id = 'composio:notion'
export const readScope = 'metadata'
export const PAGE_SIZE = 25
export const OBJECT = 'page'

const CHILDREN_PATH = '/v1/blocks'
const PAGES_PATH = '/v1/pages'

export function childrenEndpoint(rootId, cursor) {
  const params = [`page_size=${PAGE_SIZE}`]
  if (typeof cursor === 'string' && cursor.length > 0) params.push(`start_cursor=${encodeURIComponent(cursor)}`)
  return `${CHILDREN_PATH}/${encodeURIComponent(rootId)}/children?${params.join('&')}`
}

export function pageEndpoint(pageId) {
  return `${PAGES_PATH}/${encodeURIComponent(pageId)}`
}

// Notion 的标题藏在不同形状里：子页面块在 `child_page.title`，页面在 `properties.*.title[].plain_text`。
export function titleOf(block) {
  if (typeof block?.child_page?.title === 'string' && block.child_page.title.length > 0) {
    return block.child_page.title
  }
  const properties = block?.properties ?? {}
  for (const value of Object.values(properties)) {
    const parts = Array.isArray(value?.title) ? value.title : []
    const text = parts
      .map(part => (typeof part?.plain_text === 'string' ? part.plain_text : ''))
      .join('')
      .trim()
    if (text.length > 0) return text
  }
  if (typeof block?.title === 'string' && block.title.length > 0) return block.title
  return String(block?.type ?? '').trim() || '(无标题)'
}

function isoOf(value) {
  const at = Date.parse(String(value ?? ''))
  return Number.isFinite(at) ? new Date(at).toISOString() : null
}

// 一个块 / 页面 → 一条观察。只有元数据：标题、类型、创建时间。
export function observationOfBlock(block) {
  const blockId = String(block?.id ?? '')
  if (blockId === '') throw new Error('E_NOTION_SHAPE: 块没有 id')

  const created = block?.created_time ?? block?.last_edited_time ?? null
  const title = titleOf(block)
  const excerpt = [String(block?.type ?? 'page'), created].filter(value => typeof value === 'string' && value.length > 0).join('；')

  return observationOf({
    source: id,
    ref: refFor('notion', OBJECT, blockId),
    external_id: blockId,
    title,
    excerpt,
    at: isoOf(created),
    due_at: null,
    due_kind: null,
    people: [],
    state: 'open',
  })
}

export function createNotionAdapter({ account, transport, rootId } = {}) {
  const auth = authOf(account)
  const proxy = transportOf(transport, 'notion adapter')
  const root = typeof rootId === 'string' && rootId.length > 0 ? rootId : null

  const adapter = {
    id,
    readScope,

    auth() {
      return { ...auth }
    },

    async list(since, cursor) {
      if (root === null) {
        throw coded('E_NOTION_ROOT', 'notion 适配器没给 rootId（buildBrief 的 config.notion.rootId）')
      }
      const accountId = accountIdOf(account, 'notion adapter')
      const page = await proxy.proxyGet({
        connectedAccountId: accountId,
        endpoint: childrenEndpoint(root, cursor),
      })
      const results = Array.isArray(page?.results) ? page.results : []

      return {
        observations: results.slice(0, PAGE_SIZE).map(observationOfBlock),
        cursor: page?.next_cursor ?? null,
      }
    },

    async get(ref) {
      const prefix = refFor('notion', OBJECT, '')
      const text = String(ref ?? '')
      if (!text.startsWith(prefix)) return null
      const pageId = text.slice(prefix.length)
      if (pageId === '') return null
      const accountId = accountIdOf(account, 'notion adapter')
      const page = await proxy.proxyGet({
        connectedAccountId: accountId,
        endpoint: pageEndpoint(pageId),
      })
      return observationOfBlock({ ...page, id: page?.id ?? pageId })
    },
  }

  assertAdapter(adapter, 'notion adapter')
  return adapter
}

export { assertAdapter }

// 注册表 / `brief.js` 的默认加载只认 `create`：加一个 app 只加一行 + 一个文件。
export const create = createNotionAdapter
