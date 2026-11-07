// Keep a private queue / ask / new sentence out of the model prompt.
//
// DSH publishes `agent/inbox/spliced` inside Session.append, and that publication
// refuses a nested append (`session append cannot reenter while another append
// is being published`). A listener therefore cannot inbox.remove the sentence
// it just observed. An idle steer also claims the inbox synchronously in
// preStep, before a microtask queued by the splice listener can run, so a
// removal after the event can lose to claim.
//
// claim() only copies the pending messages into the pre-step payload. The model
// reads them later, when step() appends each decision message as user/message.
// Stripping the payload here, before that append, is the intercept. A queued
// sentence is appended to next-turn only after this publication has finished;
// ask and new stay in privateHolds and are not put back.
import { dropQueuedHold, privateHold, withholdFromStep } from './route-private.js'

export function install(rt) {
  const { ctx } = rt
  ctx.on('agent/pre-step', async (payload, next) => {
    applyPrivateWithhold(rt, payload)
    return next()
  }, { prepend: true })
}

/** Strip held private sentences from the payload the step is about to admit. */
export function applyPrivateWithhold(rt, payload) {
  const agent = payload?.agent
  const sessionId = agent?.id
  if (typeof sessionId !== 'string' || !rt.isBotSession?.(sessionId) || rt.roomOf?.(sessionId) || !Array.isArray(payload.messages)) return
  const hold = privateHold(rt.state, sessionId)
  const split = withholdFromStep(payload.messages, hold)
  if (split.withheld.length === 0) return
  const queued = split.withheld.filter(message => (hold.items ?? []).some(item => item.action === 'queue' && (item.messageId === message.id || item.text === textOf(message))))
  const asks = split.withheld.filter(message => !queued.includes(message))
  let moved = true
  if (queued.length > 0) {
    if (typeof agent.inbox?.append !== 'function') moved = false
    else {
      try {
        for (const message of queued) agent.inbox.append('next-turn', message)
      } catch (error) {
        moved = false
        rt.warn?.('ds-bot: private queue could not leave the current step: %s', error)
      }
    }
  }
  const drop = moved ? [...asks, ...queued] : asks
  if (drop.length === 0) return
  const dropIds = new Set(drop.map(message => message.id))
  const kept = payload.messages.filter(message => !dropIds.has(message.id))
  payload.messages.splice(0, payload.messages.length, ...kept)
  if (moved) for (const message of queued) dropQueuedHold(rt.state, sessionId, message.id)
}

function textOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
}
