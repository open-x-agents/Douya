// The private stop sits on the composer dock only while that private chat is running.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  stdin: {
    contents: [
      "export { privateStopShown, PrivateStopDock } from './src/client/private-stop.js'",
      "export { teamActions } from './src/client/team-actions.js'",
    ].join('\n'),
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
}
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports,
  require: (name) => {
    assert.equal(name, 'react')
    return react
  },
})
const { privateStopShown, PrivateStopDock, teamActions } = module.exports

const hook = value => select => select(value)
const bot = { id: 'a', name: 'Chief', sessionId: 'a-now' }
const room = { id: 'r1', name: 'Ops' }

function buttonOf(node) {
  if (node == null || typeof node !== 'object') return null
  if (node.type === 'button') return node
  for (const child of node.children ?? []) {
    const found = buttonOf(child)
    if (found) return found
  }
  return null
}

function dock({ sessionId = 'a-now', roster, running = true, actions } = {}) {
  return PrivateStopDock({
    sessionId,
    useRoster: hook(roster ?? { byId: { 'a-now': bot }, roomsById: {} }),
    useSessionStatus: hook(new Map([[sessionId, { running }]])),
    actions: actions ?? { stopPrivate() {}, stopRoomWork() {} },
  })
}

test('the stop control shows only for a running private chat', () => {
  assert.equal(privateStopShown({ room: undefined, bot, running: true }), true)
  assert.equal(privateStopShown({ room: null, bot, running: true }), true)
  assert.equal(privateStopShown({ room, bot, running: true }), false)
  assert.equal(privateStopShown({ room: undefined, bot, running: false }), false)
  assert.equal(privateStopShown({ room: undefined, bot: undefined, running: true }), false)
  const shown = buttonOf(dock())
  assert.equal(shown.props.type, 'button')
  assert.equal(shown.props['data-private-stop'], '')
  assert.equal(shown.children[0], 'Stop')
  assert.equal(buttonOf(dock({ running: false })), null)
  assert.equal(dock({
    sessionId: 'r1',
    running: true,
    roster: { byId: { r1: bot }, roomsById: { r1: room } },
  }), null)
})

test('stopPrivate posts stop-private for the current part', async () => {
  const calls = []
  const actions = teamActions({
    call: async (endpoint, payload) => { calls.push([endpoint, payload]); return true },
    after: promise => promise,
    partFor: id => (id === 'a' || id === 'a-old' ? 'a-now' : id),
    roster: { getSnapshot: () => ({ roomsById: {} }) },
    ui: { set() {}, getSnapshot: () => ({}) },
  })
  assert.equal(await actions.stopPrivate('a-old'), true)
  assert.equal(JSON.stringify(calls), JSON.stringify([['stop-private', { sessionId: 'a-now' }]]))
})

test('the stop control cancels this private chat and does not stop a room', () => {
  const calls = []
  const actions = {
    stopPrivate: (id) => { calls.push(['private', id]); return Promise.resolve(true) },
    stopRoomWork: (id) => { calls.push(['room', id]); return Promise.resolve(true) },
  }
  buttonOf(dock({ actions })).props.onClick()
  assert.deepEqual(calls, [['private', 'a-now']])
})
