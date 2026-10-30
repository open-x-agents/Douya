// Resolve how plugin `send` (voice / New Chat / team-actions) should deliver a
// user message into a Session. Explicit queue|steer wins; otherwise a running
// agent defaults to steer so busy follow-ups can join the current turn.
export function resolveSendMode({ requested, running } = {}) {
  if (requested === 'steer' || requested === 'queue') return requested
  return running ? 'steer' : 'queue'
}
