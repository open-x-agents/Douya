// Keep a private queue / ask / new sentence out of the model prompt.
//
// claim() removes the inbox copy before this listener runs. step() admits
// whatever is still in the payload as user/message. The team file is the only
// durability checkpoint: save({ required: true }) resolves after that file is
// replaced. A session splice is not a restored hold.
//
// A message stays in the payload only when this session's hold has action
// queue, outcome queued, and the same message id, and that outcome was written
// by a save that resolved. A dsBotQueue flag, the step number, and matching
// text do not authorize admission. The first claim takes every next-step row
// plus one next-turn row, so step 1 is not proof the row was handed off.
//
// A queue is marked queued and that save resolves before next-turn append. If
// the save throws, the row is not appended and the sentence stays stripped.
// A queued hold whose row never landed is appended once, with the same id.
// An empty step does not wake DSH by itself, so a handoff sets wakeRequested.
// A resumed agent with a committed queue that is not yet a user message wakes
// itself; the caller does not have to send another sentence.
import { noteHoldOutcome, privateHold, serializePrivate, withholdFromStep } from './route-private.js'

export function install(rt) {
  const { ctx } = rt
  ctx.on('agent/pre-step', async (payload, next) => {
    await applyPrivateWithhold(rt, payload)
    const sessionId = payload?.agent?.id
    const privateStep = typeof sessionId === 'string' && rt.isBotSession?.(sessionId) === true && !rt.roomOf?.(sessionId)
    // Reject before next() so a clock hook wrapped outside this one also sees
    // the rejection and does not add a context-only message. A queued handoff
    // has already asked the driver to wake for the row it appended.
    if (privateStep && Array.isArray(payload.messages) && !payload.messages.some(isSubstantive)) {
      return { kind: 'reject', messages: [] }
    }
    return next()
  }, { prepend: true })
  ctx.on('agent/created', ({ agent, source } = {}) => {
    if (source !== 'resume' || agent == null || !needsContinuation(rt, agent)) return
    wakeWhenIdle(agent)
  })
}

/** Strip held private sentences from the payload the step is about to admit. */
export async function applyPrivateWithhold(rt, payload) {
  const agent = payload?.agent
  const sessionId = agent?.id
  if (typeof sessionId !== 'string' || !rt.isBotSession?.(sessionId) || rt.roomOf?.(sessionId) || !Array.isArray(payload.messages)) {
    return { outcomes: [], saved: false }
  }
  if (rt.privateHoldPersist) await rt.privateHoldPersist.catch(() => {})
  return serializePrivate(rt, sessionId, async (commit) => {
    const hold = privateHold(rt.state, sessionId)
    if (recoverDurableQueue(rt, agent, sessionId, payload)) requestWake(agent)
    const split = withholdFromStep(payload.messages, hold)
    if (split.withheld.length === 0) return { outcomes: [], saved: true }
    const asks = split.withheld.filter(message => holdItem(hold, message.id)?.action !== 'queue')
    const queues = split.withheld.filter(message => holdItem(hold, message.id)?.action === 'queue')
    const dropIds = new Set(split.withheld.map(message => message.id))
    const kept = payload.messages.filter(message => !dropIds.has(message.id))
    payload.messages.splice(0, payload.messages.length, ...kept)
    let saved = asks.length === 0
    if (asks.length > 0) {
      try {
        await commit({ required: true })
        saved = true
      } catch (error) {
        rt.warn?.('ds-bot: private hold was not saved before it left the step: %s', error)
      }
    }
    const outcomes = []
    let handedOff = false
    for (const message of queues) {
      const outcome = await moveQueue(rt, agent, sessionId, message, commit)
      if (outcome === 'queued') handedOff = true
      outcomes.push({ id: message.id, action: 'queue', outcome })
    }
    for (const message of asks) {
      const action = holdItem(hold, message.id)?.action ?? 'ask'
      const outcome = saved ? 'held' : 'unrecoverable'
      noteHoldOutcome(rt.state, sessionId, message.id, outcome)
      outcomes.push({ id: message.id, action, outcome })
    }
    if (handedOff) requestWake(agent)
    return { outcomes, saved }
  })
}

async function moveQueue(rt, agent, sessionId, message, commit) {
  if (typeof agent?.inbox?.append !== 'function') return mark(rt, sessionId, message.id, 'queue-failed')
  if (sitsInNextTurn(agent, message.id)) return 'queued'
  noteHoldOutcome(rt.state, sessionId, message.id, 'queued')
  try {
    await commit({ required: true })
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
    const reverted = await commit({ required: true }).then(() => true, () => false)
    if (!reverted) noteHoldOutcome(rt.state, sessionId, message.id, 'queued')
    return sitsInNextTurn(agent, message.id) || privateHold(rt.state, sessionId)?.items?.find(item => item.messageId === message.id)?.outcome === 'queued'
      ? 'queued'
      : 'queue-failed'
  }
}

const CONTEXT_KINDS = new Set(['runtime-context', 'time-context', 'ds-bot-time-context'])

function isSubstantive(message) {
  return !CONTEXT_KINDS.has(message?.source?.kind)
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

function needsContinuation(rt, agent) {
  const sessionId = agent?.id
  if (typeof sessionId !== 'string' || !rt.isBotSession?.(sessionId) || rt.roomOf?.(sessionId)) return false
  const hold = privateHold(rt.state, sessionId)
  return (hold?.items ?? []).some(item => item?.action === 'queue' && item?.outcome === 'queued' && typeof item.messageId === 'string' && !alreadyAdmitted(agent, item.messageId))
}

function wakeWhenIdle(agent) {
  let tries = 0
  const attempt = () => {
    if (agent.phase?.kind === 'idle') {
      agent.wakeDriver()
      return
    }
    if (tries++ < 20) setTimeout(attempt, 0)
  }
  setTimeout(attempt, 0)
}

/**
 * A queued hold whose next-turn splice never landed is appended once.
 * A row already pending, already in this step, or already admitted as
 * user/message is left where it is.
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

function holdItem(hold, messageId) {
  if (typeof messageId !== 'string' || messageId === '') return undefined
  return (hold?.items ?? []).find(item => item?.messageId === messageId)
}
