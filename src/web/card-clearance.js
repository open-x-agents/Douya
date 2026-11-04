// When every item on a card is done/dismissed, the face already says 「都处理完了」— but the card used to stay
// active with stale 「下一步」/「进行中」. This module decides clearance from live itemStatus and (optionally)
// marks the card done so it leaves Today and shows up in 「今天搞定了什么」. Re-digest still reopens only when
// genuinely new actionable items appear (reconcile.js).

import { cardLinks, isWorkCard, linkType } from './card-prep.js'
import { recordCompletion, cardItemUrls } from '../host/store.js'

const CLOSED = new Set(['done', 'dismissed'])
const TERMINAL = new Set(['done', 'dismissed', 'archived', 'merged'])

const statusOf = (url, itemStatus = {}, card = null) => {
  const s = itemStatus[url]?.status || card?.itemStatus?.[url]?.status
  return CLOSED.has(s) ? s : 'open'
}

/**
 * Live progress for a card.
 * @returns {{total:number, open:import('./card-prep.js').*?[], done:number, needYou:*, waitingOthers:number, kind:'cleared'|'waiting'|'active'|'empty'}}
 */
export function cardClearance(card, itemStatus = {}) {
  if (!isWorkCard(card) || TERMINAL.has(card.status)) return { kind: 'empty', total: 0, open: [], done: 0, needYou: [], waitingOthers: 0 }
  const links = cardLinks(card)
  if (!links.length) return { kind: 'empty', total: 0, open: [], done: 0, needYou: [], waitingOthers: 0 }
  const open = links.filter(l => statusOf(l.url, itemStatus, card) === 'open')
  const done = links.length - open.length
  const needYou = open.filter(l => l.needsYou || (card.waiting === 'you' && (linkType(l) === 'email' || linkType(l) === 'slack')))
  // Quiet strip only when nothing needs you: waiting==='others', or a github cluster tagged 「N 件等别人」
  // without also being tagged 「等你/待你审」. FYI mail / slack / promo stay as full cards.
  const tagText = (card.blocks || []).flatMap(b => b?.type === 'tags' ? (b.tags || []).map(t => String(t?.text || '')) : [])
  const tagYou = tagText.some(t => /等你|待你审/.test(t))
  const tagOthers = tagText.some(t => /等别人/.test(t))
  const waitingOthers = (!needYou.length && !tagYou && (card.waiting === 'others' || (card.source === 'github' && tagOthers))) ? open.length : 0
  if (!open.length) return { kind: 'cleared', total: links.length, open, done, needYou, waitingOthers: 0 }
  if (waitingOthers) return { kind: 'waiting', total: links.length, open, done, needYou, waitingOthers }
  return { kind: 'active', total: links.length, open, done, needYou, waitingOthers: 0 }
}

/** Mark one cleared card done (idempotent). Mutates state.cards / state.completions. */
export function completeClearedCard(state, card, { by = 'user', at = new Date().toISOString() } = {}) {
  if (!card || TERMINAL.has(card.status)) return false
  card.status = 'done'
  card.completedAt = at
  card.completedBy = by
  card.updatedAt = at
  card.nextAction = ''
  if (Array.isArray(card.actions)) card.actions = []
  state.completions = recordCompletion(state.completions, card, { action: 'done', by })
  return true
}

/**
 * Sweep active work cards: all-items-done → status done. Returns ids newly completed.
 * Waiting-only cards are left active (caller annotates them for the quiet strip).
 */
export function sweepClearedCards(state, { by = 'system', now = new Date().toISOString() } = {}) {
  const itemStatus = state.itemStatus || {}
  const doneIds = []
  for (const c of state.cards || []) {
    if (!isWorkCard(c) || (c.status && c.status !== 'active' && c.status !== 'waiting')) continue
    const clr = cardClearance(c, itemStatus)
    if (clr.kind !== 'cleared') continue
    if (completeClearedCard(state, c, { by, at: now })) doneIds.push(c.id)
  }
  return doneIds
}

/** Annotate a live card for the client: clearance + strip CTAs when cleared/waiting. */
export function applyClearance(card, itemStatus = {}) {
  const clr = cardClearance(card, itemStatus)
  if (clr.kind === 'cleared') {
    return { ...card, clearance: 'cleared', nextAction: '', actions: [], prepared: [] }
  }
  if (clr.kind === 'waiting') {
    const first = clr.open[0]
    return {
      ...card,
      clearance: 'waiting',
      waitingOnly: true,
      waitingCount: clr.open.length,
      waitingLabel: first ? (first.title || first.url) : '',
      nextAction: '',
      // Keep prepared for zoom; the tile hides CTAs via waitingOnly.
    }
  }
  return { ...card, clearance: clr.kind === 'empty' ? 'active' : clr.kind }
}

export { cardItemUrls }
