// Temporary views ("surfaces") Chief generates with odm_ui_render / odm_ui_update. Stored in state.surfaces
// (expire at the end of the day unless saved as a card), always re-hydrated from the store when shown, pushed to
// open tabs as 'surface' events, and attached to the chat reply. Form submits run here: a prompt goes back to the
// chat as the user's words; a draft only ever becomes a pending 待你确认 action.

import { validateSpec, validateDataModel } from './validate.js'
import { hydrateSurface, resolveSubmitArgs } from './hydrate.js'
import { shDay } from './ops.js'

const MAX_SURFACES = 100
const endOfShDay = (now) => new Date(Date.parse(`${shDay(now)}T23:59:59+08:00`)).toISOString()

export function createSurfaceService({ store, actions = {}, requestAction = null, emit = () => {}, log = () => {}, now = () => Date.now() }) {
  const all = () => ({ ...(store.get()?.surfaces || {}) })
  const persist = async (surfaces) => {
    const ids = Object.keys(surfaces)
    if (ids.length > MAX_SURFACES) for (const id of ids.sort((a, b) => String(surfaces[a].createdAt).localeCompare(String(surfaces[b].createdAt))).slice(0, ids.length - MAX_SURFACES)) if (!surfaces[id].savedCardId) delete surfaces[id]
    await store.save({ surfaces })
  }
  const view = (s) => hydrateSurface(s, store.get() || {}, { now: now() })
  const summarize = (v) => Object.entries(v.components).filter(([, c]) => c.rows || c.data || c.fields || c.pairs).map(([id, c]) => `${id}:${c.type}${c.rows ? ` ${c.rows.length} 行` : ''}${c.data ? ` ${c.data.length} 组` : ''}${c.fields ? ` ${c.fields.length} 个字段` : ''}`).join('，')

  async function render(input = {}, { cardId = null } = {}) {
    const v = validateSpec(input, { actions })
    if (!v.ok) return { success: false, error: v.error, path: v.path, hint: '按 path 改好再调 odm_ui_render' }
    const at = new Date(now()).toISOString()
    const s = { id: `sf_${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, spec: v.spec, cardId: input.cardId || cardId || null, by: 'bot', createdAt: at, updatedAt: at, expiresAt: endOfShDay(now()) }
    const h = view(s)
    if (!h.ok) return { success: false, error: h.error, path: h.path, hint: '引用必须是真实的卡片 id / 条目 url；按 path 改好再调' }
    await persist({ ...all(), [s.id]: s })
    emit({ kind: 'surface', phase: 'create', surfaceId: s.id, view: h.view, placement: v.spec.placement })
    log(`[ui] render ${s.id} 「${v.spec.title}」 ${summarize(h.view)}`)
    return { success: true, surfaceId: s.id, title: v.spec.title, placement: v.spec.placement, shows: summarize(h.view), refs: h.view.refs.map(r => r.title), note: '视图已显示在你的回复下方（用户可放到今天页或保存为卡片）。回复里一句话说明即可，不要再用文字重复表格内容。' }
  }

  async function update({ surfaceId, dataModel, title } = {}) {
    const cur = all()[surfaceId]
    if (!cur) return { success: false, error: `找不到视图 ${surfaceId}` }
    let patch = dataModel
    if (typeof patch === 'string') { try { patch = patch.trim() ? JSON.parse(patch) : {} } catch { return { success: false, error: 'dataModel 不是合法 JSON', path: 'dataModel' } } }
    let p
    try { p = validateDataModel(patch, 'dataModel', { patch: true }) } catch (e) { return { success: false, error: e.message, path: e.path } }
    const dm = { ...(cur.spec.dataModel || {}) }
    for (const [k, v] of Object.entries(p)) { if (v === null) delete dm[k]; else dm[k] = v }
    const spec = { ...cur.spec, dataModel: dm }
    if (title !== undefined) { if (typeof title !== 'string' || !title.trim() || title.length > 60) return { success: false, error: 'title 1–60 字', path: 'title' }; spec.title = title }
    const next = { ...cur, spec, updatedAt: new Date(now()).toISOString() }
    const h = view(next)
    if (!h.ok) return { success: false, error: h.error, path: h.path }
    await persist({ ...all(), [surfaceId]: next })
    emit({ kind: 'surface', phase: 'update', surfaceId, view: h.view })
    return { success: true, surfaceId, updated: Object.keys(p) }
  }

  function get(id) {
    const s = all()[id]
    if (!s) return { success: false, error: 'not found' }
    const h = view(s)
    return h.ok ? { success: true, view: h.view } : { success: false, error: h.error, expired: true }
  }
  /** Views the bot created since `ms` (attached to that chat reply). */
  function since(ms) {
    return Object.values(all()).filter(s => s.by === 'bot' && Date.parse(s.createdAt) >= ms).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map(s => view(s)).filter(h => h.ok).map(h => h.view)
  }

  /** 保存为卡片: a type=view card (no sourceId, so digests never overwrite it). The spec is re-hydrated on load. */
  async function saveAsCard(id) {
    const s = all()[id]
    if (!s) return { success: false, error: '视图不存在' }
    if (s.savedCardId && (store.get()?.cards || []).some(c => c.id === s.savedCardId && c.status !== 'deleted')) return { success: true, cardId: s.savedCardId, already: true }
    const h = view(s)
    if (!h.ok) return { success: false, error: h.error }
    const at = new Date(now()).toISOString()
    const card = { id: `card_view_${now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, type: 'view', source: 'bot', title: s.spec.title, body: `豆芽生成的视图 · 引用 ${h.view.refs.length} 张卡`, status: 'active', priority: 'medium', createdAt: at, updatedAt: at, blocks: [{ type: 'surface', surfaceId: id, spec: s.spec }] }
    await store.save({ cards: [card], surfaces: { ...all(), [id]: { ...s, savedCardId: card.id, expiresAt: null } } })
    emit({ kind: 'cards', reason: 'view-saved', cardId: card.id, message: `已保存为卡片「${s.spec.title}」` })
    return { success: true, cardId: card.id }
  }

  /** Hydrated view for a saved view card (null if it no longer resolves). */
  function cardView(card) {
    const b = (card?.blocks || []).find(x => x?.type === 'surface' && x.spec)
    if (!b) return null
    const h = hydrateSurface({ id: b.surfaceId || card.id, spec: b.spec, createdAt: card.createdAt, savedCardId: card.id }, store.get() || {}, { now: now() })
    return h.ok ? h.view : { error: h.error }
  }

  /** The owner's form submit. values: { fieldName: string|boolean }. */
  async function submit({ surfaceId, component, values = {} } = {}) {
    const s = all()[surfaceId] || (() => { const card = (store.get()?.cards || []).find(c => (c.blocks || []).some(b => b?.type === 'surface' && b.surfaceId === surfaceId)); const b = card?.blocks.find(x => x.type === 'surface'); return b ? { id: surfaceId, spec: b.spec, cardId: null } : null })()
    if (!s) return { success: false, error: '视图不存在或已过期' }
    const c = s.spec.components[component]
    if (!c || c.type !== 'Form') return { success: false, error: '不是表单' }
    const clean = {}
    for (const f of c.fields) {
      let v = values?.[f.name]
      if (f.kind === 'checkbox') v = v === true || v === 'true'
      else {
        v = typeof v === 'string' ? v.slice(0, 4000) : ''
        if (f.kind === 'select' && v && !f.options.some(o => o.value === v)) return { success: false, error: `「${f.label}」的选项无效` }
        if (f.required && !v.trim()) return { success: false, error: `请填写「${f.label}」` }
      }
      clean[f.name] = v
    }
    const d = c.submit.do
    if (d.prompt !== undefined) {
      const text = resolveSubmitArgs({ t: d.prompt }, clean, store.get() || {}).t
      return { success: true, kind: 'prompt', text: String(text).slice(0, 2000) }
    }
    const def = actions[d.draft.action]
    if (!def || def.risk !== 'confirm' || !requestAction) return { success: false, error: '表单只能生成待确认操作' }
    let args
    try { args = resolveSubmitArgs(d.draft.args, clean, store.get() || {}) } catch (e) { return { success: false, error: e.message } }
    const r = await requestAction(d.draft.action, { ...args, cardId: args.cardId || s.cardId || undefined }, { cardId: s.cardId || null })
    if (!r?.success || !r.pending) return { success: false, error: r?.error || '没能生成待确认操作' }
    log(`[ui] form ${surfaceId}/${component} → pending ${r.actionId}`)
    return { success: true, kind: 'draft', actionId: r.actionId, summary: r.summary }
  }

  return { render, update, get, since, saveAsCard, cardView, submit }
}
