// What the sidebar shows before a team has loaded. A failed state pull is an
// error, not the setup sentence, and a team that already loaded stays put.

/**
 * @param {{ ready?: boolean, hasMain?: boolean, loadError?: unknown }} [input]
 * @returns {{ kind: 'team' } | { kind: 'setup' } | { kind: 'error', text: string }}
 */
export function rosterGate({ ready = false, hasMain = false, loadError } = {}) {
  if (ready === true || hasMain === true) return { kind: 'team' }
  if (typeof loadError === 'string' && loadError !== '') return { kind: 'error', text: loadError }
  return { kind: 'setup' }
}
