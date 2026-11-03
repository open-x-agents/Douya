// 按人授权：每个 app × 每个人一个 connected account，状态只有四种
// `ok | missing | expired | ambiguous`（`scope` 由一次子请求的 403 判出，见 `authReasonOf()`）。
//
// 这一段是纯函数：账号表由调用方传入（S3 的 `api.js` 用**复数参数** `toolkit_slugs` / `user_ids`
// 去取，单数参数会被 Composio 静默忽略，「按人」就悄悄变成「按所有人」），本文件不联网、
// 不认识任何 app 的字段，也不猜授权状态。
//
// 三条会咬人的约定：
//   - 解析键是 **(toolkit, userId)**：别人的 ACTIVE 账号不是这个人的授权，一条都不许借；
//   - 同一个 (toolkit, user) 有 2 个以上 ACTIVE → `ambiguous`，**绝不静默挑一个**
//     （挑错了等于拿别人的日历/邮件下结论）；
//   - `scope` 不是 `missing`：账号是好的，只是少了权限，`resolveAccount()` 不改判定，
//     由调用方拿 403 去问 `authReasonOf()`。

const ACTIVE = 'ACTIVE'
const EXPIRED = 'EXPIRED'

// `auth()` 的形状对齐 #10 的适配器契约：只有 `{ ok, reason }`，`reason` 取 `state` 的值。
export function authOf(resolved) {
  const state = typeof resolved === 'string' ? resolved : resolved?.state
  const ok = state === 'ok'
  return { ok, reason: ok ? null : (state ?? 'missing') }
}

function toolkitOf(account) {
  const raw = account?.toolkit ?? account?.toolkit_slug ?? account?.toolkitSlug
  const slug = typeof raw === 'string' ? raw : raw?.slug
  return typeof slug === 'string' && slug.length > 0 ? slug : null
}

function userOf(account) {
  const raw = account?.user_id ?? account?.userId
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

function statusOf(account) {
  const raw = account?.status
  return typeof raw === 'string' ? raw.toUpperCase() : null
}

function toolkitKey(toolkit) {
  if (typeof toolkit !== 'string' || toolkit.length === 0) return null
  return toolkit.startsWith('composio:') ? toolkit.slice('composio:'.length).split(':')[0] : toolkit
}

// 解析一个人在一个 app 上的授权状态。
//   ok        恰好 1 个 ACTIVE（`account_id` 是它）
//   missing   no-person：没给 userId；no-account：这个人名下没有可用账号
//   expired   这个人名下有 EXPIRED 账号（凭据失效，要重新授权）
//   ambiguous 同一 (toolkit,user) 有 2 个以上 ACTIVE —— 绝不允许静默挑一个，`account_id` 恒为 null
export function resolveAccount(accounts, { toolkit, userId } = {}) {
  const toolkitSlug = toolkitKey(toolkit)

  if (toolkitSlug === null) return { state: 'missing', reason: 'no-account', account_id: null }

  if (typeof userId !== 'string' || userId.length === 0) {
    // 没有「人」就没有授权可解析：别拿 `default` 或任何别人的账号顶替。
    return { state: 'missing', reason: 'no-person', account_id: null }
  }

  const rows = (Array.isArray(accounts) ? accounts : [])
    .filter(account => toolkitOf(account) === toolkitSlug && userOf(account) === userId)

  if (rows.length === 0) return { state: 'missing', reason: 'no-account', account_id: null }

  const active = rows.filter(account => statusOf(account) === ACTIVE)
  if (active.length === 1) return { state: 'ok', reason: null, account_id: active[0].id ?? null }
  if (active.length > 1) return { state: 'ambiguous', reason: 'ambiguous', account_id: null }

  // 一个 ACTIVE 都没有：EXPIRED 是「凭据失效」，其它未完成状态（INITIALIZING / FAILED …）
  // 算「还没连上」。两种都不是 ok —— 读不到就是读不到，不许乐观。
  const expired = rows.some(account => statusOf(account) === EXPIRED)
  return expired
    ? { state: 'expired', reason: 'expired', account_id: null }
    : { state: 'missing', reason: 'no-account', account_id: null }
}

const SCOPE_MARKERS = [
  'insufficientpermissions',
  'insufficient_permissions',
  'insufficient permissions',
  'insufficientperm',
  'insufficient_scope',
  'insufficient scope',
]

// 账号是 ACTIVE，但这次子请求被 403 `insufficientPermissions` 拒了 → `'scope'`（授权少了权限），
// 不是 `missing`。其它情况一律 `null`：判不准就别猜，调用方记 `error` 并让该源 partial。
export function authReasonOf(error) {
  if (!error || typeof error !== 'object') return null

  const candidates = [
    error.status,
    error.statusCode,
    error.body?.status,
    error.body?.error?.status,
    typeof error.code === 'number' ? error.code : undefined,
  ]
  const status = Number(candidates.find(value => value !== undefined && value !== null))
  if (status !== 403) return null

  const text = [
    error.message,
    error.body?.error?.message,
    error.body?.error?.code,
    error.body?.message,
    error.description,
  ]
    .filter(value => typeof value === 'string' || typeof value === 'number')
    .join(' ')
    .toLowerCase()

  return SCOPE_MARKERS.some(marker => text.includes(marker)) ? 'scope' : null
}
