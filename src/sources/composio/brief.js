// 多源同时在线（#32 S4）：四个 app 各跑各的，掉一个不拖整份早报。
//
// 三件写死的事：
//   1. **每 app 一个 3 秒预算**：复用 `src/host/schedule.js` 的 `runWithBudget()`（`attempts: 1`），
//      不新写超时。超时/报错只把**该源**记成 `partial: true`，其它 app 照常进早报，`complete: false`。
//   2. **读不到就点名**：`unread_sources` 放 source id（`composio:notion`），`gap_text` 用人话
//      点名 label（`Notion 没连上，这条只有邮件、谷歌日历依据`），后者能被现成的
//      `judgePanel()` 的 `E_UNREAD_MISSING` 认出来。
//   3. **每条 fact 都指回输入里的 ref**：`evidence_ref` 原样来自适配器的观察，不归一化、
//      不拼接；ref 字符集不合法的观察跳过并记 `partial: { reason: 'unsafe-record-id' }`。
//
// 这里不做 08:45 投递、不发飞书、不写盘（记录由 `scripts/composio-multi.mjs` 落 `--out`）。

import { runWithBudget } from '../../host/schedule.js'
import { REF_PATTERN, coded } from './adapter.js'
import { labelOf, registry as DEFAULT_REGISTRY } from './registry.js'

export const COMPOSIO_TIMEOUT_MS = 3000

export const NO_LIVING_TEXT = '这条没有依据'

// 读不到那个 app 时，说给人听的那一句。`label` 来自注册表（加 app 不用改这里）。
const GAP_PHRASES = {
  'no-person': label => `${label} 没连上`,
  'no-account': label => `${label} 没连上`,
  missing: label => `${label} 没连上`,
  expired: label => `${label} 凭据失效了，要重新授权`,
  ambiguous: label => `${label} 有 2 个账号，没法替你选`,
  scope: label => `${label} 授权少了权限，读不到这一块`,
  timeout: label => `${label} 超时了（3 秒）`,
  error: label => `${label} 这次没读出来`,
  'unsafe-record-id': label => `${label} 有条记录读不全`,
}

const clockMs = now => {
  const value = now()
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(ms) ? ms : Date.parse(new Date().toISOString())
}

const timeAnchor = excerpt => {
  const found = /([01]?\d|2[0-3]):[0-5]\d/.exec(String(excerpt ?? ''))
  return found ? found[0] : null
}

// 一条观察 → 一条 fact。`text` 里出现的时刻一定来自该源的 `excerpt`（闸会逐字比对），
// 所以不在这里加任何取自别处的时间。
export function factOf(observation, label) {
  const time = timeAnchor(observation?.excerpt)
  return {
    text: time ? `${label}：${observation.title}，${time}` : `${label}：${observation.title}`,
    evidence_ref: observation.ref,
    source: observation.source,
  }
}

// 默认的适配器加载：注册表一行里的 `adapter` 是相对本目录的路径，加一个 app 只加一行 + 一个文件。
async function loadAdapter(row, { account, transport, config }) {
  const module = await import(new URL(row.adapter, import.meta.url).href)
  const create = typeof module.create === 'function' ? module.create : module.default
  if (typeof create !== 'function') {
    throw coded('E_ADAPTER_SHAPE', `${row.toolkit} 的 ${row.adapter} 没有导出 create()`)
  }
  return create({ account, transport, ...(config ?? {}) })
}

function normalizeAccount(resolved) {
  if (!resolved || typeof resolved !== 'object') {
    return { state: 'missing', reason: 'no-person', account_id: null }
  }
  const state = typeof resolved.state === 'string' ? resolved.state : 'missing'
  return {
    state,
    reason: state === 'ok' ? null : (resolved.reason ?? state),
    account_id: resolved.account_id ?? null,
  }
}

function gapTextOf(unread, living) {
  if (unread.length === 0) return ''
  const missing = unread.map(({ label, reason }) => {
    const phrase = GAP_PHRASES[reason] ?? GAP_PHRASES[String(reason ?? 'missing')] ?? GAP_PHRASES.missing
    return phrase(label)
  })
  const suffix = living.length > 0 ? `，这条只有${living.join('、')}依据` : `，${NO_LIVING_TEXT}`
  return `${missing.join('，')}${suffix}`
}

// `buildBrief({ registry, accountFor, adapters, transport, config, since, now, schedule, cancel })`
//   accountFor(toolkit) → `{ state, reason, account_id }`（S2 的 `resolveAccount()` 的结果）
//   adapters           → 可选：toolkit → 适配器实例或 `(account) => 适配器`（测试注入用）
//   transport          → `{ proxyGet, executeTool }`（真跑时是 `api.js`，离线是 fixture 重放）
//   config             → 每个 app 的额外参数（例如 `config.notion.rootId`）
export async function buildBrief({
  registry = DEFAULT_REGISTRY,
  accountFor = null,
  adapters = {},
  transport = null,
  config = {},
  since = null,
  now = () => new Date(),
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  const at = new Date(clockMs(now)).toISOString()
  const sources = {}
  const unread = []
  const living = []
  const facts = []

  for (const row of Array.isArray(registry) ? registry : []) {
    const toolkit = row?.toolkit
    if (typeof toolkit !== 'string' || toolkit.length === 0) continue
    const sourceId = `composio:${toolkit}`
    const label = row.label ?? labelOf(sourceId) ?? toolkit
    const resolved = normalizeAccount(accountFor ? accountFor(toolkit) : null)

    // 授权没到 ok：不发明一条请求，也不拿别人的账号顶替。
    if (resolved.state !== 'ok') {
      sources[sourceId] = {
        state: resolved.state,
        reason: resolved.reason,
        account_id: null,
        ok: false,
        partial: false,
        latency_ms: null,
      }
      unread.push({ source: sourceId, label, reason: resolved.reason ?? resolved.state })
      continue
    }

    const startedAt = clockMs(now)
    let outcome = null
    try {
      const entry = adapters?.[toolkit]
      const adapter = typeof entry === 'function'
        ? await entry(resolved)
        : (entry ?? (await loadAdapter(row, { account: resolved, transport, config: config?.[toolkit] })))

      outcome = await runWithBudget(() => adapter.list(since, undefined), {
        timeoutMs: COMPOSIO_TIMEOUT_MS,
        attempts: 1,
        schedule,
        cancel,
        source: sourceId,
      })
    } catch (error) {
      outcome = {
        ok: false,
        value: undefined,
        failures: [{ source: sourceId, reason: 'error', message: String(error?.message ?? error) }],
      }
    }

    const latency_ms = clockMs(now) - startedAt

    if (!outcome.ok) {
      sources[sourceId] = {
        state: 'ok',
        reason: outcome.failures?.at(-1)?.reason === 'timeout' ? 'timeout' : 'error',
        account_id: resolved.account_id ?? null,
        ok: false,
        partial: true,
        latency_ms,
      }
      unread.push({ source: sourceId, label, reason: sources[sourceId].reason })
      continue
    }

    const observations = Array.isArray(outcome.value?.observations) ? outcome.value.observations : []
    const safe = []
    for (const observation of observations) {
      // ref 字符集不合法的记录不猜不转义：跳过它，但让这条源记 partial。
      if (!REF_PATTERN.test(String(observation?.ref ?? ''))) continue
      safe.push(observation)
    }
    const unsafe = observations.length - safe.length

    sources[sourceId] = {
      state: 'ok',
      reason: unsafe > 0 ? 'unsafe-record-id' : null,
      account_id: resolved.account_id ?? null,
      ok: unsafe === 0,
      partial: unsafe > 0,
      latency_ms,
    }
    if (unsafe > 0) {
      unread.push({ source: sourceId, label, reason: 'unsafe-record-id' })
    } else {
      living.push(label)
    }

    for (const observation of safe) {
      facts.push(factOf(observation, label))
    }
  }

  const unreadSources = unread.map(item => item.source)
  return {
    at,
    facts,
    sources,
    unread_sources: unreadSources,
    gap_text: gapTextOf(unread, living),
    complete: unreadSources.length === 0,
  }
}
