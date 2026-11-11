import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ownReplyFromRecords, runMuseChatTurn, turnWorkFromRecords, NO_REPLY_ERROR, SILENT_TURN_ERROR } from '../src/web/muse-chat-core.js'

// 2026-11-04 09:31 Asia/Shanghai, Chief private session session-a70c2ab4:
// 「你是谁」 then 「在干嘛」 while turn 30 was still running. The session log kept
// 「我是 Chief…」 and 「待命中…」 as two assistant messages. The panel showed the
// second text in both bot bubbles because each /api/chat wait read the latest assistant
// text after the agent went fully idle.
const VIEW = '【当前视图】今天页 · 未筛选'
const CHIEF = '我是 Chief，你的 Bot 团队主管——负责建 Bot、派任务、盯进度、向你汇报。'
const STANDBY = '待命中，没在跑任务 😌\n\n上一件事是 #11，你说取消，我就停了。现在空着手。'

const user = (seq, text, rpcId) => ({
  event: {
    seq, time: seq, type: 'user/message',
    data: { source: { kind: 'user', ...(rpcId ? { rpcId } : {}) }, content: [{ type: 'text', text }] },
  },
})
const clock = seq => ({
  event: {
    seq, time: seq, type: 'user/message',
    data: { source: { kind: 'time-context' }, content: [{ type: 'text', text: 'Time sampled while preparing turn 30, step 1' }] },
  },
})
const assistant = (seq, text) => ({
  event: { seq, time: seq, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } },
})
const turnEnd = (seq, kind, reason) => ({
  event: { seq, time: seq, type: 'turn/end', data: { reason: reason ? { kind, reason } : { kind } } },
})
const turnStart = seq => ({ event: { seq, time: seq, type: 'turn/start', data: { turn: seq } } })

function pairRecords() {
  return [
    user(1, `${VIEW}\n\n你是谁`, 'req-30'),
    clock(2),
    assistant(3, '我先看一下'),
    assistant(4, CHIEF),
    turnEnd(5, 'completed'),
    turnStart(6),
    user(7, `${VIEW}\n\n在干嘛`, 'req-31'),
    assistant(8, STANDBY),
    turnEnd(9, 'completed'),
  ]
}

test('both finished turns keep their own assistant text, including when read together at the end', () => {
  const records = pairRecords()
  const first = ownReplyFromRecords(records, { afterSeq: 0, requestId: 'req-30', outbound: `${VIEW}\n\n你是谁` })
  const second = ownReplyFromRecords(records, { afterSeq: 0, requestId: 'req-31', outbound: `${VIEW}\n\n在干嘛` })
  assert.equal(first.text, CHIEF)
  assert.equal(second.text, STANDBY)
  // Text match, no request id: the cursor still has to pick the message this prompt caused.
  assert.equal(ownReplyFromRecords(records, { afterSeq: 0, outbound: `${VIEW}\n\n你是谁` }).text, CHIEF)
  assert.equal(ownReplyFromRecords(records, { afterSeq: 5, outbound: `${VIEW}\n\n在干嘛` }).text, STANDBY)
})

test('a later open turn does not hide the reply that already finished', () => {
  const records = pairRecords().slice(0, 7) // through the second user message; turn 31 has no reply yet
  assert.equal(ownReplyFromRecords(records, { afterSeq: 0, outbound: `${VIEW}\n\n你是谁` }).text, CHIEF)
  assert.deepEqual(ownReplyFromRecords(records, { afterSeq: 5, outbound: `${VIEW}\n\n在干嘛` }), { settled: false })
})

test('mid-turn text is not the answer, and an older copy of the same words is not this prompt', () => {
  const open = [user(1, '你是谁'), assistant(2, '我先查卡片…')]
  assert.deepEqual(ownReplyFromRecords(open, { afterSeq: 0, outbound: '你是谁' }), { settled: false })
  const again = [
    user(1, '你是谁'), assistant(2, '旧回复'), turnEnd(3, 'completed'),
    user(4, '你是谁'), turnStart(5),
  ]
  assert.deepEqual(ownReplyFromRecords(again, { afterSeq: 3, outbound: '你是谁' }), { settled: false })
})

test('identical rapid prompts stay apart by request id', () => {
  const records = [
    user(1, '你是谁', 'a'), assistant(2, '第一'), turnEnd(3, 'completed'),
    user(4, '你是谁', 'b'), assistant(5, '第二'), turnEnd(6, 'completed'),
  ]
  assert.equal(ownReplyFromRecords(records, { afterSeq: 0, requestId: 'a', outbound: '你是谁' }).text, '第一')
  assert.equal(ownReplyFromRecords(records, { afterSeq: 0, requestId: 'b', outbound: '你是谁' }).text, '第二')
})

test('an interrupted turn keeps waiting for the resumed answer and does not take the next send', () => {
  const records = [
    user(1, '你是谁', 'a'),
    assistant(2, '先查一下'),
    turnEnd(3, 'interrupted'),
    assistant(4, CHIEF),
    turnEnd(5, 'completed'),
    user(6, '在干嘛', 'b'),
    assistant(7, STANDBY),
    turnEnd(8, 'completed'),
  ]
  assert.equal(ownReplyFromRecords(records, { afterSeq: 0, requestId: 'a', outbound: '你是谁' }).text, CHIEF)
  assert.equal(ownReplyFromRecords(records, { afterSeq: 0, requestId: 'b', outbound: '在干嘛' }).text, STANDBY)
  const stopped = [
    user(1, '你是谁', 'a'),
    turnEnd(2, 'aborted', { kind: 'user' }),
    user(3, '在干嘛', 'b'),
    assistant(4, STANDBY),
    turnEnd(5, 'completed'),
  ]
  assert.deepEqual(ownReplyFromRecords(stopped, { afterSeq: 0, requestId: 'a', outbound: '你是谁' }), { settled: true, text: '' })
})

test('flat page records and a handoff seq reset still find this prompt', () => {
  const flat = [
    { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你是谁' }] } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Chief' }] } } },
    { seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]
  assert.equal(ownReplyFromRecords(flat, { afterSeq: 0, outbound: '你是谁' }).text, 'Chief')
  const moved = [user(1, '你是谁', 'req'), assistant(2, 'Chief'), turnEnd(3, 'completed')]
  assert.equal(ownReplyFromRecords(moved, { afterSeq: 9, requestId: 'req', outbound: '你是谁' }).settled, false)
  assert.equal(ownReplyFromRecords(moved, { afterSeq: 9, requestId: 'req', outbound: '你是谁', handoff: true }).text, 'Chief')
})

function queuedSession() {
  const events = []
  let seq = 1
  const session = { seq: 1 }
  let status = 'idle'
  const queue = []
  const idle = []
  const bump = (type, data = {}) => {
    events.push({ seq: seq++, time: Date.now(), type, data })
    session.seq = seq
  }
  const wake = () => {
    if (status === 'idle' && queue.length === 0) while (idle.length) idle.shift()()
  }
  const begin = item => {
    status = 'running'
    bump('turn/start', {})
    bump('user/message', {
      source: { kind: 'user', ...(item.stampId ? { rpcId: item.requestId } : {}) },
      content: [{ type: 'text', text: item.text }],
    })
  }
  return {
    events,
    append: bump,
    finish(text) {
      if (text) bump('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text }] } })
      bump('turn/end', { reason: { kind: 'completed' } })
      const next = queue.shift()
      if (next) begin(next)
      else { status = 'idle'; wake() }
    },
    controller({ stampId = false, onPrompt, page } = {}) {
      return {
        async resolveAgent() {
          return {
            status,
            session,
            whenIdle() {
              if (status !== 'running' && queue.length === 0) return Promise.resolve()
              return new Promise(resolve => { idle.push(resolve) })
            },
          }
        },
        async prompt(request) {
          const text = (request.content || []).map(part => part?.text || '').join('')
          const item = { text, requestId: request.requestId, stampId }
          if (status === 'running') {
            bump('agent/inbox/spliced', { target: 'next-turn' })
            queue.push(item)
            return
          }
          begin(item)
          if (onPrompt) await onPrompt(item)
        },
        page: page || (async () => ({ records: events.map(event => ({ event })), hasMore: false })),
      }
    },
  }
}

const chiefCall = (sessionController, message, extra = {}) => runMuseChatTurn({ sessionController }, {
  message,
  viewContext: VIEW,
  dshHome: '/tmp/odm-muse-chat-rapid-missing',
  botId: 'chief',
  log() {},
  waitMs: 4000,
  ...extra,
})

test('two queued prompts each return their own reply while the later turn is still running', { timeout: 12_000 }, async () => {
  const session = queuedSession()
  const first = chiefCall(session.controller(), '你是谁')
  const saw = (type, text) => session.events.some(event => event.type === type && (!text || JSON.stringify(event.data).includes(text)))
  const until = async pred => {
    const end = Date.now() + 2000
    while (Date.now() < end) {
      if (pred()) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('timed out waiting for the session')
  }
  await until(() => saw('user/message', '你是谁'))
  let secondSettled = false
  const second = chiefCall(session.controller(), '在干嘛').then(result => { secondSettled = true; return result })
  await until(() => saw('agent/inbox/spliced'))
  session.finish(CHIEF)
  const a = await first
  assert.equal(secondSettled, false)
  assert.equal(session.events.filter(event => event.type === 'turn/end').length, 1)
  assert.equal(a.ok, true)
  assert.equal(a.text, CHIEF)
  assert.equal(session.events.find(event => event.type === 'user/message').data.content[0].text, `${VIEW}\n\n你是谁`)
  session.finish(STANDBY)
  const b = await second
  assert.equal(b.ok, true)
  assert.equal(b.text, STANDBY)
})

test('a completed turn with no assistant text does not take the next turn\'s reply', async () => {
  const session = queuedSession()
  const result = await chiefCall(session.controller({
    stampId: true,
    onPrompt(item) {
      session.finish('')
      session.append('user/message', { source: { kind: 'user', rpcId: 'other' }, content: [{ type: 'text', text: `${VIEW}\n\n在干嘛` }] })
      session.append('assistant/message', { message: { content: [{ type: 'text', text: STANDBY }] } })
      session.append('turn/end', { reason: { kind: 'completed' } })
      assert.equal(item.text.includes('你是谁'), true)
    },
  }), '你是谁')
  assert.equal(result.ok, false)
  assert.equal(result.error, 'Bot 没有产生新回复')
})

test('a long tool turn is still attributed when the user message is off the newest page', async () => {
  const session = queuedSession()
  const result = await chiefCall(session.controller({
    stampId: true,
    async onPrompt() {
      for (let i = 0; i < 200; i++) session.append('tool/call', { name: 'bash' })
      session.finish('长回复')
    },
    page: async ({ beforeSeq, maxMessages }) => {
      let list = session.events.filter(event => beforeSeq == null || event.seq < beforeSeq)
      const hasMore = list.length > maxMessages
      list = list.slice(-maxMessages)
      return { records: list.map(event => ({ event })), hasMore }
    },
  }), 'hi', { viewContext: '' })
  assert.equal(result.ok, true)
  assert.equal(result.text, '长回复')
})

test('hiddenContext is prepended for the model and kept off the display record', async () => {
  const recorded = []
  const session = queuedSession()
  const display = { record(id, items) { recorded.push({ id, items }) } }
  const result = await runMuseChatTurn({ sessionController: session.controller({
    stampId: true,
    onPrompt() { session.finish('好，先读这一步') },
  }) }, {
    message: "Let's do this together: Turn orbit #2116 review into a PR",
    hiddenContext: 'Plan: Become a steady maintainer (plan p1)\nStep: Turn orbit #2116 review into a PR (step s1)\nRead odm_future_get first',
    viewContext: '',
    dshHome: '/tmp/odm-muse-chat-rapid-missing',
    botId: 'chief',
    log() {},
    waitMs: 4000,
    display,
  })
  assert.equal(result.ok, true)
  const sent = session.events.find(event => event.type === 'user/message').data.content[0].text
  assert.match(sent, /odm_future_get/)
  assert.match(sent, /plan p1/)
  assert.match(sent, /Let's do this together: Turn orbit #2116 review into a PR/)
  assert.equal(recorded[0].items[0].text, "Let's do this together: Turn orbit #2116 review into a PR")
  assert.doesNotMatch(recorded[0].items[0].text, /odm_future_get/)
})


test('intermediate assistant and tool events mean the turn is still working', () => {
  const open = [
    user(1, '都开始吧', 'req'),
    turnStart(2),
    { event: { seq: 3, time: 3, type: 'tool/call', data: { name: 'bash' } } },
    assistant(4, '先跑测试'),
  ]
  const work = turnWorkFromRecords(open, { afterSeq: 0, requestId: 'req', outbound: '都开始吧' })
  assert.equal(work.settled, false)
  assert.equal(work.working, true)
  assert.equal(work.open, true)
  const done = [...open, turnEnd(5, 'completed')]
  const finished = turnWorkFromRecords(done, { afterSeq: 0, requestId: 'req', outbound: '都开始吧' })
  assert.equal(finished.settled, true)
  assert.equal(finished.working, false)
  assert.equal(finished.text, '先跑测试')
})

test('a long open turn past waitMs is not reported as no reply', { timeout: 12_000 }, async () => {
  const session = queuedSession()
  let released
  const started = new Promise(r => { released = r })
  const resultP = chiefCall(session.controller({
    stampId: true,
    async onPrompt() {
      session.append('tool/call', { name: 'bash' })
      released()
      await new Promise(r => setTimeout(r, 600))
      session.finish('测完了')
    },
  }), '都开始吧', { waitMs: 200, viewContext: '' })
  await started
  const result = await resultP
  assert.equal(result.ok, true)
  assert.equal(result.text, '测完了')
  assert.equal(result.error, undefined)
})

test('a follow-up queued behind an open turn does not fail after waitMs', { timeout: 12_000 }, async () => {
  const session = queuedSession()
  let firstPrompted
  const gate = new Promise(r => { firstPrompted = r })
  const first = chiefCall(session.controller({
    stampId: true,
    async onPrompt() { session.append('tool/call', { name: 'bash' }); firstPrompted() },
  }), '都开始吧', { waitMs: 200, viewContext: '' })
  await gate
  let secondSettled = false
  const second = chiefCall(session.controller({ stampId: true }), '？', { waitMs: 200, viewContext: '' }).then(r => { secondSettled = true; return r })
  await new Promise(r => setTimeout(r, 350))
  assert.equal(secondSettled, false, 'follow-up must keep waiting while the first turn is open')
  session.finish('先做完了')
  const a = await first
  assert.equal(a.ok, true)
  assert.equal(a.text, '先做完了')
  session.finish('问号的回复')
  const b = await second
  assert.equal(b.ok, true)
  assert.equal(b.text, '问号的回复')
})

test('true silence after waitMs is a clear error, not a stale TIMEOUT and not a finished no-reply', { timeout: 8_000 }, async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = await mkdtemp(join(tmpdir(), 'odm-chat-silent-'))
  await mkdir(join(home, 'bot', 'logs'), { recursive: true })
  await writeFile(join(home, 'bot', 'logs', 'diagnostics.jsonl'), JSON.stringify({
    time: Date.now() - 3600_000, level: 'error', sessionId: 'chief', code: 'TIMEOUT', text: 'TIMEOUT',
  }) + '\n')
  const session = queuedSession()
  const result = await runMuseChatTurn({
    sessionController: {
      async resolveAgent() { return { status: 'idle', session: { seq: 1 }, whenIdle() { return Promise.resolve() } } },
      async prompt() { /* swallowed; no turn starts */ },
      async page() { return { records: [], hasMore: false } },
    },
  }, { message: '都开始吧', dshHome: home, botId: 'chief', log() {}, waitMs: 250, viewContext: '' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'silent')
  assert.equal(result.error, SILENT_TURN_ERROR)
  assert.notEqual(result.error, 'TIMEOUT')
  assert.notEqual(result.error, NO_REPLY_ERROR)
})

test('a still-running turn ignores a fresh diagnostics TIMEOUT for this session', { timeout: 12_000 }, async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = await mkdtemp(join(tmpdir(), 'odm-chat-stale-'))
  await mkdir(join(home, 'bot', 'logs'), { recursive: true })
  await writeFile(join(home, 'bot', 'logs', 'diagnostics.jsonl'), JSON.stringify({
    time: Date.now(), level: 'error', sessionId: 'chief', code: 'TIMEOUT', text: 'TIMEOUT',
  }) + '\n')
  const session = queuedSession()
  let released
  const started = new Promise(r => { released = r })
  const resultP = runMuseChatTurn({ sessionController: session.controller({
    stampId: true,
    async onPrompt() {
      session.append('tool/call', { name: 'bash' })
      released()
      await new Promise(r => setTimeout(r, 500))
      session.finish('还在跑，写完了')
    },
  }) }, { message: '都开始吧', dshHome: home, botId: 'chief', log() {}, waitMs: 200, viewContext: '' })
  await started
  const result = await resultP
  assert.equal(result.ok, true)
  assert.equal(result.text, '还在跑，写完了')
  assert.notEqual(result.error, 'TIMEOUT')
})
