import { createElement as h } from 'react'
import { t } from './i18n.js'
import { rosterGate } from './roster-gate.js'

export const openErrorCopy = detail => t('Could not open this chat. {detail}', { detail })

// The chat column's copy of a failed open. The sidebar shows the same sentence.
// A team that loaded, or a pull that has not failed yet, leaves the column alone.
export function OpenErrorDock({ useRoster }) {
  const roster = useRoster(value => value)
  const gate = rosterGate({
    ready: roster.ready === true,
    hasMain: roster.byId?.[roster.mainBotId] != null,
    loadError: roster.loadError,
  })
  switch (gate.kind) {
    case 'error':
      return h('div', { className: 'bt-open-error', role: 'alert', 'data-open-error': '' }, openErrorCopy(gate.text))
    case 'team':
    case 'setup':
      return null
    default: {
      const unexpected = gate.kind
      throw new Error(`Unknown roster gate ${String(unexpected)}`)
    }
  }
}
