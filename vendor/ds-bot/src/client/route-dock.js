import { createElement as h, useEffect, useState, useSyncExternalStore } from 'react'
import { settleHoldAction } from './hold-action.js'
import { t } from './i18n.js'
import { createSource } from './sources.js'

// A composer send that is not a choice on the open route card. The card stays;
// this only records that the send was not a choice.
const routeMiss = createSource({})

function mentionsId(text, id) {
  return typeof id === 'string' && id.length >= 8 && text.includes(id.toLowerCase())
}

/** Same matches as the host's answerChoice: id, session id, or 续：label. */
export function choiceMatches(text, pending) {
  const choices = pending?.choices ?? []
  const trimmed = String(text ?? '').trim()
  const named = /^(?:续[:：])\s*(\S(?:.*\S)?)\s*$/.exec(trimmed)
  if (named?.[1]) {
    const label = named[1].trim()
    if (choices.some(choice => choice.id === label || choice.sessionId === label)) return true
    return choices.filter(choice => choice.label === label).length === 1
  }
  if (choices.some(choice => choice.id === trimmed || choice.sessionId === trimmed)) return true
  const lower = trimmed.toLowerCase()
  return choices.filter(choice => mentionsId(lower, choice.id) || mentionsId(lower, choice.sessionId)).length === 1
}

export function noteRouteComposerSend(sessionId, text, pending) {
  if (typeof sessionId !== 'string' || sessionId === '') return
  if (pending == null || choiceMatches(text, pending)) {
    routeMiss.set((state) => {
      if (state[sessionId] === undefined) return state
      const next = { ...state }
      delete next[sessionId]
      return next
    })
    return
  }
  routeMiss.set(state => ({ ...state, [sessionId]: String(text ?? '') }))
}

function choiceLabel(choice) {
  if (typeof choice?.label === 'string' && choice.label.trim() !== '') return choice.label.trim()
  const id = typeof choice?.id === 'string' ? choice.id : ''
  return id.length > 8 ? id.slice(-8) : id
}

function choiceBotName(choice, roster) {
  const bot = roster?.byId?.[choice?.botId]
  if (typeof bot?.name === 'string' && bot.name !== '') return bot.name
  return typeof choice?.botId === 'string' ? choice.botId : ''
}

// Room sessions only. The card is the stored pending route.
// Highlight is emphasis. Nothing here sends it.
function PrivateHoldDock({ sessionId, useRoster, actions }) {
  const hold = useRoster(value => value.privateHolds?.[sessionId])
  const [sending, setSending] = useState(false)
  const [fault, setFault] = useState('')
  if (hold == null) return null
  const latest = Array.isArray(hold.items) ? hold.items[hold.items.length - 1] : undefined
  const text = typeof latest?.text === 'string' ? latest.text : ''
  if (text === '') return null
  const choices = Array.isArray(hold.choices) ? hold.choices : []
  const bound = hold.status === 'bound'
  const given = bound && hold.delivered === true
  const generation = hold.generation
  const unsaved = (hold.items ?? []).some(item => item?.outcome === 'unrecoverable' || item?.outcome === 'queue-failed')
  const choose = (id) => {
    if (sending || given || typeof id !== 'string' || id === '' || typeof generation !== 'number' || typeof actions.confirmPrivate !== 'function') return
    setSending(true)
    void settleHoldAction(() => actions.confirmPrivate(sessionId, id, generation)).then((result) => {
      setFault(result.ok ? '' : result.message)
    }).finally(() => setSending(false))
  }
  const retry = () => {
    if (sending || typeof actions.retryPrivateSave !== 'function') return
    setSending(true)
    void settleHoldAction(() => actions.retryPrivateSave(sessionId)).then((result) => {
      setFault(result.ok ? '' : result.message)
    }).finally(() => setSending(false))
  }
  return h('div', { className: 'bt-route-dock', 'data-route-dock': 'private', 'data-private-hold': hold.status ?? 'pending', 'data-private-unsaved': unsaved ? '' : undefined },
    h('div', { className: 'bt-route', role: 'group', 'aria-label': t('Which line should this go on?') },
      h('p', { className: 'bt-route-text' }, text),
      unsaved ? h('p', { className: 'bt-route-miss', 'data-private-unsaved-note': '' }, t('Not saved. Copy this sentence and send it again if you still want it.')) : null,
      fault !== '' ? h('p', { className: 'bt-route-miss', 'data-private-save-error': '' }, fault) : null,
      unsaved ? h('button', { type: 'button', className: 'bt-route-choice', disabled: sending, onClick: retry }, t('Save this hold again')) : null,
      given
        ? h('p', { className: 'bt-route-miss', 'data-private-delivered': '' }, `${t('Given to this line. The model can answer it now.')} ${t('Opening another chat is not part of this step.')}`)
        : h('div', { className: 'bt-route-list' },
          bound ? h('p', { className: 'bt-route-miss' }, `${t('Bound. The model has not been given this sentence.')} ${t('Opening another chat is not part of this step.')}`) : null,
          choices.map((choice) => {
          const id = typeof choice?.id === 'string' ? choice.id : ''
          const label = choiceLabel(choice)
          return h('button', {
            key: id !== '' ? id : label,
            type: 'button',
            className: 'bt-route-choice',
            disabled: sending || id === '',
            'data-highlight': hold.highlight === id ? '' : undefined,
            onClick: () => choose(id),
          },
          h('span', { className: 'bt-route-choice-name' }, label),
          h('span', { className: 'bt-route-choice-state' }, t('Bind to this line')))
        }))))
}

export function RouteDock({ sessionId, useRoster, actions }) {
  const room = useRoster(value => value.roomsById?.[sessionId])
  const pending = useRoster(value => value.pendingRoutes?.[sessionId])
  const roster = useRoster(value => value)
  const miss = useSyncExternalStore(routeMiss.subscribe, () => routeMiss.getSnapshot()[sessionId])
  const [sending, setSending] = useState(false)
  const cardKey = pending == null ? '' : `${pending.at ?? ''}:${pending.text ?? ''}`
  useEffect(() => () => { noteRouteComposerSend(sessionId, '', null) }, [sessionId, cardKey])
  if (room == null) return h(PrivateHoldDock, { sessionId, useRoster, actions })
  if (pending == null || typeof pending.text !== 'string') return null
  const choices = Array.isArray(pending.choices) ? pending.choices : []
  const choose = (id) => {
    if (sending || typeof id !== 'string' || id === '' || typeof actions.send !== 'function') return
    setSending(true)
    void Promise.resolve(actions.send(sessionId, id)).finally(() => setSending(false))
  }
  return h('div', { className: 'bt-route-dock', 'data-route-dock': '' },
    h('div', { className: 'bt-route', role: 'group', 'aria-label': t('Which line should this go on?') },
      h('p', { className: 'bt-route-text' }, pending.text),
      h('div', { className: 'bt-route-list' }, choices.map((choice) => {
        const id = typeof choice?.id === 'string' ? choice.id : ''
        const label = choiceLabel(choice)
        const name = choiceBotName(choice, roster)
        const busy = choice?.busy === true
        return h('button', {
          key: id !== '' ? id : label,
          type: 'button',
          className: 'bt-route-choice',
          disabled: sending || id === '',
          'data-highlight': pending.highlight === id ? '' : undefined,
          'data-busy': busy ? '' : undefined,
          onClick: () => choose(id),
        },
        h('span', { className: 'bt-route-choice-name' }, name !== '' ? `${name} · ${label}` : label),
        h('span', { className: 'bt-route-choice-state' }, busy ? t('Busy') : t('Idle')))
      })),
      typeof miss === 'string' && miss !== '' ? h('p', { className: 'bt-route-miss' }, t('That message was not a choice.')) : null))
}
