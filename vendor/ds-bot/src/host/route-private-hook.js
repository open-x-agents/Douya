// Keep a private queue / ask / new sentence out of the model prompt.
//
// DSH publishes `agent/inbox/spliced` inside Session.append and refuses a nested
// append while that publication is open. claim() then runs at the start of
// preStep, before this async listener, and removes the pending inbox copy.
// The model only sees a sentence when step() later appends decision.messages
// as user/message. This listener awaits a required team-file save first, then
// removes every restricted sentence from that array even if the queue handoff
// or the save fails. A failed save is also written as an ignorable session
// record so a restart can rebuild the hold. A queue message is appended to
// next-turn only after it has left the current payload, one message at a time,
// and a failure does not put an earlier success back into this step.
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { noteHoldOutcome, privateHold, withholdFromStep } from './route-private.js'

export const HOLD_RECORD = 'plugin:ds-bot/private-hold'

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
    const outcome = await moveQueue(rt, agent, sessionId, message)
    outcomes.push({ id: message.id, action: 'queue', outcome })
  }
  for (const message of asks) {
    const action = (hold?.items ?? []).find(item => matches(item, message))?.action ?? 'ask'
    const outcome = saved ? 'held' : 'held-unsaved'
    noteHoldOutcome(rt.state, sessionId, message.id, outcome)
    outcomes.push({ id: message.id, action, outcome })
  }
  if (!saved) await writeSessionCopy(rt, agent?.session, sessionId, split.withheld)
  else if (typeof rt.save === 'function') await rt.save({ required: true }).catch(() => {})
  return { outcomes, saved }
}

async function moveQueue(rt, agent, sessionId, message) {
  if (typeof agent?.inbox?.append !== 'function') {
    noteHoldOutcome(rt.state, sessionId, message.id, 'queue-failed')
    return 'queue-failed'
  }
  try {
    agent.inbox.append('next-turn', message)
    noteHoldOutcome(rt.state, sessionId, message.id, 'queued')
    return 'queued'
  } catch (error) {
    if (sitsInNextTurn(agent, message.id)) {
      noteHoldOutcome(rt.state, sessionId, message.id, 'queued')
      return 'queued'
    }
    noteHoldOutcome(rt.state, sessionId, message.id, 'queue-failed')
    rt.warn?.('ds-bot: private queue could not leave the current step: %s', error)
    return 'queue-failed'
  }
}

function sitsInNextTurn(agent, messageId) {
  const pending = agent?.inbox?.nextTurn
  return Array.isArray(pending) && pending.some(message => message?.id === messageId)
}

async function writeSessionCopy(rt, session, sessionId, messages) {
  if (session == null || typeof session.append !== 'function' && typeof appendPluginRecord !== 'function') return
  const hold = privateHold(rt.state, sessionId)
  for (const message of messages) {
    const item = (hold?.items ?? []).find(entry => matches(entry, message))
    if (item == null) continue
    try {
      appendPluginRecord(session, HOLD_RECORD, {
        sessionId,
        messageId: item.messageId,
        action: item.action,
        text: item.text,
        ...(item.label ? { label: item.label } : {}),
        ...(item.workLineId ? { workLineId: item.workLineId } : {}),
        ...(hold.botId ? { botId: hold.botId } : {}),
        outcome: item.outcome ?? 'held-unsaved',
      })
      if (item.outcome === 'held-unsaved' || item.outcome === 'queue-failed') item.outcome = item.outcome === 'queue-failed' ? 'queue-failed' : 'held-session'
    } catch (error) {
      rt.warn?.('ds-bot: private hold session record failed: %s', error)
    }
  }
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
