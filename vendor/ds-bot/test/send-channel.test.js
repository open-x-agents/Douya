import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// Channel `send` must pass queue|steer through to sessionController.prompt, and
// default to steer while the Session's turn is running.
function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-send-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotId: 'm1',
    mainBotIds: ['m1'],
    revision: 1,
    bots: {
      m1: {
        id: 'm1', name: 'Chief', role: 'Chief', instructions: '', createdAt: 1,
        sessionId: 'chat-m1',
      },
    },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
  }))
  const prompts = []
  const ctx = fakeContext()
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-v4-flash' }],
      resolveModelInfo: async () => ({}),
    },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async () => ({ id: 'w1', path: home }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s-${randomUUID()}` }),
      resolveAgent: async sessionId => ({
        agent: {
          session: { id: sessionId },
          status: 'idle',
          followup() {},
          steer() {},
          cancel() {},
        },
      }),
      selectModel: async () => {},
      prompt: async (request) => {
        prompts.push(request)
        return { accepted: true }
      },
      page: async () => ({ events: [] }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  apply(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', {
      method: 'POST',
      body: JSON.stringify({ endpoint, payload }),
    }))
    return response.json()
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { call, prompts, ctx, stop, home }
}

test('send defaults to queue when the Session is idle', async (t) => {
  const { call, prompts, stop } = start()
  t.after(stop)
  const state = (await call('state', {})).value
  const sessionId = state.bots.find(bot => bot.id === 'm1').sessionId
  assert.equal((await call('send', { sessionId, text: 'hello idle' })).ok, true)
  assert.equal(prompts.at(-1).mode, 'queue')
  assert.equal(prompts.at(-1).sessionId, sessionId)
})

test('send defaults to steer while a turn is running', async (t) => {
  const { call, prompts, stop, ctx } = start()
  t.after(stop)
  const state = (await call('state', {})).value
  const sessionId = state.bots.find(bot => bot.id === 'm1').sessionId
  // Mark the Session live the way turns.js does for a running turn.
  for (const listener of ctx.listeners.get('session/event') ?? []) {
    await listener({ id: sessionId }, { type: 'turn/start', data: { turn: 1 }, time: Date.now() })
  }
  assert.equal((await call('send', { sessionId, text: 'steer please' })).ok, true)
  assert.equal(prompts.at(-1).mode, 'steer')
})

test('explicit queue wins even while running', async (t) => {
  const { call, prompts, stop, ctx } = start()
  t.after(stop)
  const state = (await call('state', {})).value
  const sessionId = state.bots.find(bot => bot.id === 'm1').sessionId
  for (const listener of ctx.listeners.get('session/event') ?? []) {
    await listener({ id: sessionId }, { type: 'turn/start', data: { turn: 1 }, time: Date.now() })
  }
  assert.equal((await call('send', { sessionId, text: 'stay queued', mode: 'queue' })).ok, true)
  assert.equal(prompts.at(-1).mode, 'queue')
})

test('explicit steer wins when idle', async (t) => {
  const { call, prompts, stop } = start()
  t.after(stop)
  const state = (await call('state', {})).value
  const sessionId = state.bots.find(bot => bot.id === 'm1').sessionId
  assert.equal((await call('send', { sessionId, text: 'force steer', mode: 'steer' })).ok, true)
  assert.equal(prompts.at(-1).mode, 'steer')
})
