import { createElement as h, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { openErrorView, openRecoveryCopy } from './open-error-copy.js'
import { rosterGate } from './roster-gate.js'

// The chat body the shell paints even when no Session exists. `conversation.input.dock`
// does not: that list is session-scoped and is skipped while session and input are missing,
// which is the EACCES boot (workspace activation failed, bot route 404).
export const CHAT_ALERT_HOST = '[data-conversation-region="chat"]'

export function chatAlertHost(doc = document) {
  return doc.querySelector(CHAT_ALERT_HOST)
}

export function openErrorNode(detail, place) {
  const view = openErrorView(detail)
  return h('div', {
    className: place === 'sidebar' ? 'bt-hint bt-open-error' : 'bt-open-error',
    role: 'alert',
    'data-open-error': place,
  },
    h('p', { className: 'bt-open-error-line' }, view.text),
    view.restart ? h('p', { className: 'bt-open-error-line' }, openRecoveryCopy()) : null)
}

// Registered on the shell overlay, which is mounted whenever the sidebar is.
// The node is portaled into the chat column. The observer stays for the whole
// failure so a replaced chat region does not leave the portal on a detached node.
// An identical error string does not re-render the roster, so the observer is
// what notices the new node.
export function OpenErrorNotice({ useRoster }) {
  const roster = useRoster(value => value)
  const gate = rosterGate({
    ready: roster.ready === true,
    hasMain: roster.byId?.[roster.mainBotId] != null,
    loadError: roster.loadError,
  })
  const [host, setHost] = useState(null)
  useLayoutEffect(() => {
    if (gate.kind !== 'error') { setHost(null); return undefined }
    let frame = 0
    let current = null
    const apply = (node) => {
      if (node === current) return
      current = node
      setHost(node)
    }
    const find = () => {
      frame = 0
      apply(typeof document === 'undefined' ? null : chatAlertHost())
    }
    const observer = typeof MutationObserver === 'function'
      ? new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(find) })
      : null
    observer?.observe(document.body, { childList: true, subtree: true })
    find()
    return () => { cancelAnimationFrame(frame); observer?.disconnect() }
  }, [gate.kind])
  if (gate.kind !== 'error' || host == null) return null
  return createPortal(openErrorNode(gate.text, 'chat'), host)
}
