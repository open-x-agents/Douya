// Strict structural validation of a temporary-view spec (no store access). Unknown component types, unknown
// props, wrong shapes and oversize input are rejected with a path so Chief can fix and retry (A2UI-style errors).
// Store checks (ids exist, links are real) happen in hydrate.js.

import { CATALOG, LIMITS, ITEM_FIELDS, CARD_FIELDS, GROUP_BY } from './catalog.js'
import { UI_OPS } from './ops.js'

const ID = /^[A-Za-z][\w-]{0,39}$/
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)
class SpecError extends Error { constructor(path, msg) { super(msg); this.path = path } }
const fail = (path, msg) => { throw new SpecError(path, msg) }

function str(v, path, max, { required = false } = {}) {
  if (v === undefined || v === null || v === '') { if (required) fail(path, '必填'); return undefined }
  if (typeof v !== 'string') fail(path, '必须是字符串')
  if (v.length > max) fail(path, `太长（最多 ${max} 字）`)
  // Text is shown with textContent, but refuse obvious markup / script payloads outright.
  if (/<\s*\/?\s*(script|iframe|img|svg|style|object|embed|link|meta)\b|javascript\s*:|\bon[a-z]+\s*=/i.test(v)) fail(path, '不能包含 HTML / 脚本')
  return v
}
function onlyKeys(o, allowed, path) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${path}.${k}`, `不支持的字段「${k}」，可用：${allowed.join(', ')}`)
}
function dataRef(v, path, max) {
  if (isObj(v)) { onlyKeys(v, ['$data'], path); if (!ID.test(String(v.$data || ''))) fail(`${path}.$data`, 'dataModel 的 key'); return { $data: v.$data } }
  return str(v, path, max)
}

export function validateSource(s, path) {
  if (!isObj(s)) fail(path, 'source 必须是对象 {card|cards, rows}')
  onlyKeys(s, ['card', 'cards', 'rows', 'where', 'limit'], path)
  if (!s.card && !s.cards) fail(path, '要给 card（卡片 id）或 cards（"needs-you" | "all" | [id…]）')
  if (s.card) str(s.card, `${path}.card`, 200)
  if (s.cards !== undefined && !(s.cards === 'needs-you' || s.cards === 'all' || (Array.isArray(s.cards) && s.cards.length <= 30 && s.cards.every(x => typeof x === 'string' && x.length < 200)))) fail(`${path}.cards`, '"needs-you" | "all" | [卡片 id…]')
  const rows = s.rows || (s.card ? 'items' : 'cards')
  if (!['items', 'cards'].includes(rows)) fail(`${path}.rows`, '"items" | "cards"')
  let where
  if (s.where !== undefined) {
    if (!isObj(s.where)) fail(`${path}.where`, '必须是对象')
    onlyKeys(s.where, ['status', 'type', 'source'], `${path}.where`)
    if (s.where.status && !['open', 'done', 'dismissed', 'all'].includes(s.where.status)) fail(`${path}.where.status`, 'open | done | dismissed | all')
    if (s.where.type && !['pr', 'issue', 'email', 'slack', 'other'].includes(s.where.type)) fail(`${path}.where.type`, 'pr | issue | email | slack | other')
    if (s.where.source && !['github', 'gmail', 'slack', 'googlecalendar', 'manual', 'bot'].includes(s.where.source)) fail(`${path}.where.source`, 'github | gmail | slack …')
    where = { ...s.where }
  }
  const limit = s.limit === undefined ? LIMITS.rows : Number(s.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.rows) fail(`${path}.limit`, `1–${LIMITS.rows}`)
  return { card: s.card, cards: s.cards, rows, where, limit }
}
const fieldSet = (src) => (src.rows === 'items' ? ITEM_FIELDS : CARD_FIELDS)
function validateFields(list, src, path, max) {
  if (!Array.isArray(list) || !list.length) fail(path, '至少一个字段')
  if (list.length > max) fail(path, `最多 ${max} 个`)
  const allowed = fieldSet(src)
  return list.map((f, i) => {
    const key = typeof f === 'string' ? f : isObj(f) ? f.key : null
    if (isObj(f)) onlyKeys(f, ['key', 'label'], `${path}[${i}]`)
    if (!allowed[key]) fail(`${path}[${i}]`, `字段「${key}」不可用，可用：${Object.keys(allowed).join(', ')}`)
    return { key, label: isObj(f) && f.label ? str(f.label, `${path}[${i}].label`, LIMITS.label) : allowed[key] }
  })
}
function validateDo(d, path, { row = false } = {}) {
  if (!isObj(d)) fail(path, 'do 必须是对象')
  const keys = Object.keys(d)
  if (keys.length !== 1) fail(path, 'do 只能有一个：openLink / openCard / uiOp / prompt')
  const [k] = keys
  if (k === 'openLink') { const v = str(d.openLink, `${path}.openLink`, 600, { required: true }); if (!(row && v === '$row.url') && !/^https:\/\//.test(v)) fail(`${path}.openLink`, '只能是卡片里已有的 https 链接' + (row ? '或 "$row.url"' : '')); return { openLink: v } }
  if (k === 'openCard') { const v = str(d.openCard, `${path}.openCard`, 200, { required: true }); return { openCard: v } }
  if (k === 'prompt') return { prompt: str(d.prompt, `${path}.prompt`, LIMITS.prompt, { required: true }) }
  if (k === 'uiOp') {
    if (!isObj(d.uiOp) || !UI_OPS.includes(d.uiOp.op)) fail(`${path}.uiOp`, `uiOp.op 必须是 ${UI_OPS.join(' / ')}`)
    if (JSON.stringify(d.uiOp).length > 800) fail(`${path}.uiOp`, '太长')
    return { uiOp: { ...d.uiOp } }
  }
  fail(path, `按钮不能「${k}」：只能 openLink / openCard / uiOp / prompt（不能发送、确认或执行）`)
}
function validateButtons(list, path, max, opts) {
  if (!Array.isArray(list) || !list.length) fail(path, '至少一个按钮')
  if (list.length > max) fail(path, `最多 ${max} 个`)
  return list.map((b, i) => { if (!isObj(b)) fail(`${path}[${i}]`, '按钮必须是对象'); onlyKeys(b, ['label', 'do'], `${path}[${i}]`); return { label: str(b.label, `${path}[${i}].label`, LIMITS.label, { required: true }), do: validateDo(b.do, `${path}[${i}].do`, opts) } })
}
function validatePairs(list, path) {
  if (!Array.isArray(list) || !list.length) fail(path, '至少一对')
  if (list.length > LIMITS.pairs) fail(path, `最多 ${LIMITS.pairs} 对`)
  return list.map((p, i) => {
    const pp = `${path}[${i}]`
    if (!isObj(p)) fail(pp, '必须是 {label, value}')
    onlyKeys(p, ['label', 'value'], pp)
    const label = str(p.label, `${pp}.label`, LIMITS.label, { required: true })
    const v = p.value
    if (isObj(v) && v.$count !== undefined) { onlyKeys(v, ['$count'], `${pp}.value`); return { label, value: { $count: validateSource(v.$count, `${pp}.value.$count`) } } }
    if (isObj(v) && v.$card !== undefined) {
      onlyKeys(v, ['$card'], `${pp}.value`)
      if (!isObj(v.$card)) fail(`${pp}.value.$card`, '{card, field}')
      onlyKeys(v.$card, ['card', 'field'], `${pp}.value.$card`)
      if (!['title', 'next', 'priority', 'source', 'status'].includes(v.$card.field)) fail(`${pp}.value.$card.field`, 'title | next | priority | source | status')
      return { label, value: { $card: { card: str(v.$card.card, `${pp}.value.$card.card`, 200, { required: true }), field: v.$card.field } } }
    }
    if (typeof v === 'number') fail(`${pp}.value`, '数字不能自己写：用 {"$count": source}')
    return { label, value: dataRef(v, `${pp}.value`, LIMITS.text) }
  })
}
function validateFormFields(list, path) {
  if (!Array.isArray(list) || !list.length) fail(path, '至少一个字段')
  if (list.length > LIMITS.fields) fail(path, `最多 ${LIMITS.fields} 个`)
  const names = new Set()
  return list.map((f, i) => {
    const pp = `${path}[${i}]`
    if (!isObj(f)) fail(pp, '字段必须是对象')
    onlyKeys(f, ['name', 'kind', 'label', 'options', 'value', 'required', 'placeholder'], pp)
    if (!ID.test(String(f.name || ''))) fail(`${pp}.name`, '字母开头的英文名')
    if (names.has(f.name)) fail(`${pp}.name`, '重名')
    names.add(f.name)
    if (!['text', 'textarea', 'select', 'checkbox'].includes(f.kind)) fail(`${pp}.kind`, 'text | textarea | select | checkbox')
    const out = { name: f.name, kind: f.kind, label: str(f.label, `${pp}.label`, LIMITS.label, { required: true }), required: !!f.required }
    if (f.placeholder !== undefined) out.placeholder = str(f.placeholder, `${pp}.placeholder`, LIMITS.label)
    if (f.kind === 'select') {
      if (!Array.isArray(f.options) || !f.options.length || f.options.length > LIMITS.options) fail(`${pp}.options`, `1–${LIMITS.options} 个选项`)
      out.options = f.options.map((o, j) => {
        if (typeof o === 'string') return { label: str(o, `${pp}.options[${j}]`, 120, { required: true }), value: o }
        if (!isObj(o)) fail(`${pp}.options[${j}]`, '{label, value}')
        onlyKeys(o, ['label', 'value'], `${pp}.options[${j}]`)
        return { label: str(o.label, `${pp}.options[${j}].label`, 120, { required: true }), value: str(String(o.value ?? o.label), `${pp}.options[${j}].value`, 200, { required: true }) }
      })
    } else if (f.options !== undefined) fail(`${pp}.options`, '只有 select 有 options')
    if (f.value !== undefined) {
      if (f.kind === 'checkbox') { if (typeof f.value !== 'boolean' && !isObj(f.value)) fail(`${pp}.value`, 'true / false'); out.value = isObj(f.value) ? dataRef(f.value, `${pp}.value`) : f.value }
      else out.value = dataRef(f.value, `${pp}.value`, LIMITS.template)
    }
    return out
  })
}
function validateArgValue(v, path, fieldNames) {
  if (typeof v === 'string') {
    str(v, path, LIMITS.template)
    for (const m of v.matchAll(/(?:\{\{|\[\[)\s*([\w-]+)\s*(?:\}\}|\]\])/g)) if (!fieldNames.has(m[1])) fail(path, `{{${m[1]}}} 不是表单字段`)
    return v
  }
  if (isObj(v) && v.$field !== undefined) { onlyKeys(v, ['$field'], path); if (!fieldNames.has(v.$field)) fail(`${path}.$field`, '不是表单字段'); return { $field: v.$field } }
  if (isObj(v) && v.$item !== undefined) {
    onlyKeys(v, ['$item', 'field'], path)
    if (!isObj(v.$item)) fail(`${path}.$item`, '{card, item}')
    onlyKeys(v.$item, ['card', 'item'], `${path}.$item`)
    if (!['url', 'from', 'threadId', 'title'].includes(v.field || 'url')) fail(`${path}.field`, 'url | from | threadId | title')
    return { $item: { card: str(v.$item.card, `${path}.$item.card`, 200, { required: true }), item: str(v.$item.item, `${path}.$item.item`, 600, { required: true }) }, field: v.field || 'url' }
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v
  fail(path, '参数只能是文字模板、{"$field"} 或 {"$item"}')
}
function validateSubmit(s, path, fields, actions) {
  if (!isObj(s)) fail(path, 'submit 必须是 {label, do}')
  onlyKeys(s, ['label', 'do'], path)
  const label = str(s.label, `${path}.label`, LIMITS.label, { required: true })
  if (!isObj(s.do) || Object.keys(s.do).length !== 1) fail(`${path}.do`, 'do 只能是 {"prompt"} 或 {"draft"}')
  const names = new Set(fields.map(f => f.name))
  if (s.do.prompt !== undefined) return { label, do: { prompt: validateArgValue(s.do.prompt, `${path}.do.prompt`, names) } }
  if (s.do.draft !== undefined) {
    const d = s.do.draft
    if (!isObj(d)) fail(`${path}.do.draft`, '{action, args}')
    onlyKeys(d, ['action', 'args'], `${path}.do.draft`)
    const def = actions?.[d.action]
    if (!def) fail(`${path}.do.draft.action`, `未知操作「${d.action}」`)
    if (def.risk !== 'confirm') fail(`${path}.do.draft.action`, '表单只能生成需要用户确认的操作（待你确认卡），不能直接执行')
    if (!isObj(d.args)) fail(`${path}.do.draft.args`, '必须是对象')
    const allowed = [...Object.keys(def.params || {}), 'cardId', 'title', 'url']
    onlyKeys(d.args, allowed, `${path}.do.draft.args`)
    for (const [k, p] of Object.entries(def.params || {})) if (p?.required && d.args[k] === undefined) fail(`${path}.do.draft.args.${k}`, '必填参数')
    const args = {}
    for (const [k, v] of Object.entries(d.args)) args[k] = validateArgValue(v, `${path}.do.draft.args.${k}`, names)
    return { label, do: { draft: { action: d.action, args } } }
  }
  fail(`${path}.do`, `表单提交只能 prompt 或 draft，不能「${Object.keys(s.do)[0]}」`)
}
function validateAnnotations(a, path) {
  if (!isObj(a)) fail(path, '必须是 {行key: 文字}')
  const keys = Object.keys(a)
  if (keys.length > LIMITS.annotations) fail(path, `最多 ${LIMITS.annotations} 条`)
  const out = {}
  for (const k of keys) out[k] = str(a[k], `${path}["${k.slice(0, 40)}"]`, 200, { required: true })
  return out
}

export function validateDataModel(dm, path = 'dataModel', { patch = false } = {}) {
  if (dm === undefined || dm === null) return {}
  if (!isObj(dm)) fail(path, '必须是对象')
  if (JSON.stringify(dm).length > LIMITS.dataBytes) fail(path, `太大（最多 ${LIMITS.dataBytes} 字节）`)
  const keys = Object.keys(dm)
  if (keys.length > LIMITS.dataKeys) fail(path, `最多 ${LIMITS.dataKeys} 个 key`)
  const out = {}
  for (const k of keys) {
    if (!ID.test(k)) fail(`${path}.${k}`, 'key 必须是字母开头的英文名')
    const v = dm[k]
    if (v === null) { if (!patch) fail(`${path}.${k}`, 'null 只能在 odm_ui_update 里用来删除'); out[k] = null; continue }
    if (typeof v === 'string') out[k] = str(v, `${path}.${k}`, LIMITS.template)
    else if (typeof v === 'boolean') out[k] = v
    else if (typeof v === 'number') fail(`${path}.${k}`, '数字不能自己写，用组件里的 $count')
    else if (Array.isArray(v) && v.length <= 50 && v.every(x => typeof x === 'string' && x.length <= 600)) out[k] = v.map((x, i) => str(x, `${path}.${k}[${i}]`, 600))
    else fail(`${path}.${k}`, '值只能是文字、true/false 或文字数组')
  }
  return out
}

/**
 * Validate a render request. Returns { ok, spec } or { ok:false, error, path }.
 * spec = { title, placement, root, components: { id: normalized }, dataModel }
 */
export function validateSpec(input, { actions = {} } = {}) {
  try {
    if (!isObj(input)) fail('', '必须是对象')
    onlyKeys(input, ['title', 'placement', 'components', 'dataModel', 'cardId'], '')
    let comps = input.components
    if (typeof comps === 'string') { try { comps = JSON.parse(comps) } catch { fail('components', '不是合法 JSON') } }
    let dm = input.dataModel
    if (typeof dm === 'string') { try { dm = dm.trim() ? JSON.parse(dm) : {} } catch { fail('dataModel', '不是合法 JSON') } }
    if (JSON.stringify(comps ?? null).length + JSON.stringify(dm ?? null).length > LIMITS.specBytes) fail('components', `视图太大（最多 ${LIMITS.specBytes} 字节）`)
    const title = str(input.title, 'title', LIMITS.title, { required: true })
    const placement = input.placement === undefined ? 'chat' : input.placement
    if (!['chat', 'panel'].includes(placement)) fail('placement', 'chat | panel')
    if (!Array.isArray(comps) || !comps.length) fail('components', '必须是非空数组')
    if (comps.length > LIMITS.components) fail('components', `最多 ${LIMITS.components} 个组件`)
    const out = {}
    comps.forEach((c, i) => {
      const p = `components[${i}]`
      if (!isObj(c)) fail(p, '组件必须是对象')
      if (!ID.test(String(c.id || ''))) fail(`${p}.id`, '字母开头的英文 id')
      if (out[c.id]) fail(`${p}.id`, `重复的 id「${c.id}」`)
      const def = CATALOG[c.type]
      if (!def) fail(`${p}.type`, `不支持的组件「${c.type}」，可用：${Object.keys(CATALOG).join(', ')}`)
      onlyKeys(c, ['id', 'type', ...Object.keys(def.props)], p)
      const n = { type: c.type }
      for (const [k, kind] of Object.entries(def.props)) {
        const v = c[k], pp = `${p}.${k}`
        if (v === undefined) continue
        if (kind === 'label') n[k] = str(v, pp, LIMITS.label)
        else if (kind === 'bool') { if (typeof v !== 'boolean') fail(pp, 'true / false'); n[k] = v }
        else if (kind.startsWith('enum:')) { if (!kind.slice(5).split('|').includes(v)) fail(pp, kind.slice(5).replace(/\|/g, ' | ')); n[k] = v }
        else if (kind === 'dataText') n[k] = dataRef(v, pp, LIMITS.longText)
        else if (kind === 'children') { if (!Array.isArray(v) || v.length > 30 || !v.every(x => typeof x === 'string')) fail(pp, 'children 是组件 id 数组'); n[k] = [...v] }
        else if (kind === 'source') n[k] = validateSource(v, pp)
        else if (kind === 'groupBy') { if (!GROUP_BY.includes(v)) fail(pp, GROUP_BY.join(' | ')); n[k] = v }
        else if (kind === 'annotations') n[k] = validateAnnotations(v, pp)
        else if (kind === 'pairs') n[k] = validatePairs(v, pp)
        else if (kind === 'formFields') n[k] = validateFormFields(v, pp)
        else if (kind === 'buttons') n[k] = validateButtons(v, pp, LIMITS.buttons)
        else if (kind === 'rowActions') n[k] = validateButtons(v, pp, 3, { row: true })
      }
      // shape checks that depend on several props
      if (['Table', 'List', 'Comparison', 'Timeline', 'Chart'].includes(c.type) && !n.source) fail(`${p}.source`, '必填')
      if (c.type === 'Table') n.columns = validateFields(c.columns ?? ['title'], n.source, `${p}.columns`, LIMITS.columns)
      if (c.type === 'List') n.fields = c.fields === undefined ? [] : validateFields(c.fields, n.source, `${p}.fields`, 4)
      if (c.type === 'Comparison') n.fields = validateFields(c.fields ?? ['from', 'at', 'status'], n.source, `${p}.fields`, LIMITS.columns)
      if (c.type === 'Chart') { n.kind = n.kind || 'bar'; n.groupBy = n.groupBy || 'status' }
      if (['Text', 'Callout'].includes(c.type) && n.text === undefined) fail(`${p}.text`, '必填')
      if (c.type === 'KeyValue' && !n.pairs) fail(`${p}.pairs`, '必填')
      if (c.type === 'Buttons' && !n.buttons) fail(`${p}.buttons`, '必填')
      if (c.type === 'Form') { if (!n.fields) fail(`${p}.fields`, '必填'); if (!c.submit) fail(`${p}.submit`, '必填'); n.submit = validateSubmit(c.submit, `${p}.submit`, n.fields, actions) }
      out[c.id] = n
    })
    const root = out.root ? 'root' : comps[0].id
    // children must exist; no cycles; depth limit
    const seen = new Set()
    const walk = (id, depth, path) => {
      if (depth > LIMITS.depth) fail(path, `嵌套太深（最多 ${LIMITS.depth} 层）`)
      if (seen.has(id)) fail(path, `组件「${id}」被引用了两次或成环`)
      seen.add(id)
      for (const ch of out[id].children || []) { if (!out[ch]) fail(`${path}.children`, `没有 id 为「${ch}」的组件`); walk(ch, depth + 1, `${path}>${ch}`) }
    }
    walk(root, 1, root)
    const dataModel = validateDataModel(dm)
    return { ok: true, spec: { title, placement, root, components: out, dataModel } }
  } catch (e) {
    if (e instanceof SpecError) return { ok: false, error: e.message, path: e.path }
    throw e
  }
}
