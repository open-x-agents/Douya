// Single-busy group steer. Pure: no session store and no model SDK.
// One member session in this room has live.turn (including a slot already
// marked working) and the user did not ask to queue, start a new chat, or
// name someone → steer that session. Anything else stays on today's relay.
import { mentionSpans } from '../shared/mentions.js'

/** @typedef {'steer' | 'relay'} RoomSteerAction */

/**
 * @param {{ memberLive?: { turn?: unknown }, explicitQueue?: boolean }} [input]
 * @returns {RoomSteerAction}
 */
export function steerTarget({ memberLive, explicitQueue } = {}) {
  if (explicitQueue === true) return 'relay'
  const turn = memberLive?.turn
  if (turn === undefined || turn === null) return 'relay'
  return 'steer'
}

/**
 * The one busy member session in this room, or undefined when there are
 * zero or several. Callers pass only this room's member sessions.
 * @param {{ sessionId?: string, live?: { turn?: unknown } }[]} [members]
 */
export function singleBusyMember(members = []) {
  const busy = members.filter(member => member?.sessionId && member.live?.turn !== undefined && member.live?.turn !== null)
  return busy.length === 1 ? busy[0] : undefined
}

/**
 * Product lock for this PR: exactly one busy local member, and the user
 * did not explicit-queue, explicit-new, name a member, or attach anything
 * that is not plain text. Opt-outs are passed into steerTarget as
 * explicitQueue so that helper stays the only steer/relay decision.
 * @param {{ members?: { sessionId?: string, live?: { turn?: unknown } }[], explicitQueue?: boolean, explicitNew?: boolean, named?: boolean, plain?: boolean }} [input]
 * @returns {{ action: RoomSteerAction, member: { sessionId?: string, live?: { turn?: unknown } } | undefined }}
 */
export function decideRoomSteer({ members, explicitQueue = false, explicitNew = false, named = false, plain = true } = {}) {
  const blocked = explicitQueue === true || explicitNew === true || named === true || plain === false
  const member = singleBusyMember(members)
  const action = steerTarget({ memberLive: member?.live, explicitQueue: blocked })
  return { action, member: action === 'steer' ? member : undefined }
}

/**
 * Member sessions of one room. `liveOf` / `botOf` read the host maps; a
 * member with no group session yet is not a steer candidate.
 * @param {{ members?: string[], sessions?: Record<string, string> } | undefined | null} room
 * @param {(sessionId: string) => { turn?: unknown } | undefined} liveOf
 * @param {(botId: string) => { id?: string, name?: string } | undefined} botOf
 */
export function roomMembers(room, liveOf, botOf) {
  if (room == null) return []
  const live = typeof liveOf === 'function' ? liveOf : () => undefined
  const bot = typeof botOf === 'function' ? botOf : () => undefined
  const members = []
  for (const id of room.members ?? []) {
    const record = bot(id)
    const sessionId = room.sessions?.[id]
    if (record == null || sessionId == null || sessionId === '') continue
    members.push({
      id: record.id ?? id,
      name: record.name,
      sessionId,
      live: live(sessionId),
    })
  }
  return members
}

/**
 * Flags a send can carry. The composer queue key is not on every user
 * message; channel.send records a relay intent for that path.
 * @param {{ mode?: string, sendMode?: string, admission?: string, explicitQueue?: boolean, queue?: boolean, explicitNew?: boolean }} [source]
 * @param {{ mode?: string, sendMode?: string }} [data]
 */
export function explicitSendFlags(source = {}, data = {}) {
  const mode = source.mode ?? source.sendMode ?? source.admission ?? data.mode ?? data.sendMode
  return {
    explicitQueue: source.explicitQueue === true || source.queue === true || mode === 'queue',
    explicitNew: source.explicitNew === true || mode === 'new',
  }
}

/** @param {string} text @param {{ name?: string }[]} [members] */
export function textNamesMember(text, members) {
  return mentionSpans(String(text ?? ''), members ?? []).length > 0
}

/** A steered user interjection must not be delivered again at turn/end. */
export function isJoinedFollowUp(source) {
  return source?.userSteer !== true
}

/** Drawn inside the current round, same meaning as a private steering cell. */
export function steeringReply({ text, time = Date.now() } = {}) {
  return { kind: 'steering', text, time }
}

/** @param {{ kind?: string }} reply */
export function groupUserBubble(reply) {
  if (reply?.kind !== 'user' && reply?.kind !== 'steering') return undefined
  return { steering: reply.kind === 'steering' }
}

/** Suppressed probe text must not synthesize another group_relay. */
export function opensGroupRelay({ suppressed = false } = {}) {
  return suppressed !== true
}

/**
 * After the speaking slot ends, keep the draft while that member's turn
 * is still running so later tokens stay on the same bubble.
 */
export function keepDraftOnSlotEnd({ draft, memberLive } = {}) {
  if (draft == null) return undefined
  const turn = memberLive?.turn
  if (turn === undefined || turn === null) return undefined
  return draft
}

/**
 * The round that should absorb assistant-stream frames. Prefer the slot
 * that is speaking; otherwise the busy member's quiet slot (draft or working).
 */
export function roundForStream({ rounds, botId, memberLive } = {}) {
  const list = Array.isArray(rounds) ? rounds : []
  const speaking = list.find(round => round?.speaking === botId)
  if (speaking) return speaking
  const turn = memberLive?.turn
  const busy = turn !== undefined && turn !== null
  if (!busy) return undefined
  return list.find(round => (round?.speaking == null || round.speaking === '')
    && (round.draft?.botId === botId || (round.slots ?? []).some(slot => slot.id === botId && slot.status === 'working')))
}

/**
 * Where a member line goes. @mentions still open a relay. A user steer
 * stays on the current bubble, including after the tool call has returned.
 * @param {{ userSteered?: boolean, calls?: boolean, hasRound?: boolean }} [input]
 * @returns {'same' | 'post'}
 */
export function stepRoute({ userSteered = false, calls = false, hasRound = false } = {}) {
  if (calls) return 'post'
  if (userSteered) return 'same'
  if (hasRound) return 'same'
  return 'post'
}

/**
 * Drop one steered inbox line so drainRoomInbox does not append it or
 * call members again. Any other line still opens as today.
 * @param {string[]} lines
 * @param {string} text
 * @returns {{ action: 'drop' | 'open', lines: string[] }}
 */
export function takeSteeredLine(lines, text) {
  const list = Array.isArray(lines) ? lines : []
  const index = list.indexOf(text)
  if (index === -1) return { action: 'open', lines: list }
  return { action: 'drop', lines: list.filter((_, at) => at !== index) }
}

/**
 * Composer busyEnter=steer inserts the line into the room inbox (next-step)
 * before `user/message`. The first of those two events steers; the other is
 * the same line and must not queue. Two events from the same door (two real
 * sends, or two splices) both stay fresh.
 * @param {{ text: string, via: 'splice' | 'message' }[]} pending
 * @param {string} text
 * @param {'splice' | 'message'} via
 * @returns {{ role: 'echo' | 'fresh', pending: { text: string, via: 'splice' | 'message' }[] }}
 */
export function pairComposerEcho(pending, text, via) {
  const list = (Array.isArray(pending) ? pending : []).map(item => ({ text: item.text, via: item.via }))
  const index = list.findIndex(item => item.text === text && item.via !== via)
  if (index === -1) return { role: 'fresh', pending: list }
  list.splice(index, 1)
  return { role: 'echo', pending: list }
}

/** @param {{ text: string, via: 'splice' | 'message' }[]} pending @param {string} text @param {'splice' | 'message'} via */
export function rememberComposerSteer(pending, text, via) {
  const list = (Array.isArray(pending) ? pending : []).map(item => ({ text: item.text, via: item.via }))
  list.push({ text, via })
  return list.length > 20 ? list.slice(-20) : list
}
