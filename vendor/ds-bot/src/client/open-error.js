import { createElement as h, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { t } from './i18n.js'
import { rosterGate } from './roster-gate.js'

export const OPEN_DETAIL = 'Could not open this chat. {detail}'
// A failed workspace startup stays pending in that process. The page keeps
// asking, and a later successful answer clears the alert, but reloading the
// page does not start the process again.
export const OPEN_RECOVERY = 'Restart DS Bot after the session file can be read again. Refreshing this page does not restart the failed startup.'

export const openErrorCopy = detail => t(OPEN_DETAIL, { detail })
export const openRecoveryCopy = () => t(OPEN_RECOVERY)

// The chat body the shell paints even when no Session exists. `conversation.input.dock`
// does not: that list is session-scoped and is skipped while session and input are missing,
// which is the EACCES boot (workspace activation failed, bot route 404).
export const CHAT_ALERT_HOST = '[data-conversation-region="chat"]'

export function chatAlertHost(doc = document) {
  return doc.querySelector(CHAT_ALERT_HOST)
}

export function openErrorNode(detail, place) {
  return h('div', {
    className: place === 'sidebar' ? 'bt-hint bt-open-error' : 'bt-open-error',
    role: 'alert',
    'data-open-error': place,
  },
    h('p', { className: 'bt-open-error-line' }, openErrorCopy(detail)),
    h('p', { className: 'bt-open-error-line' }, openRecoveryCopy()))
}

// Registered on the shell overlay, which is mounted whenever the sidebar is.
// The node itself is portaled into the chat column, because the overlay is not
// part of that column and the composer dock is absent during this boot.
export function OpenErrorNotice({ useRoster }) {
  const roster = useRoster(value => value)
  const gate = rosterGate({
    ready: roster.ready === true,
    hasMain: roster.byId?.[roster.mainBotId] != null,
    loadError: roster.loadError,
  })
  const seen = gate.kind === 'error' && typeof document !== 'undefined' ? chatAlertHost() : null
  const [late, setLate] = useState(null)
  useLayoutEffect(() => {
    if (seen || gate.kind !== 'error') return undefined
    let frame = 0
    const find = () => {
      frame = 0
      const node = chatAlertHost()
      setLate(prev => (prev === node ? prev : node))
      if (node) observer.disconnect()
    }
    const observer = typeof MutationObserver === 'function'
      ? new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(find) })
      : null
    observer?.observe(document.body, { childList: true, subtree: true })
    find()
    return () => { cancelAnimationFrame(frame); observer?.disconnect() }
  }, [gate.kind, seen])
  const host = seen ?? late
  if (gate.kind !== 'error' || host == null) return null
  return createPortal(openErrorNode(gate.text, 'chat'), host)
}
