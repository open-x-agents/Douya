// Composio 适配器的契约（#32 S4）。
//
// 每个 app 一个适配器文件，形状固定五个成员：`{ id, readScope, auth, list, get }`。
// #10 的 `src/sources/contract.js` 还没合入，所以这里自带一个 `assertAdapter()`
// （5 个成员）；#10 合入后换成它的 `assertSource()`，四个适配器一行都不用改。
//
// 三条边界，每条都有一条测试盯着：
//   - 只读：适配器上出现任何写方法名直接 `E_WRITE_ACTION` —— 不留「先加上再说」的口子；
//   - 只到 metadata：`readScope` 恒为 `'metadata'`，`excerpt` 只放标题 / 邮件头 / 时间，
//     不放正文，也不碰附件那条路；
//   - ref 原样：`ref = composio:<toolkit>:<object>/<record_id>`，`record_id` 只许
//     `[A-Za-z0-9_.@/+~-]`；出现别的字符不猜不转义，由 `brief.js` 跳过该条并记
//     `partial: { reason: 'unsafe-record-id' }`。

export const READ_MEMBERS = ['id', 'readScope', 'auth', 'list', 'get']

// 写动作按方法名拒：名字里有这些动词就不是读方法。适配器只有 list/get，
// 这条是给「以后有人顺手加一个 markRead()」准备的。
export const WRITE_MEMBERS = [
  'send',
  'post',
  'create',
  'update',
  'delete',
  'remove',
  'write',
  'insert',
  'patch',
  'move',
  'reply',
  'forward',
  'archive',
  'trash',
  'markRead',
  'markAsRead',
  'star',
  'label',
]

// #10 的外部 ref 字符集：只许这些字符，别的字符不猜不转义。
export const RECORD_ID = /^[A-Za-z0-9_.@/+~-]+$/
export const REF_PATTERN = /^composio:[a-z_]+:(thread|event|page|message|file)\/[A-Za-z0-9_.@/+~-]+$/

export function coded(code, message, extra = {}) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  Object.assign(error, extra)
  return error
}

// 一个 adapter 的 id 就是它的 source id：`composio:<toolkit>`。
export function refFor(toolkit, object, recordId) {
  return `composio:${toolkit}:${object}/${String(recordId)}`
}

// 观察的形状（`list()` 每一条）：source / ref / external_id / title / excerpt / at /
// due_at / due_kind / people / state。缺字段就填默认值，不让 undefined 漏到卡片的 HTML 里。
export function observationOf({
  source,
  ref,
  external_id,
  title,
  excerpt,
  at = null,
  due_at = null,
  due_kind = null,
  people = [],
  state = 'open',
} = {}) {
  return {
    source,
    ref,
    external_id: external_id === undefined ? null : external_id,
    title: typeof title === 'string' ? title : '',
    excerpt: typeof excerpt === 'string' ? excerpt : '',
    at: at ?? null,
    due_at: due_at ?? null,
    due_kind: due_kind ?? null,
    people: Array.isArray(people) ? people.filter(person => typeof person === 'string' && person.length > 0) : [],
    state,
  }
}

// 适配器自检：五个成员、id 是 `composio:<toolkit>`、readScope 是 metadata、没有写方法。
// 违反任一条都是启动期的错，不是运行期的告警。
export function assertAdapter(adapter, label = 'adapter') {
  const target = adapter ?? {}
  for (const member of READ_MEMBERS) {
    if (!(member in target)) {
      throw coded('E_ADAPTER_SHAPE', `${label} 缺成员 ${member}`)
    }
  }
  if (!/^composio:[a-z_]+$/.test(String(target.id))) {
    throw coded('E_ADAPTER_SHAPE', `${label} 的 id 必须是 composio:<toolkit>，拿到 ${String(target.id)}`)
  }
  if (target.readScope !== 'metadata') {
    throw coded('E_ADAPTER_SHAPE', `${label} 的 readScope 必须是 metadata，拿到 ${String(target.readScope)}`)
  }
  if (typeof target.auth !== 'function' || typeof target.list !== 'function' || typeof target.get !== 'function') {
    throw coded('E_ADAPTER_SHAPE', `${label} 的 auth / list / get 必须是函数`)
  }
  for (const member of Object.keys(target)) {
    if (WRITE_MEMBERS.includes(member)) {
      throw coded('E_WRITE_ACTION', `${label} 上有写方法 ${member}：适配器只读，不接受写动作`)
    }
  }
  return true
}

// 适配器拿数据只过这一个口：`transport.proxyGet({ connectedAccountId, endpoint })`
// 返回第三方已经解析好的 JSON。真跑时它就是 `api.js` 的 `proxyGet`（控制面 POST、
// 第三方 GET）；离线时是 fixture 重放。适配器不认识 URL、key 与重试。
export function transportOf(transport, label = 'transport') {
  if (!transport || typeof transport.proxyGet !== 'function') {
    throw coded('E_TRANSPORT', `${label} 需要一个 proxyGet({ connectedAccountId, endpoint })`)
  }
  return transport
}

export function accountIdOf(account, label = 'adapter') {
  const accountId = account?.account_id
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw coded('E_AUTH', `${label} 没有可用的 connected account（auth() 应先返回 ok:false）`)
  }
  return accountId
}

// 少数 app 的读动作走 Composio 的 toolkit 动作口（`POST /tools/execute/<slug>`，
// 只落在控制面，见 `api.js`）：Slack 的 HTTP 接口不是 Gmail 那种相对路径形态，
// 走 proxy 得猜域名；而 `SLACK_LIST_CONVERSATIONS` / `SLACK_FETCH_CONVERSATION_HISTORY`
// 本来就在注册表白名单里、快照里有 `readOnlyHint`。适配器只传这两个读动作名。
export function executeOf(transport, label = 'transport') {
  if (!transport || typeof transport.executeTool !== 'function') {
    throw coded('E_TRANSPORT', `${label} 需要一个 executeTool({ toolSlug, connectedAccountId, arguments })`)
  }
  return transport
}
