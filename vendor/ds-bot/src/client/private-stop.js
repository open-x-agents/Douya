import { createElement as h, useState } from 'react'
import { t } from './i18n.js'

// The composer stop is only for the Bot's own chat, and only while that chat is
// running. A group keeps its own "Stop all" and never shows this one beside it.
export function privateStopShown({ room, bot, running }) {
  return room == null && bot != null && running === true
}

export function PrivateStopDock({ sessionId, useRoster, useSessionStatus, actions }) {
  const bot = useRoster(value => value.byId?.[sessionId])
  const room = useRoster(value => value.roomsById?.[sessionId])
  const running = useSessionStatus(map => map.get(sessionId)?.running === true)
  const [stopping, setStopping] = useState(false)
  if (!privateStopShown({ room, bot, running })) return null
  const stop = () => {
    if (stopping || typeof actions?.stopPrivate !== 'function') return
    setStopping(true)
    void Promise.resolve(actions.stopPrivate(sessionId))
      .catch(error => actions.reportError?.(error, 'stop'))
      .finally(() => setStopping(false))
  }
  const label = t('Stop')
  return h('div', { className: 'bt-private-stop-dock' },
    h('button', {
      type: 'button',
      className: 'bt-soft bt-soft-sm',
      disabled: stopping,
      'aria-label': label,
      title: label,
      'data-private-stop': '',
      onClick: stop,
    }, label))
}
