// Google Drive 适配器（#32 S6）：只读文件元数据（名字 / 类型 / 修改时间 / 属主），
// **不下载内容、不导出、不建、不改、不分享、不移动、不删**。
//
// 真跑路径：`GET /drive/v3/files` 列文件（`fields` 只要元数据），单条 `GET /drive/v3/files/<id>`。
// 两者都是 GET；`/export`、`?alt=media`、`/permissions`、上传端点一个都没有。`fields` 里没有
// `content` —— 「只读 metadata」是这里的选择，不是靠响应碰巧不带内容。
//
// 一条文件 → 一条观察：`ref = composio:googledrive:file/<fileId>`。Drive 的 id 字符集
// （字母、数字、`-`、`_`）落在 `adapter.js` 的 `RECORD_ID` 里，不需要转义。

import { authOf } from './accounts.js'
import { accountIdOf, assertAdapter, observationOf, refFor, transportOf } from './adapter.js'

export const id = 'composio:googledrive'
export const readScope = 'metadata'
export const PAGE_SIZE = 25
export const OBJECT = 'file'

const FILES_PATH = '/drive/v3/files'
// 只要元数据：名字、类型、修改时间、属主。不含 content，也不含 permissions。
const FIELDS = 'id,name,mimeType,modifiedTime,owners(displayName,emailAddress)'

export function listEndpoint(since, cursor) {
  const params = [`pageSize=${PAGE_SIZE}`, `fields=${encodeURIComponent(`nextPageToken,files(${FIELDS})`)}`]
  const sinceMs = Date.parse(String(since ?? ''))
  if (Number.isFinite(sinceMs)) {
    params.push(`q=${encodeURIComponent(`modifiedTime > '${new Date(sinceMs).toISOString()}'`)}`)
  }
  if (typeof cursor === 'string' && cursor.length > 0) {
    params.push(`pageToken=${encodeURIComponent(cursor)}`)
  }
  return `${FILES_PATH}?${params.join('&')}`
}

export function fileEndpoint(fileId) {
  return `${FILES_PATH}/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(FIELDS)}`
}

function isoOf(value) {
  const at = Date.parse(String(value ?? ''))
  return Number.isFinite(at) ? new Date(at).toISOString() : null
}

function ownersOf(file) {
  return (Array.isArray(file?.owners) ? file.owners : [])
    .map(owner => owner?.displayName || owner?.emailAddress)
    .filter(value => typeof value === 'string' && value.length > 0)
}

// 一个文件 → 一条观察。`excerpt` 只由类型、修改时间、属主拼成：内容一个字都不进来。
export function observationOfFile(file) {
  const fileId = String(file?.id ?? '')
  if (fileId === '') throw new Error('E_DRIVE_SHAPE: 文件没有 id')

  const name = String(file?.name ?? '').trim() || '(无标题)'
  const mimeType = String(file?.mimeType ?? '')
  const modified = isoOf(file?.modifiedTime)
  const people = ownersOf(file)
  const excerpt = [mimeType, modified, people.join('、')]
    .filter(value => typeof value === 'string' && value.length > 0)
    .join('；')

  return observationOf({
    source: id,
    ref: refFor('googledrive', OBJECT, fileId),
    external_id: fileId,
    title: name,
    excerpt,
    at: modified,
    due_at: null,
    due_kind: null,
    people,
    state: 'open',
  })
}

export function createGoogledriveAdapter({ account, transport } = {}) {
  const auth = authOf(account)
  const proxy = transportOf(transport, 'googledrive adapter')

  const adapter = {
    id,
    readScope,

    // 授权状态来自 S2 的按人解析（`{ ok, reason }`），适配器不自己判。
    auth() {
      return { ...auth }
    },

    // 列文件：`since` 折成 Drive 的 `modifiedTime > '<ISO>'`；`cursor` 是上一页的 pageToken。
    async list(since, cursor) {
      const accountId = accountIdOf(account, 'googledrive adapter')
      const page = await proxy.proxyGet({
        connectedAccountId: accountId,
        endpoint: listEndpoint(since, cursor),
      })
      const files = Array.isArray(page?.files) ? page.files : []

      return {
        observations: files.slice(0, PAGE_SIZE).map(observationOfFile),
        cursor: page?.nextPageToken ?? null,
      }
    },

    // 按 ref 取一条：ref 形如 `composio:googledrive:file/<id>`，别的 ref 一律 null。
    async get(ref) {
      const prefix = refFor('googledrive', OBJECT, '')
      const text = String(ref ?? '')
      if (!text.startsWith(prefix)) return null
      const fileId = text.slice(prefix.length)
      if (fileId === '') return null
      const accountId = accountIdOf(account, 'googledrive adapter')
      const file = await proxy.proxyGet({
        connectedAccountId: accountId,
        endpoint: fileEndpoint(fileId),
      })
      return observationOfFile({ ...file, id: file?.id ?? fileId })
    },
  }

  assertAdapter(adapter, 'googledrive adapter')
  return adapter
}

export { assertAdapter }

// 注册表 / `brief.js` 的默认加载只认 `create`：加一个 app 只加一行 + 一个文件。
export const create = createGoogledriveAdapter
