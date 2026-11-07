import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { historyFromRecords, loadMuseHistory } from '../src/web/muse-chat-core.js'
import { createApiRouter } from '../src/web/api.js'
import { createConfigStore } from '../src/web/config-store.js'
import { registerMuseHostRoutes } from '../src/web/dsh-host-routes.js'

const VIEW = '【当前视图】今天页 · 未筛选'
const CHIEF = '我是 Chief，你的 Bot 团队主管。'
const STANDBY = '待命中，没在跑任务 😌'

const owner = (seq, text) => ({ event: { seq, time: 1_790_000_000_000 + seq, type: 'user/message', data: { role: 'user', source: { kind: 'user', rpcId: `r${seq}` }, content: [{ type: 'text', text }] } } })
const relay = (seq, text) => ({ event: { seq, time: 1_790_000_000_000 + seq, type: 'user/message', data: { role: 'user', source: { kind: 'bot', form: 'relay' }, content: [{ type: 'text', text }] } } })
const assist = (seq, text) => ({ event: { seq, time: 1_790_000_000_000 + seq, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } } })
const tool = seq => ({ event: { seq, time: 1_790_000_000_000 + seq, type: 'tool/call', data: { name: 'bash' } } })
const end = seq => ({ event: { seq, time: 1_790_000_000_000 + seq, type: 'turn/end', data: { reason: { kind: 'completed' } } } })

// What a prompt with one picture looks like on the wire, and what the user's bubble showed for it.
const ATTACH_TEXT = '请看我附上的内容。'
const ATTACH_NOTE = `${ATTACH_TEXT}\n\n【附件】\n图片「a.png」（12KB，mediaType=image/png）`
const ATTACH_SHOWN = [{ text: ATTACH_TEXT, attachments: [{ kind: 'image', name: 'a.png', bytes: 12_288, mediaType: 'image/png' }] }]
const picture = (seq, rpcId, text = ATTACH_NOTE) => ({ event: { seq, time: 1_790_000_000_000 + seq, type: 'user/message', data: { role: 'user', source: { kind: 'user', rpcId }, content: [{ type: 'text', text }, { type: 'image' }] } } })
const steer = (seq, rpcId, more) => ({ event: { seq, time: 1_790_000_000_000 + seq, type: 'user/message', data: { role: 'user', source: { kind: 'user', rpcId }, content: [{ type: 'text', text: `（补充一条，请和上一条一起回答，一次回复）\n${more}` }] } } })
const DONE = '【刚处理完 · 以此为准】下面这些用户已经做完（邮件/评论已发出），回答「还有什么没做」时不要再列它们：\n已发送：回复邮件给 fledge'

function pairRecords() {
  return [
    owner(1, `${VIEW}\n\n你是谁`),
    tool(2),
    assist(3, '我先看一下'),
    assist(4, CHIEF),
    end(5),
    owner(6, `${VIEW}\n\n在干嘛`),
    assist(7, STANDBY),
    end(8),
  ]
}

test('the dock transcript is the owner turns: one bubble per prompt, the turn\'s last text as the reply', () => {
  const messages = historyFromRecords(pairRecords())
  assert.deepEqual(messages.map(m => [m.role, m.content]), [
    ['user', '你是谁'],
    ['assistant', CHIEF],
    ['user', '在干嘛'],
    ['assistant', STANDBY],
  ])
  assert.ok(messages.every(m => /^\d{4}-\d{2}-\d{2}T/.test(m.at)), 'every restored bubble keeps its time')
})

test('team relays, runtime injections and clock rows are not the owner\'s words', () => {
  const messages = historyFromRecords([
    relay(1, '[Message from Chief] Task p2215: 把 PR #2215 审到 PASS'),
    assist(2, 'Chief 的内部回答'),
    owner(3, '【当前卡片】这张卡…\n\n这张卡讲什么?'),
    assist(4, '讲 PR #2215。'),
    { event: { seq: 5, time: 1, type: 'user/message', data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current runtime context.' }] } } },
  ])
  assert.deepEqual(messages.map(m => [m.role, m.content]), [
    ['user', '这张卡讲什么?'],
    ['assistant', '讲 PR #2215。'],
  ])
  // Only the context blocks are peeled: a multi-paragraph prompt keeps every paragraph.
  const multi = historyFromRecords([
    owner(1, `${VIEW}\n\n第一段\n\n第二段`),
    assist(2, '收到'),
  ])
  assert.deepEqual(multi.map(m => [m.role, m.content]), [['user', '第一段\n\n第二段'], ['assistant', '收到']])
  // A message that is nothing but context opens no turn, so its answer stays out too.
  assert.deepEqual(historyFromRecords([owner(1, VIEW), assist(2, '收到')]).map(m => m.content), [])
})

function fakeCtx(recordsBySession) {
  return {
    sessionController: {
      async resolveAgent(sessionId) {
        return { status: 'idle', session: { seq: (recordsBySession[sessionId] || []).length + 1 } }
      },
      async page({ address }) {
        return { records: recordsBySession[address.sessionId] || [], hasMore: false }
      },
    },
  }
}

function dshHomeWith(sessionId, botId = 'chief') {
  const home = mkdtempSync(join(tmpdir(), 'odm-history-'))
  mkdirSync(join(home, 'bot'), { recursive: true })
  writeFileSync(join(home, 'bot', 'state.json'), JSON.stringify({ mainBotId: botId, bots: { [botId]: { id: botId, sessionId } } }))
  return home
}

test('loadMuseHistory reads the Chief\'s current part in process, no log file and no zstd', async () => {
  const dshHome = dshHomeWith('session-chief')
  const ctx = fakeCtx({ 'session-chief': pairRecords() })
  const hist = await loadMuseHistory(ctx, { dshHome })
  assert.equal(hist.botId, 'chief')
  assert.deepEqual(hist.messages.map(m => m.content), ['你是谁', CHIEF, '在干嘛', STANDBY])
})

test('a retired part that cannot be read does not empty the transcript', async () => {
  const dshHome = dshHomeWith('session-new')
  const bot = JSON.parse(readFileSync(join(dshHome, 'bot', 'state.json'), 'utf8'))
  bot.bots.chief.segments = [{ sessionId: 'session-old' }]
  writeFileSync(join(dshHome, 'bot', 'state.json'), JSON.stringify(bot))
  const ctx = fakeCtx({ 'session-new': pairRecords() })
  ctx.sessionController.page = async ({ address }) => {
    if (address.sessionId === 'session-old') throw new Error('retired')
    return { records: pairRecords(), hasMore: false }
  }
  const hist = await loadMuseHistory(ctx, { dshHome })
  assert.deepEqual(hist.messages.map(m => m.content), ['你是谁', CHIEF, '在干嘛', STANDBY])
})

test('no sessionController (standalone server) reads nothing instead of throwing', async () => {
  const hist = await loadMuseHistory(null, { dshHome: dshHomeWith('session-chief') })
  assert.deepEqual(hist.messages, [])
})

test('after a turn closed, a later assistant message is not folded into the previous reply', () => {
  const messages = historyFromRecords([
    owner(1, '你是谁'),
    assist(2, '我是 Chief。'),
    end(3),
    assist(4, '（系统整理后的一句话）'),
  ])
  assert.deepEqual(messages.map(m => [m.role, m.content]), [['user', '你是谁'], ['assistant', '我是 Chief。']])
})

test('an interrupted turn keeps its resumed answer', () => {
  const records = [
    owner(1, '你是谁'),
    assist(2, '我先看一下'),
    { event: { seq: 3, time: 3, type: 'turn/end', data: { reason: { kind: 'interrupted' } } } },
    assist(4, '我是 Chief。'),
    end(5),
  ]
  assert.deepEqual(historyFromRecords(records).map(m => m.content), ['你是谁', '我是 Chief。'])
})

test('the Muse /api/chat/history route answers with the in-process transcript', async () => {
  const home = mkdtempSync(join(tmpdir(), 'odm-history-route-'))
  writeFileSync(join(home, 'config.json'), JSON.stringify({}))
  const configStore = createConfigStore(join(home, 'config.json'))
  await configStore.load()
  const state = { cards: [], completions: [] }
  const router = createApiRouter({ store: { get: () => state, save: async s => Object.assign(state, s), load: async () => state }, config: { home, dataDir: home }, configStore })

  const dshHome = dshHomeWith('session-chief')
  const registered = new Map()
  const ctx = {
    effect: dispose => { dispose(); return () => {} },
    sessionController: {
      async resolveAgent() { return { status: 'idle', session: { seq: pairRecords().length + 1 } } },
      async page() { return { records: pairRecords(), hasMore: false } },
    },
    connection: { fetch: { register: route => { registered.set(`${route.methods.join(',')} ${route.path}`, route); return () => {} } } },
  }
  assert.equal(registerMuseHostRoutes(ctx, { router, dshHome }), true)
  const route = registered.get('GET /api/chat/history')
  assert.ok(route, `GET /api/chat/history was not registered (saw: ${[...registered.keys()].join(', ')})`)
  const res = await route.fetch(new Request('http://odm.local/api/chat/history'))
  assert.equal(res.status, 200)
  const json = await res.json()
  assert.deepEqual(json.messages.map(m => [m.role, m.content]), [['user', '你是谁'], ['assistant', CHIEF], ['user', '在干嘛'], ['assistant', STANDBY]])
})

test('a restored bubble shows the user\'s picture, not the prompt\'s attachment note', () => {
  const display = { lookup: id => (id === 'rpc-pic' ? ATTACH_SHOWN : null) }
  const messages = historyFromRecords([picture(1, 'rpc-pic'), assist(2, '收到')], { display })
  assert.deepEqual(messages.map(m => [m.role, m.content]), [['user', ATTACH_TEXT], ['assistant', '收到']])
  assert.deepEqual(messages[0].attachments, ATTACH_SHOWN[0].attachments)
  assert.doesNotMatch(messages[0].content, /【附件】/)
})

test('a Session from before the display record still peels the attachment note off the words', () => {
  const messages = historyFromRecords([picture(1, 'rpc-old'), assist(2, '收到')])
  assert.deepEqual(messages.map(m => [m.role, m.content]), [['user', ''], ['assistant', '收到']])
  assert.deepEqual(messages[0].attachments.map(a => [a.kind, a.name]), [['image', 'a.png']])
  assert.ok(messages.every(m => !/【附件】/.test(m.content)))
})

test('a steered follow-up is the owner\'s sentence, not the lane note', () => {
  const messages = historyFromRecords([
    owner(1, `${VIEW}\n\n你是谁`),
    assist(2, CHIEF),
    end(3),
    steer(4, 'rpc-steer', '还要一句自我介绍'),
    assist(5, STANDBY),
    end(6),
  ])
  assert.deepEqual(messages.map(m => [m.role, m.content]), [
    ['user', '你是谁'],
    ['assistant', CHIEF],
    ['user', '还要一句自我介绍'],
    ['assistant', STANDBY],
  ])
  assert.ok(messages.every(m => !/补充一条/.test(m.content)))
})

test('the 【刚处理完】 runtime context never reaches a restored bubble', () => {
  const messages = historyFromRecords([
    owner(1, `${DONE}\n\n${VIEW}\n\n现在还有什么没做`),
    assist(2, '都做完了'),
  ])
  assert.deepEqual(messages.map(m => [m.role, m.content]), [['user', '现在还有什么没做'], ['assistant', '都做完了']])
  assert.ok(messages.every(m => !/【刚处理完】/.test(m.content)))
})

test('the Muse /api/chat/history route restores bubbles from the display record', async () => {
  const home = mkdtempSync(join(tmpdir(), 'odm-history-display-'))
  writeFileSync(join(home, 'config.json'), JSON.stringify({}))
  const configStore = createConfigStore(join(home, 'config.json'))
  await configStore.load()
  const state = { cards: [], completions: [] }
  const router = createApiRouter({ store: { get: () => state, save: async s => Object.assign(state, s), load: async () => state }, config: { home, dataDir: home }, configStore })
  router.chatDisplay().record('rpc-pic', ATTACH_SHOWN)

  const dshHome = dshHomeWith('session-chief')
  const records = [picture(1, 'rpc-pic'), assist(2, '收到')]
  const registered = new Map()
  const ctx = {
    effect: dispose => { dispose(); return () => {} },
    sessionController: {
      async resolveAgent() { return { status: 'idle', session: { seq: records.length + 1 } } },
      async page() { return { records, hasMore: false } },
    },
    connection: { fetch: { register: route => { registered.set(`${route.methods.join(',')} ${route.path}`, route); return () => {} } } },
  }
  assert.equal(registerMuseHostRoutes(ctx, { router, dshHome }), true)
  const route = registered.get('GET /api/chat/history')
  const res = await route.fetch(new Request('http://odm.local/api/chat/history'))
  assert.equal(res.status, 200)
  const json = await res.json()
  assert.deepEqual(json.messages.map(m => [m.role, m.content]), [['user', ATTACH_TEXT], ['assistant', '收到']])
  assert.deepEqual(json.messages[0].attachments, ATTACH_SHOWN[0].attachments)
})
