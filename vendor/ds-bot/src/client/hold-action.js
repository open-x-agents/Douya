// A hold button reports a failed save on the card. The promise fulfills either
// way, so the browser does not turn the host's refusal into an uncaught error.
export function settleHoldAction(action) {
  return Promise.resolve()
    .then(() => action())
    .then(() => ({ ok: true, message: '' }), (error) => ({
      ok: false,
      message: typeof error?.message === 'string' && error.message !== '' ? error.message : 'Could not save',
    }))
}
