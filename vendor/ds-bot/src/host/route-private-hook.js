// Keep a private queue / ask / new sentence out of the model prompt.
//
// claim() removes the inbox copy before this listener runs. step() admits
// whatever is still in the payload as user/message. The team file is the only
// durability checkpoint: save({ required: true }) resolves after that file is
// replaced. A session splice is not a restored hold, and this code does not
// treat one as durable.
//
// A queue is marked queued in the team file before it is appended to next-turn.
// A crash after that save but before the append leaves a queued hold and no
// inbox row; the next pass appends that same id once. A crash after the append
// leaves the row for one claim. Messages already handed off carry
// source.dsBotQueue and are admitted once, not stripped and appended again.
// The first step of a turn already claimed next-turn, so a queue row there is
// the continuation and is not moved again. An empty step does not wake DSH by
// itself, so a handoff sets the running phase's wakeRequested.
import { noteHoldOutcome, privateHold, serializePrivate, withholdFromStep } from './route-private.js'

export function install(rt) {
  const { ctx } = rt
  ctx.on('agent/pre-step', async (payload, next) => {
    await applyPrivateWithhold(rt, payload)
    return next()
  }, { prepend: true })
}

/** Strip held private sentences from the payload the step is about to admit. */
export async function applyPrivateWithhold(rt, payload) {
  const agent = payload?.agent
  const sessionId = agent?.id
  if (typeof sessionId !== 'string' || !rt.isBotSession?.(sessionId) || rt.roomOf?.(sessionId) || !Array.isArray(payload.messages)) {
    return { outcomes: [], saved: false }
  }
  if (rt.privateHoldPersist) await rt.privateHoldPersist.catch(() => {})
  // The team file is one snapshot. Hold this gate across the outcome edits and
  // the save so another session cannot store this edit before it commits.
  return serializePrivate(rt, sessionId, async () => {
    const hold = privateHold(rt.state, sessionId)
    if (recoverDurableQueue(rt, agent, sessionId, payload)) requestWake(agent)
    const split = withholdFromStep(payload.messages, hold)
    const handed = split.withheld.filter(message => message?.source?.dsBotQueue === true)
    const waiting = split.withheld.filter(message => !handed.includes(message))
    if (waiting.length === 0) return { outcomes: [], saved: true }
    let saved = false
    if (typeof rt.save === 'function') {
      try {
        await rt.save({ required: true })
        saved = true
      } catch (error) {
        rt.warn?.('ds-bot: private hold was not saved before it left the step: %s', error)
      }
    }
    // Step 1 already claimed the next-turn row. Stripping it and appending a
    // second copy makes that step empty, and DSH returns before it wakes.
    const stepOne = payload.step === 1
    const deferredQueue = (message) => (hold?.items ?? []).some(item => item.action === 'queue' && item.outcome !== 'queued' && matches(item, message))
    const queued = stepOne ? [] : waiting.filter(deferredQueue)
    const admittedQueues = stepOne ? waiting.filter(deferredQueue) : []
    const asks = waiting.filter(message => !deferredQueue(message))
    const dropIds = new Set([...queued, ...asks].map(message => message.id))
    const kept = payload.messages.filter(message => !dropIds.has(message.id))
    payload.messages.splice(0, payload.messages.length, ...kept)
    const outcomes = []
    let handedOff = false
    for (const message of admittedQueues) {
      const outcome = saved ? 'queued' : 'unrecoverable'
      noteHoldOutcome(rt.state, sessionId, message.id, outcome)
      outcomes.push({ id: message.id, action: 'queue', outcome })
    }
    for (const message of queued) {
      const outcome = saved ? await moveQueue(rt, agent, sessionId, message) : mark(rt, sessionId, message.id, 'unrecoverable')
      if (outcome === 'queued') handedOff = true
      outcomes.push({ id: message.id, action: 'queue', outcome })
    }
    for (const message of asks) {
      const action = (hold?.items ?? []).find(item => matches(item, message))?.action ?? 'ask'
      const outcome = saved ? 'held' : 'unrecoverable'
      noteHoldOutcome(rt.state, sessionId, message.id, outcome)
      outcomes.push({ id: message.id, action, outcome })
    }
    if (handedOff) requestWake(agent)
    return { outcomes, saved }
  })
}

async function moveQueue(rt, agent, sessionId, message) {
  if (typeof agent?.inbox?.append !== 'function') return mark(rt, sessionId, message.id, 'queue-failed')
  if (sitsInNextTurn(agent, message.id)) return 'queued'
  noteHoldOutcome(rt.state, sessionId, message.id, 'queued')
  try {
    if (typeof rt.save === 'function') await rt.save({ required: true })
  } catch (error) {
    rt.warn?.('ds-bot: private queue outcome was not saved: %s', error)
    return mark(rt, sessionId, message.id, 'queue-failed')
  }
  try {
    agent.inbox.append('next-turn', queuedCopy(message))
    return 'queued'
  } catch (error) {
    if (sitsInNextTurn(agent, message.id)) return 'queued'
    rt.warn?.('ds-bot: private queue could not leave the current step: %s', error)
    noteHoldOutcome(rt.state, sessionId, message.id, 'queue-failed')
    if (typeof rt.save === 'function') await rt.save({ required: true }).catch(() => {})
    return 'queue-failed'
  }
}

function queuedCopy(message) {
  return {
    ...message,
    source: { ...(message?.source ?? {}), dsBotQueue: true },
  }
}

function requestWake(agent) {
  if (agent?.phase?.kind === 'running') agent.phase.wakeRequested = true
}

/**
 * A queued hold whose next-turn splice never landed (or never flushed) is
 * appended once. A row already pending, already in this step, or already
 * admitted as user/message is left where it is.
 */
function recoverDurableQueue(rt, agent, sessionId, payload) {
  const hold = privateHold(rt.state, sessionId)
  if (hold == null || typeof agent?.inbox?.append !== 'function') return false
  let appended = false
  for (const item of hold.items ?? []) {
    if (item?.action !== 'queue' || item?.outcome !== 'queued' || typeof item.messageId !== 'string') continue
    if (sitsInNextTurn(agent, item.messageId) || sitsInNextStep(agent, item.messageId)) continue
    if ((payload.messages ?? []).some(message => message?.id === item.messageId)) continue
    if (alreadyAdmitted(agent, item.messageId)) continue
    agent.inbox.append('next-turn', {
      id: item.messageId,
      role: 'user',
      source: { kind: 'user', dsBotQueue: true },
      content: [{ type: 'text', text: typeof item.text === 'string' ? item.text : '' }],
    })
    appended = true
  }
  return appended
}

function sitsInNextStep(agent, messageId) {
  const pending = agent?.inbox?.nextStep
  return Array.isArray(pending) && pending.some(message => message?.id === messageId)
}

function alreadyAdmitted(agent, messageId) {
  const events = typeof agent?.session?.snapshotEvents === 'function' ? agent.session.snapshotEvents() : []
  return events.some(event => event?.type === 'user/message' && event.data?.id === messageId)
}

function mark(rt, sessionId, messageId, outcome) {
  noteHoldOutcome(rt.state, sessionId, messageId, outcome)
  return outcome
}

function sitsInNextTurn(agent, messageId) {
  const pending = agent?.inbox?.nextTurn
  return Array.isArray(pending) && pending.some(message => message?.id === messageId)
}

function matches(item, message) {
  if (item == null || message == null) return false
  if (item.messageId !== undefined && item.messageId === message.id) return true
  return item.text !== '' && item.text === textOf(message)
}

function textOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
}
