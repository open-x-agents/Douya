// A group-wide stop must leave the group Session's inbox empty of the relays a stop
// leaves behind. Every post into the group queues one, and the UI reads that queue, so
// a relay left there keeps work shown as queued/waiting after the user stopped it.
//
// These are the rules alone, without the host: which queued message is a relay of this
// room, what text it carries, and the log line a post becomes when its line never
// reached the log. `stopRoomWork` in groups.js is the only caller.
import { lateCite } from '../shared/work-line-complete.js'

// A relay that opens a round of its own. `post` carries a member's text or an event,
// `kickoff` the greeting of a new group, `resume` the Continue of a paused one.
const ROUND_ROLES = new Set(['post', 'kickoff', 'resume'])
const GROUP_HEADER = /^\[Group post from [^\]\n]+\]\n?/

/** Whether one queued message is a relay of this room that would open a round. */
export const isRoomRelay = (source, roomId) =>
  source?.kind === 'bot' && source?.form === 'relay' && source?.roomId === roomId && ROUND_ROLES.has(source?.role)

/** The relays of this room among the Session's pending messages, in inbox order. */
export function relayMessages(inbox, roomId) {
  const turn = Array.isArray(inbox?.nextTurn) ? inbox.nextTurn : []
  const step = Array.isArray(inbox?.nextStep) ? inbox.nextStep : []
  return [...turn, ...step].filter(message => isRoomRelay(message?.source, roomId))
}

const textBlocks = content =>
  (Array.isArray(content) ? content : []).filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')

/** A group post's text without the `[Group post from X]` line its relay carries. */
export const stripGroupHeader = text => String(text ?? '').replace(GROUP_HEADER, '')

/** The text a relay message carries, header dropped. */
export const relayText = content => stripGroupHeader(textBlocks(content))

/** The attachments a relay message carries, as the post was given them. */
export const relayFiles = content =>
  (Array.isArray(content) ? content : []).filter(block => block?.type === 'file' && block.attachment !== undefined).map(block => block.attachment)

const fileLine = file => `[File "${file.name}" (${file.bytes} bytes) attached]`

/**
 * The log line a post becomes, or `undefined` when it makes none: a failed model call
 * is an event of the round only, and a post with no text and no files says nothing.
 * A done/stopped/resumed post is an event line with no text of its own.
 * @param {{ room?: { id?: string }, sender?: { id?: string, name?: string }, text?: string, extra?: Record<string, unknown>, files?: { name?: string, bytes?: number }[] }} [input]
 */
export function postLine({ room, sender, text = '', extra = {}, files = [] } = {}) {
  if (extra?.failed !== undefined) return undefined
  const who = sender?.name
  const botId = sender?.id
  if (extra?.done === true || extra?.stopped === true || extra?.resumed === true) {
    const kind = extra.done === true ? 'done' : extra.stopped === true ? 'stopped' : extra.again === true ? 'cut' : 'resumed'
    return { who, botId, kind, text: '' }
  }
  const body = [stripGroupHeader(text), ...files.map(fileLine)].filter(Boolean).join('\n')
  if (body === '') return undefined
  const cite = extra?.late === true ? lateCite(extra) : {}
  const pointer = typeof cite.quoteSeq === 'number' ? { quote: { roomId: cite.quoteRoomId ?? room?.id, seq: cite.quoteSeq } } : {}
  return { who, botId, text: body, ...(files.length > 0 ? { files } : {}), ...pointer }
}
