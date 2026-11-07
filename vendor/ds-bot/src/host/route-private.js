// Which line a private-chat sentence belongs to.
// One pure result: steer, queue, ask, or new. Uncertainty is ask.
// This does not open a part, start a second turn, or call the model.

const HIT = 0.45
const MISS = 0.15

/** @typedef {'steer' | 'queue' | 'ask' | 'new'} PrivateRouteAction */

function tokens(text) {
  const lowered = String(text ?? '').toLowerCase()
  const words = lowered.match(/[a-z0-9_]{2,}/g) ?? []
  const han = lowered.match(/[\u4e00-\u9fa5]/g) ?? []
  const grams = []
  for (let index = 0; index + 1 < han.length; index += 1) grams.push(han[index] + han[index + 1])
  return new Set([...words, ...grams])
}

function overlap(left, right) {
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / Math.min(left.size, right.size)
}

/** @param {number} score @returns {'hit' | 'miss' | 'unsure'} */
function band(score) {
  if (score >= HIT) return 'hit'
  if (score <= MISS) return 'miss'
  return 'unsure'
}

/** Same prefixes as the room parser. A named line is `续：label`. */
export function explicitIntent(text) {
  const trimmed = String(text ?? '').trim()
  if (/^(?:新开|\/new\b)/i.test(trimmed)) return { kind: 'new' }
  const named = /^(?:续[:：])\s*(\S(?:.*\S)?)\s*$/.exec(trimmed)
  if (named?.[1]) return { kind: 'name', label: named[1].trim() }
  return { kind: 'auto' }
}

function lineLabel(line) {
  return typeof line?.label === 'string' && line.label.trim() !== '' ? line.label.trim() : undefined
}

function clearHit(text, line) {
  if (lineLabel(line) === undefined) return false
  const marks = scored(text, [line])
  return marks.hits.length === 1 && marks.unsures.length === 0
}

function scored(text, lines) {
  const hits = []
  const unsures = []
  for (const line of lines) {
    const label = lineLabel(line)
    if (label === undefined) continue
    const mark = band(overlap(tokens(text), tokens(label)))
    if (mark === 'hit') hits.push(line)
    else if (mark === 'unsure') unsures.push(line)
  }
  return { hits, unsures }
}

function choiceOf(line) {
  return {
    id: line.id,
    label: lineLabel(line),
    sessionId: line.sessionId,
    busy: line.busy === true,
    current: line.current === true,
  }
}

function ask(lines, text, highlight) {
  const labeled = lines.filter(line => lineLabel(line) !== undefined)
  const picked = labeled.find(line => line.id === highlight) ?? labeled.find(line => line.current === true)
  return {
    action: 'ask',
    steer: false,
    text,
    highlight: picked?.id,
    label: lineLabel(picked),
    sessionId: picked?.sessionId,
    workLineId: picked?.id,
    choices: labeled.map(choiceOf),
  }
}

function bound(action, line, text) {
  return {
    action,
    steer: action === 'steer',
    text,
    sessionId: line?.sessionId,
    workLineId: line?.id,
    label: lineLabel(line),
    choices: lineLabel(line) !== undefined ? [choiceOf(line)] : [],
  }
}

/**
 * @param {{ text?: string, busy?: boolean, lines?: any[], explicitQueue?: boolean }} [input]
 * @returns {{ action: PrivateRouteAction, steer: boolean, text?: string, label?: string, sessionId?: string, workLineId?: string, highlight?: string, choices?: any[] }}
 */
export function routePrivate({ text = '', busy = false, lines = [], explicitQueue = false } = {}) {
  const body = String(text ?? '')
  const intent = explicitIntent(body)
  const open = (Array.isArray(lines) ? lines : []).filter(line => line?.closedAt == null)
  const current = open.find(line => line?.current === true)

  if (intent.kind === 'new') {
    return {
      action: 'new',
      steer: false,
      text: body,
      label: lineLabel(current),
      sessionId: current?.sessionId,
      workLineId: current?.id,
      choices: open.filter(line => lineLabel(line) !== undefined).map(choiceOf),
    }
  }

  if (intent.kind === 'name') {
    const named = open.filter(line => line.id === intent.label || lineLabel(line) === intent.label)
    if (named.length !== 1) return ask(open, body)
    const line = named[0]
    if (line.current === true) return bound(busy && explicitQueue ? 'queue' : 'steer', line, body)
    return ask(open, body, line.id)
  }

  if (explicitQueue) {
    if (busy && (lineLabel(current) === undefined || clearHit(body, current))) return bound('queue', current, body)
    if (!busy && (lineLabel(current) === undefined || clearHit(body, current))) return bound('steer', current, body)
    return ask(open, body)
  }

  const marks = scored(body, open)
  if (marks.hits.length === 1 && marks.unsures.length === 0 && marks.hits[0].current === true) {
    return bound('steer', marks.hits[0], body)
  }
  if (marks.hits.length === 1 && marks.unsures.length === 0) return ask(open, body, marks.hits[0].id)
  // No labeled line yet: this sentence is the opening, not a guess between lines.
  const labeled = open.filter(line => lineLabel(line) !== undefined)
  if (labeled.length === 0) return bound('steer', current, body)
  // A labeled line that this sentence does not clearly continue is uncertainty,
  // including when it is the only line.
  return ask(open, body)
}

/** Shown when the sentence stayed out of the model but the team file did not keep it. */
export function routeFailureAck() {
  return 'This sentence stayed out of the model, but the hold could not be saved.'
}

/** Activity-row copy. Not an assistant message. A success ack is only for a saved hold. */
export function routeAck(decision) {
  const action = decision?.action
  switch (action) {
    case 'steer':
      return undefined
    case 'queue':
      return 'Queued after the current line. This step will not read it.'
    case 'ask':
      return 'Held for confirmation. The current model will not read this.'
    case 'new':
      return '“New” is waiting for confirmation. It does not open another chat yet.'
    default: {
      /** @type {never} */
      const unexpected = action
      throw new Error(`Unknown private route ${String(unexpected)}`)
    }
  }
}

function holdsOf(state) {
  if (state.privateHolds == null || typeof state.privateHolds !== 'object' || Array.isArray(state.privateHolds)) state.privateHolds = {}
  return state.privateHolds
}

function itemOf(input) {
  const text = typeof input.text === 'string' ? input.text : ''
  return {
    messageId: typeof input.messageId === 'string' && input.messageId !== '' ? input.messageId : undefined,
    action: input.action,
    text,
    ...(typeof input.label === 'string' && input.label !== '' ? { label: input.label } : {}),
    ...(typeof input.workLineId === 'string' && input.workLineId !== '' ? { workLineId: input.workLineId } : {}),
    ...(typeof input.sessionId === 'string' && input.sessionId !== '' ? { sessionId: input.sessionId } : {}),
    ...(typeof input.botId === 'string' && input.botId !== '' ? { botId: input.botId } : {}),
    ...(input.outcome === 'queued' || input.outcome === 'queue-failed' || input.outcome === 'held' || input.outcome === 'held-unsaved' ? { outcome: input.outcome } : {}),
    at: typeof input.at === 'number' ? input.at : Date.now(),
  }
}

/** Remember a sentence that must not be admitted to the model. */
export function rememberPrivateHold(state, input = {}) {
  const sessionId = input.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  const table = holdsOf(state)
  const previous = table[sessionId]
  const items = Array.isArray(previous?.items) ? previous.items.filter(item => item?.action !== 'steer') : []
  const next = itemOf(input)
  const without = items.filter(item => item.messageId === undefined || item.messageId !== next.messageId)
  table[sessionId] = {
    sessionId,
    items: [...without, next],
    ...(Array.isArray(input.choices) ? { choices: input.choices } : (Array.isArray(previous?.choices) ? { choices: previous.choices } : {})),
    ...(typeof input.highlight === 'string' && input.highlight !== '' ? { highlight: input.highlight } : (typeof previous?.highlight === 'string' ? { highlight: previous.highlight } : {})),
    ...(typeof input.botId === 'string' && input.botId !== '' ? { botId: input.botId } : (typeof previous?.botId === 'string' ? { botId: previous.botId } : {})),
    status: previous?.status === 'bound' ? 'bound' : 'pending',
    ...(typeof previous?.boundTo === 'string' ? { boundTo: previous.boundTo, boundAt: previous.boundAt, delivered: false } : { delivered: false }),
    at: next.at,
  }
  return table[sessionId]
}

/** Set one item's outcome without dropping its text. */
export function noteHoldOutcome(state, sessionId, messageId, outcome) {
  const hold = privateHold(state, sessionId)
  const item = (hold?.items ?? []).find(entry => entry.messageId === messageId)
  if (item == null) return undefined
  item.outcome = outcome
  return item
}

export function privateHold(state, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  const hold = holdsOf(state)[sessionId]
  return hold == null ? undefined : hold
}

/**
 * Record which open work line the user picked. Does not put the sentence back
 * in an inbox. An unknown, closed, or other-bot choice leaves the hold unchanged.
 */
export function bindPrivateHold(state, sessionId, choiceId, now = Date.now()) {
  const hold = privateHold(state, sessionId)
  if (hold == null || typeof choiceId !== 'string' || choiceId === '') return undefined
  const choice = (hold.choices ?? []).find(item => item?.id === choiceId)
  if (choice == null) return undefined
  const lines = state.workLines
  const line = lines != null && typeof lines === 'object' && !Array.isArray(lines) ? lines[choiceId] : undefined
  if (line == null || line.closedAt != null) return undefined
  if (typeof choice.sessionId === 'string' && choice.sessionId !== '' && line.sessionId !== choice.sessionId) return undefined
  if (typeof hold.botId === 'string' && hold.botId !== '' && line.botId !== hold.botId) return undefined
  hold.status = 'bound'
  hold.boundTo = choiceId
  hold.boundAt = now
  hold.delivered = false
  if (typeof choice.label === 'string' && choice.label !== '') hold.label = choice.label
  else if (typeof line.label === 'string' && line.label !== '') hold.label = line.label
  return hold
}

export function dropQueuedHold(state, sessionId, messageId) {
  const hold = privateHold(state, sessionId)
  if (hold == null) return
  hold.items = (hold.items ?? []).filter(item => !(item.action === 'queue' && (messageId === undefined || item.messageId === messageId)))
  if (hold.items.length === 0 && hold.status !== 'bound') delete holdsOf(state)[sessionId]
}

function messageText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
}

/**
 * Pull held sentences out of the array the step would admit.
 * Queue is moved by the caller; this only separates the array.
 * @param {any[]} messages
 * @param {{ items?: { messageId?: string, text?: string, action?: string }[] }} [hold]
 */
export function withholdFromStep(messages, hold) {
  const items = (hold?.items ?? []).filter(item => item?.outcome !== 'queued' && (item?.action === 'ask' || item?.action === 'new' || item?.action === 'queue'))
  if (items.length === 0) return { kept: messages, withheld: [] }
  const kept = []
  const withheld = []
  for (const message of messages) {
    const text = messageText(message)
    const id = message?.id
    const hit = items.some(item => (item.messageId !== undefined && item.messageId === id) || (item.text !== '' && item.text === text))
    if (hit && message?.source?.kind === 'user') withheld.push(message)
    else kept.push(message)
  }
  return { kept, withheld }
}
