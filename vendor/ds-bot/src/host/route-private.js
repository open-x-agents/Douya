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
  // Only an idle chat with no labeled line yet is an opening. A busy sentence
  // that does not clearly continue a label is uncertainty, even with no rival.
  const labeled = open.filter(line => lineLabel(line) !== undefined)
  if (!busy && labeled.length === 0) return bound('steer', current, body)
  return ask(open, body)
}

/** Shown when the sentence stayed out of the model but the team file did not keep it. */
export function routeFailureAck() {
  return 'This sentence stayed out of the model, but it could not be saved and will not survive a restart.'
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
    ...(input.outcome === 'queued' || input.outcome === 'queue-failed' || input.outcome === 'held' || input.outcome === 'unrecoverable' || input.outcome === 'delivered' ? { outcome: input.outcome } : {}),
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
  // A new sentence is its own confirmation. It does not inherit an older binding.
  table[sessionId] = {
    sessionId,
    generation: (previous?.generation ?? 0) + 1,
    items: [...without, next],
    ...(Array.isArray(input.choices) ? { choices: input.choices } : (Array.isArray(previous?.choices) ? { choices: previous.choices } : {})),
    ...(typeof input.highlight === 'string' && input.highlight !== '' ? { highlight: input.highlight } : (typeof previous?.highlight === 'string' ? { highlight: previous.highlight } : {})),
    ...(typeof input.botId === 'string' && input.botId !== '' ? { botId: input.botId } : (typeof previous?.botId === 'string' ? { botId: previous.botId } : {})),
    status: 'pending',
    delivered: false,
    at: next.at,
  }
  return table[sessionId]
}

/**
 * Every team snapshot waits out an open private edit. save() copies the live
 * state, so a question dismiss, a queue ack, or a label save would otherwise
 * store a bind or a retry that is still being rolled back. The edit's own
 * commit function is the only snapshot that runs immediately. It is not a
 * process-wide flag: a caller who was not given that function waits.
 * Callers still pass the session id for the log.
 */
export function guardPrivateSaves(rt) {
  if (typeof rt?.save !== 'function' || rt.privateSaveGuarded === true) return
  const save = rt.save.bind(rt)
  rt.privateSaveGuarded = true
  rt.save = (options) => {
    const token = options?.privateCommit
    if (token !== undefined && token === rt.privateCommitToken) {
      rt.privateCommitToken = undefined
      const rest = { ...options }
      delete rest.privateCommit
      return save(rest)
    }
    const gate = rt.privateGateAll ?? Promise.resolve()
    return gate.then(() => save(options), () => save(options))
  }
}

export function serializePrivate(rt, _sessionId, job) {
  guardPrivateSaves(rt)
  const token = Symbol('private-commit')
  const commit = (options = {}) => {
    rt.privateCommitToken = token
    try {
      return rt.save({ ...options, privateCommit: token })
    } catch (error) {
      if (rt.privateCommitToken === token) rt.privateCommitToken = undefined
      throw error
    }
  }
  const previous = rt.privateGateAll ?? Promise.resolve()
  const run = previous.then(() => runJob(job, commit, rt, token), () => runJob(job, commit, rt, token))
  rt.privateGateAll = run.then(() => {}, () => {})
  return run
}

async function runJob(job, commit, rt, token) {
  try {
    return await job(commit)
  } finally {
    if (rt.privateCommitToken === token) rt.privateCommitToken = undefined
  }
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
 * Record which open work line the user picked. Does not itself put the sentence
 * in an inbox. An unknown, closed, or other-bot choice leaves the hold unchanged.
 */
export function bindPrivateHold(state, sessionId, choiceId, generation, now = Date.now()) {
  const hold = privateHold(state, sessionId)
  if (hold == null || typeof choiceId !== 'string' || choiceId === '') return undefined
  if (typeof generation !== 'number' || hold.generation !== generation) return undefined
  if (hold.status === 'bound') return hold.boundTo === choiceId ? hold : undefined
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

/**
 * The ask or new sentence to hand to the bound line. Marks it delivered in
 * memory so the next pre-step will not strip it. The caller appends and wakes.
 * A queue handoff is left alone. Returns undefined when there is nothing to send.
 */
export function releaseBoundSentence(state, sessionId) {
  const hold = privateHold(state, sessionId)
  if (hold == null || hold.status !== 'bound' || hold.delivered === true) return undefined
  const item = [...(hold.items ?? [])].reverse().find(entry => (entry?.action === 'ask' || entry?.action === 'new') && entry.outcome !== 'delivered' && entry.outcome !== 'unrecoverable' && entry.outcome !== 'queue-failed' && typeof entry.text === 'string' && entry.text !== '')
  if (item == null) return undefined
  const line = state.workLines != null && typeof state.workLines === 'object' && !Array.isArray(state.workLines) ? state.workLines[hold.boundTo] : undefined
  const target = typeof line?.sessionId === 'string' && line.sessionId !== '' ? line.sessionId : sessionId
  if (typeof item.messageId === 'string' && item.messageId !== '') noteHoldOutcome(state, sessionId, item.messageId, 'delivered')
  return {
    target,
    messageId: typeof item.messageId === 'string' && item.messageId !== '' ? item.messageId : undefined,
    text: item.text,
    label: hold.label,
  }
}

export function finishBoundDelivery(state, sessionId, delivered) {
  const hold = privateHold(state, sessionId)
  if (hold == null) return undefined
  hold.delivered = delivered === true
  if (delivered !== true) {
    for (const item of hold.items ?? []) {
      if (item?.outcome === 'delivered' && (item.action === 'ask' || item.action === 'new')) item.outcome = 'held'
    }
  }
  return hold
}

export function dropQueuedHold(state, sessionId, messageId) {
  const hold = privateHold(state, sessionId)
  if (hold == null) return
  hold.items = (hold.items ?? []).filter(item => !(item.action === 'queue' && (messageId === undefined || item.messageId === messageId)))
  if (hold.items.length === 0 && hold.status !== 'bound') delete holdsOf(state)[sessionId]
}

/**
 * Pull held sentences out of the array the step would admit.
 * A match is the message id on the hold. The same words on another id are
 * not this sentence, and a queued outcome is not by itself admission.
 * @param {any[]} messages
 * @param {{ items?: { messageId?: string, action?: string, outcome?: string }[] }} [hold]
 */
export function withholdFromStep(messages, hold) {
  const items = (hold?.items ?? []).filter(item => item?.outcome !== 'queued' && item?.outcome !== 'delivered' && (item?.action === 'ask' || item?.action === 'new' || item?.action === 'queue') && typeof item.messageId === 'string' && item.messageId !== '')
  if (items.length === 0) return { kept: messages, withheld: [] }
  const ids = new Set(items.map(item => item.messageId))
  const kept = []
  const withheld = []
  for (const message of messages) {
    if (message?.source?.dsBotDeliver === true) kept.push(message)
    else if (message?.source?.kind === 'user' && ids.has(message?.id)) withheld.push(message)
    else kept.push(message)
  }
  return { kept, withheld }
}
