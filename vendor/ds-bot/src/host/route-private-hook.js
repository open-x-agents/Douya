// Keep a private queue / ask / new sentence out of the model prompt.
//
// DSH publishes `agent/inbox/spliced` inside Session.append and refuses a nested
// append while that publication is open. claim() then runs at the start of
// preStep and removes the pending inbox copy. The model only sees a sentence
// when step() later appends decision.messages as user/message. This listener
// awaits the team-file save, then removes every restricted sentence from that
// array. The team file is the durability checkpoint: save({ required: true })
// resolves only after the file is replaced. A session append is not that
// checkpoint, and this host does not treat one as a restored hold.
//
// A queue is appended to next-turn only after that save. If recording the
// queued outcome then fails, the append is removed again so a restart still
// sees an unqueued hold and cannot consume a second copy.
import { noteHoldOutcome, privateHold, withholdFromStep } from './route-private.js'

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
  const hold = privateHold(rt.state, sessionId)
  const split = withholdFromStep(payload.messages, hold)
  if (split.withheld.length === 0) return { outcomes: [], saved: true }
  let saved = false
  if (typeof rt.save === 'function') {
    try {
      await rt.save({ required: true })
      saved = true
    } catch (error) {
      rt.warn?.('ds-bot: private hold was not saved before it left the step: %s', error)
    }
  }
  const queued = split.withheld.filter(message => (hold?.items ?? []).some(item => item.action === 'queue' && item.outcome !== 'queued' && matches(item, message)))
  const asks = split.withheld.filter(message => !queued.includes(message))
  const dropIds = new Set(split.withheld.map(message => message.id))
  const kept = payload.messages.filter(message => !dropIds.has(message.id))
  payload.messages.splice(0, payload.messages.length, ...kept)
  const outcomes = []
  for (const message of queued) {
    const outcome = saved ? await moveQueue(rt, agent, sessionId, message) : mark(rt, sessionId, message.id, 'unrecoverable')
    outcomes.push({ id: message.id, action: 'queue', outcome })
  }
  for (const message of asks) {
    const action = (hold?.items ?? []).find(item => matches(item, message))?.action ?? 'ask'
    const outcome = saved ? 'held' : 'unrecoverable'
    noteHoldOutcome(rt.state, sessionId, message.id, outcome)
    outcomes.push({ id: message.id, action, outcome })
  }
  if (saved && typeof rt.save === 'function') {
    try {
      await rt.save({ required: true })
    } catch (error) {
      rt.warn?.('ds-bot: private hold outcome was not saved: %s', error)
    }
  }
  return { outcomes, saved }
}

async function moveQueue(rt, agent, sessionId, message) {
  if (typeof agent?.inbox?.append !== 'function') return mark(rt, sessionId, message.id, 'queue-failed')
  let appended = sitsInNextTurn(agent, message.id)
  if (!appended) {
    try {
      agent.inbox.append('next-turn', message)
      appended = true
    } catch (error) {
      if (!sitsInNextTurn(agent, message.id)) {
        rt.warn?.('ds-bot: private queue could not leave the current step: %s', error)
        return mark(rt, sessionId, message.id, 'queue-failed')
      }
      appended = true
    }
  }
  noteHoldOutcome(rt.state, sessionId, message.id, 'queued')
  try {
    if (typeof rt.save === 'function') await rt.save({ required: true })
    return 'queued'
  } catch (error) {
    rt.warn?.('ds-bot: private queue outcome was not saved: %s', error)
    let removed = !sitsInNextTurn(agent, message.id)
    if (!removed && typeof agent.inbox.remove === 'function') {
      try {
        agent.inbox.remove(message.id)
        removed = !sitsInNextTurn(agent, message.id)
      } catch (removeError) {
        rt.warn?.('ds-bot: private queue could not be taken back: %s', removeError)
      }
    }
    return mark(rt, sessionId, message.id, removed ? 'queue-failed' : 'unrecoverable')
  }
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
