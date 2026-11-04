import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dockMessagesFromRecords, loadLiveDockHistory } from '../src/web/muse-chat-core.js'
import { historyMessages, locateSessionLog, sessionLogRank } from '../src/web/dsbot-chat.js'
import { createChatDisplay } from '../src/web/chat-display.js'

// BR-022: after a hard reload the today-chat dock painted empty while Chief's session
// still had both turns (你是谁 → identity, 在干嘛 → 待命). Stock UI reads the live
// session page. Muse history used to open only session.jsonl and treat a user/message
// with no `role` as an assistant line, so the dock list stayed empty.
const VIEW = '【当前视图】今天页 · 未筛选 · 没有置顶'
const CHIEF = '我是 Chief，你的 Bot 团队主管。'
const STANDBY = '在待命，没有任务在跑。'
const AT = 1730700000000

const user = (seq, text, source = { kind: 'user' }) => ({
  seq, time: AT + seq, type: 'user/message', data: { source, content: [{ type: 'text', text }] },
})
const assistant = (seq, text) => ({
  seq, time: AT + seq, type: 'assistant/message',
  data: { turn: seq, step: 1, content: [{ type: 'reasoning', text: 'skip' }, { type: 'text', text }] },
})
const turnEnd = seq => ({ seq, time: AT + seq, type: 'turn/end', data: { reason: { kind: 'completed' } } })

function pairEvents() {
  return [
    user(1, `${VIEW}\n\n你是谁`),
    user(2, 'Current time: 2026-11-04, 14:41:00 GMT+08:00', { kind: 'time-context' }),
    assistant(3, '我先看一下'),
    assistant(4, CHIEF),
    turnEnd(5),
    user(6, `${VIEW}\n\n在干嘛`),
    assistant(7, STANDBY),
    turnEnd(8),
  ]
}

const BUBBLES = [
  { role: 'user', content: '你是谁', at: AT + 1 },
  { role: 'assistant', content: CHIEF, at: AT + 4 },
  { role: 'user', content: '在干嘛', at: AT + 6 },
  { role: 'assistant', content: STANDBY, at: AT + 7 },
]

test('reload hydrate keeps both user bubbles and both distinct replies', () => {
  const wrapped = pairEvents().map(event => ({ event }))
  assert.deepEqual(dockMessagesFromRecords(wrapped), BUBBLES)
  assert.notEqual(BUBBLES[1].content, BUBBLES[3].content)
  const raw = pairEvents().map(event => JSON.stringify(event)).join('\n')
  assert.deepEqual(historyMessages(raw), BUBBLES)
  // A handoff note and an older log shape (role on the message, no source.kind) still restore.
  const legacy = [
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '[Handoff · part 2] moved' }] } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Noted. I have my handoff note and carry on from here.' }] } } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '【当前卡片】id=x\n标题：y\n\n这张卡片里有哪几条?' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '有 3 条。' }] } } },
  ].map(x => JSON.stringify(x)).join('\n')
  assert.deepEqual(historyMessages(legacy), [
    { role: 'user', content: '这张卡片里有哪几条?' },
    { role: 'assistant', content: '有 3 条。' },
  ])
})

test('session log picker prefers the current generation over session.jsonl', () => {
  assert.ok(sessionLogRank('session.v4.jsonl.zstd') > sessionLogRank('session.v4.jsonl'))
  assert.ok(sessionLogRank('session.v4.jsonl') > sessionLogRank('session.v3.jsonl.zstd'))
  assert.ok(sessionLogRank('session.v3.jsonl.zstd') > sessionLogRank('session.jsonl.zstd'))
  assert.equal(sessionLogRank('notes.txt'), -1)
  const home = mkdtempSync(join(tmpdir(), 'odm-hist-'))
  const dir = join(home, 'sessions', 'ws', 'session-B')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.jsonl'), '{"type":"assistant/message","data":{"content":[{"type":"text","text":"旧回复"}]}}\n')
  writeFileSync(join(dir, 'session.jsonl.zstd'), '')
  writeFileSync(join(dir, 'session.v4.jsonl'), pairEvents().map(event => JSON.stringify(event)).join('\n') + '\n')
  const picked = locateSessionLog(home, 'session-B')
  assert.equal(picked, join(dir, 'session.v4.jsonl'))
  assert.deepEqual(historyMessages(pairEvents().map(e => JSON.stringify(e)).join('\n')), BUBBLES)
})

function chiefHome() {
  const home = mkdtempSync(join(tmpdir(), 'odm-live-'))
  mkdirSync(join(home, 'bot'), { recursive: true })
  writeFileSync(join(home, 'bot', 'state.json'), JSON.stringify({
    mainBotId: 'session-A',
    bots: { 'session-A': { id: 'session-A', sessionId: 'session-B', segments: [{ sessionId: 'session-A' }] } },
  }))
  return home
}

function pagingController(bySession) {
  const page = async ({ address, beforeSeq, maxMessages }) => {
    const events = bySession[address.sessionId] || []
    let list = events.filter(event => beforeSeq == null || event.seq < beforeSeq)
    const hasMore = list.length > maxMessages
    list = list.slice(-maxMessages)
    return { records: list.map(event => ({ event })), hasMore }
  }
  return {
    async resolveAgent(sessionId) {
      const events = bySession[sessionId] || []
      const seq = events.length ? events[events.length - 1].seq + 1 : 1
      return { agent: { session: { seq } } }
    },
    page,
  }
}

test('live session page restores the dock after reload even when session.jsonl is stale', async () => {
  const home = chiefHome()
  const stale = join(home, 'sessions', 'ws', 'session-B')
  mkdirSync(stale, { recursive: true })
  writeFileSync(join(stale, 'session.jsonl'), '{"type":"assistant/message","data":{"content":[{"type":"text","text":"旧回复"}]}}\n')
  const older = [
    user(1, `${VIEW}\n\n你好`),
    assistant(2, '你好。'),
    turnEnd(3),
  ]
  const tail = pairEvents().map(event => ({ ...event, seq: event.seq + 10, time: AT + event.seq + 10 }))
  // Pad the current part so the replies sit behind a page of non-chat events.
  const noise = Array.from({ length: 100 }, (_, i) => ({ seq: 30 + i, time: AT, type: 'tool/call', data: { name: 'bash' } }))
  const current = [...tail, ...noise]
  const ctx = { sessionController: pagingController({ 'session-A': older, 'session-B': current }) }
  const hist = await loadLiveDockHistory(ctx, { dshHome: home, limit: 40 })
  assert.equal(hist.sessionId, 'session-B')
  assert.deepEqual(hist.messages.slice(-4).map(m => m.content), ['你是谁', CHIEF, '在干嘛', STANDBY])
  assert.equal(hist.messages.some(m => m.content === '旧回复'), false)
  assert.equal(hist.messages.some(m => m.content === '我先看一下'), false)
  const last = await loadLiveDockHistory(ctx, { dshHome: home, limit: 2 })
  assert.deepEqual(last.messages.map(m => m.content), ['在干嘛', STANDBY])
})

test('live page restore keeps attachment chips and drops the model-only note', async () => {
  const home = chiefHome()
  const display = createChatDisplay({ home })
  display.record('rpc-a', [{ text: '图里写的口令是什么？', attachments: [{ kind: 'file', name: 'note.txt', mediaType: 'text/plain', data: Buffer.from('x').toString('base64') }] }])
  const events = [
    { seq: 1, time: AT, type: 'user/message', data: { source: { kind: 'user', rpcId: 'rpc-a' }, content: [{ type: 'text', text: '【当前视图】今天页\n\n图里写的口令是什么？\n\n【附件】\n文件「note.txt」' }] } },
    { seq: 2, time: AT + 2, type: 'assistant/message', data: { content: [{ type: 'text', text: 'ODM-VIS-1234' }] } },
  ]
  const ctx = { sessionController: pagingController({ 'session-B': events, 'session-A': [] }) }
  const hist = await loadLiveDockHistory(ctx, { dshHome: home, display })
  assert.equal(hist.messages[0].content, '图里写的口令是什么？')
  assert.equal(hist.messages[0].attachments[0].name, 'note.txt')
  assert.equal(hist.messages[1].content, 'ODM-VIS-1234')
  assert.equal(JSON.stringify(hist.messages).includes('【附件】'), false)
  const routes = readFileSync(new URL('../src/web/dsh-host-routes.js', import.meta.url), 'utf8')
  assert.match(routes, /loadLiveDockHistory\(ctx, \{ dshHome, display: router\.chatDisplay\(\) \}/)
})

test('today-chat paints history when the dock is built, not only if the sheet is empty', () => {
  const html = readFileSync(new URL('../src/client/index.html', import.meta.url), 'utf8')
  const fn = html.slice(html.indexOf('async function ensureInlineBotHistory'), html.indexOf('const CHAT_IMAGE_MAX'))
  assert.match(fn, /fetch\('\/api\/chat\/history', \{ cache: 'no-store' \}/)
  assert.doesNotMatch(fn, /childElementCount/, 'a placeholder child must not hide the restored transcript')
  assert.match(fn, /body\.insertBefore\(frag, body\.firstChild\)/)
  assert.match(html, /__odmTodayComposer = todayComposer;\n\s*ensureInlineBotHistory\(\)/)
})

test('a session page that cannot be read does not report an empty dock', async () => {
  const home = chiefHome()
  const ctx = {
    sessionController: {
      async resolveAgent() { return { agent: { session: { seq: 2 } } } },
      async page() { throw new Error('page down') },
    },
  }
  assert.equal(await loadLiveDockHistory(ctx, { dshHome: home }), null)
})
