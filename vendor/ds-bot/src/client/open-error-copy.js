import { t } from './i18n.js'

// Shown only when the process itself never finished starting (the bot route is
// missing). A dropped connection is not that: the page keeps trying.
export const OPEN_RECOVERY = 'Restart DS Bot after the session file can be read again. Refreshing this page does not restart the failed startup.'
export const OPEN_STARTUP = 'Could not open this chat. DS Bot did not finish starting.'
export const OPEN_HTTP = 'Could not open this chat. The server returned HTTP {status}.'
export const OPEN_NETWORK = 'Could not open this chat. The connection failed. This page will keep trying.'
export const OPEN_UNAVAILABLE = 'Could not open this chat.'

export const openRecoveryCopy = () => t(OPEN_RECOVERY)

// The raw message is not shown: it can carry a filesystem path. Only an HTTP
// status we recognized is repeated.
export function classifyOpenError(loadError) {
  const raw = typeof loadError === 'string' ? loadError : ''
  const http = raw.match(/HTTP\s+(\d{3})/)
  if (http) {
    const status = http[1]
    const startup = status === '404' || status === '502' || status === '503'
    return startup ? { kind: 'startup', status } : { kind: 'http', status }
  }
  if (/Could not reach DSH|连不上 DSH|Failed to fetch|Load failed|network error|NetworkError/i.test(raw)) {
    return { kind: 'network' }
  }
  if (/service-unavailable/i.test(raw)) return { kind: 'startup' }
  return { kind: 'unknown' }
}

export function openErrorView(loadError) {
  const failure = classifyOpenError(loadError)
  switch (failure.kind) {
    case 'startup':
      return {
        text: failure.status ? t(OPEN_HTTP, { status: failure.status }) : t(OPEN_STARTUP),
        restart: true,
      }
    case 'http':
      return { text: t(OPEN_HTTP, { status: failure.status }), restart: false }
    case 'network':
      return { text: t(OPEN_NETWORK), restart: false }
    case 'unknown':
      return { text: t(OPEN_UNAVAILABLE), restart: false }
    default: {
      const unexpected = failure.kind
      throw new Error(`Unknown open-error kind ${String(unexpected)}`)
    }
  }
}
