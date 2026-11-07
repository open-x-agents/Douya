import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runMuseChatTurn } from '../src/web/muse-chat-core.js'

// 2026-11-04 16:20:28 Asia/Shanghai, Muse private chat. The turn finished in the session with the whole
// reply at 16:20:43 and turn/end normal, but no bubble was painted, and the user asked 「怎么没有回复？」
// two minutes later. dsh writes one `assistant/chunk` record per streamed delta (src/web/ui-feed.js), so a
// single long reply is more records than the fixed window the reply wait used to read back from the tail:
// its own user/message fell out of that window and the wait never saw the turn/end that followed it.
const ESSAY = '我不喜欢猫。它总把爪子搭在键盘上，然后若无其事地看着窗外。'.repeat(20)

function liveTurn({ chunks }) {
  const events = []
  let seq = 1
  const session = { seq: 1 }
  let status = 'idle'
  const idle = []
  const bump = (type, data = {}) => {
    events.push({ seq: seq++, time: Date.now(), type, data })
    session.seq = seq
  }
  const wake = () => {
    if (status !== 'idle') return
    while (idle.length) idle.shift()()
  }
  // The page shape the reply wait is written against: the window ends at throughSeq, older pages are
  // asked for by beforeSeq, maxMessages counts records, and hasMore says older records still exist.
  const page = async ({ throughSeq, beforeSeq, maxMessages = 80 } = {}) => {
    let list = events
    if (Number.isInteger(throughSeq)) list = list.filter(event => event.seq <= throughSeq)
    if (Number.isInteger(beforeSeq)) list = list.filter(event => event.seq < beforeSeq)
    const hasMore = list.length > maxMessages
    list = list.slice(-maxMessages)
    return { records: list.map(event => ({ event })), hasMore }
  }
  return {
    events,
    controller: {
      async resolveAgent() {
        return {
          status,
          session,
          whenIdle() {
            if (status !== 'running') return Promise.resolve()
            return new Promise(resolve => idle.push(resolve))
          },
        }
      },
      async prompt(request) {
        const text = (request.content || []).map(part => part?.text || '').join('')
        status = 'running'
        bump('turn/start', {})
        bump('user/message', { source: { kind: 'user', rpcId: request.requestId }, content: [{ type: 'text', text }] })
        for (let i = 0; i < chunks; i += 1) {
          bump('assistant/chunk', { delta: { type: 'text-delta', text: ESSAY[i % ESSAY.length] } })
        }
        bump('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: ESSAY }] } })
        bump('turn/end', { reason: { kind: 'completed' } })
        status = 'idle'
        wake()
      },
      page,
    },
  }
}

test('long streamed turn: 700 chunk records after the prompt still returns its own text', { timeout: 12_000 }, async () => {
  const session = liveTurn({ chunks: 700 })
  const startedAt = Date.now()
  const res = await runMuseChatTurn({ sessionController: session.controller }, {
    message: '重新生成一篇作文',
    dshHome: '/tmp/odm-muse-chat-live-window-missing',
    botId: 'chief',
    log() {},
    waitMs: 6000,
  })
  const ms = Date.now() - startedAt
  assert.equal(res.ok, true)
  assert.equal(res.text, ESSAY)
  assert.equal(res.status, 'answered')
  assert.ok(ms < 4000, `settled in ${ms}ms, expected under 4000ms`)
})
