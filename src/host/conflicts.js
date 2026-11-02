// 冲突并列（#32 S5）：两个 app 对同一件事各说一个值，卡片上两个都得写出来，还要说清采信哪条。
//
// 只在渲染时从 `event.sources[]` 派生：没有任何代码写 `state.days`（`grep -rn 'days\[' src index.js`
// 是 0 条），所以这里不新增聚合层、不改 `buildEvent()`，也不读时钟 / 盘 / 网。
// 同一组 sources、不管顺序如何，都给同一个结果 —— 排序是写死的三条：先「硬时间」，再「at 更早」，
// 最后「ref 字典序小」。
//
// 说法相反（`state`）不投票：两个源说 open 和 done，就把两个都列出来、`chosen` 留 null（记未知）。
// 数值型的量（金额之类）不在这里猜口径。

export const FIELD_DUE_AT = 'due_at'
export const FIELD_STATE = 'state'

// `why` 是给人看的原话，逐字写死：测试和卡片读同一份字符串。
export const WHY_HARD = '日程是硬时间'
export const WHY_EARLIER = '时间更早的那条'
export const WHY_REF = '先按来源名'

const FIELDS = [FIELD_DUE_AT, FIELD_STATE]

const text = value => (typeof value === 'string' ? value.trim() : '')

// `at` 缺了或读不出来就排到最后：一条没有时间戳的证据不该赢过有时间戳的那条。
const msOf = value => {
  const ms = Date.parse(text(value))
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY
}

const byRef = (a, b) => (a.ref === b.ref ? 0 : a.ref < b.ref ? -1 : 1)

function compareValues(a, b) {
  const leftHard = a.due_kind === 'hard' ? 0 : 1
  const rightHard = b.due_kind === 'hard' ? 0 : 1
  if (leftHard !== rightHard) return leftHard - rightHard
  const left = msOf(a.at)
  const right = msOf(b.at)
  if (left !== right) return left < right ? -1 : 1
  return byRef(a, b)
}

function picked(row, why) {
  return { value: row.value, source: row.source, ref: row.ref, why }
}

// 采信哪条：唯一的硬时间直接赢；两个以上硬时间（或一个都不硬）时，取 `at` 更早的那条；
// `at` 也一样早就按 `ref` 字典序取小。`why` 说的就是最后生效的那一条规则。
function chosenOf(rows) {
  const hard = rows.filter(row => row.due_kind === 'hard')
  if (hard.length === 1) return picked(hard[0], WHY_HARD)
  const pool = hard.length > 1 ? hard : rows
  const earliestMs = Math.min(...pool.map(row => msOf(row.at)))
  const earliest = pool.filter(row => msOf(row.at) === earliestMs)
  if (earliest.length === 1) return picked(earliest[0], WHY_EARLIER)
  return picked([...earliest].sort(byRef)[0], WHY_REF)
}

// `conflictsOf(event)` → 0~2 项；同一字段的非空值去重后不足 2 个就不算冲突。
export function conflictsOf(event) {
  const sources = Array.isArray(event?.sources) ? event.sources : []
  const conflicts = []
  for (const field of FIELDS) {
    const seen = new Set()
    const rows = []
    for (const source of sources) {
      if (source === null || typeof source !== 'object') continue
      const value = text(source[field])
      if (value === '' || seen.has(value)) continue
      seen.add(value)
      rows.push({
        value,
        source: text(source.source) || null,
        ref: text(source.ref) || null,
        at: text(source.at) || null,
        due_kind: text(source.due_kind) || null,
      })
    }
    if (rows.length < 2) continue
    rows.sort(compareValues)
    conflicts.push({
      field,
      values: rows.map(row => ({ value: row.value, source: row.source, ref: row.ref, at: row.at })),
      // 说法相反就记未知，不投票。
      chosen: field === FIELD_STATE ? null : chosenOf(rows),
    })
  }
  return conflicts
}
