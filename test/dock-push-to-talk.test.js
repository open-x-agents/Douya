// Dock push-to-talk: hold the mic, release to send. The state machine and its wiring live in
// src/client/index.html between marker comments, so this test can slice them out and run them with fakes
// (CI has no browser, no SpeechRecognition and no microphone).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { messages } from '../src/i18n/index.js'

const html = readFileSync(new URL('../src/client/index.html', import.meta.url), 'utf8')
const messagesSrc = readFileSync(new URL('../src/i18n/messages.js', import.meta.url), 'utf8')

const PURE_START = '// ---- push-to-talk (pure; test/dock-push-to-talk.test.js slices this block) ----'
const PURE_END = '// ---- end push-to-talk ----'
const WIRE_START = '// ---- push-to-talk wiring (test/dock-push-to-talk.test.js slices this block) ----'
const WIRE_END = '// ---- end push-to-talk wiring ----'

function block(start, end) {
  const from = html.indexOf(start)
  const to = html.indexOf(end)
  if (!(from > 0 && to > from)) throw new Error(`push-to-talk block not found: ${start}`)
  return html.slice(from + start.length, to)
}

// Both blocks must be at module top level and must not reference other module-level values: the test builds
// them into one function and injects `t`.
function loadPtt() {
  const src = block(PURE_START, PURE_END) + block(WIRE_START, WIRE_END)
  if (typeof src !== 'string' || !src.includes('function pttReduce')) throw new Error('push-to-talk block not found')
  return new Function('t', `${src}; return { pttIdle, pttCompose, pttReduce, wirePushToTalk }`)((key) => key)
}

function fakeMic() {
  const listeners = new Map()
  const attrs = new Map([['aria-label', 'Voice input']])
  const cls = new Set()
  const aria = []
  return {
    cls,
    setAria: aria,
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) },
    addEventListener(type, fn) { listeners.set(type, fn) },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type) },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null },
    setAttribute(k, v) { attrs.set(k, v); if (k === 'aria-label') aria.push(v) },
    removeAttribute(k) { attrs.delete(k) },
    setPointerCapture() {},
    has(type) { return listeners.has(type) },
    fire(type, ev = {}) { const fn = listeners.get(type); if (fn) return fn(ev) },
    label() { return attrs.get('aria-label') },
  }
}

function fakeSR() {
  const instances = []
  class SR {
    constructor() { this.started = false; this.stopped = 0; instances.push(this) }
    start() { this.started = true }
    stop() { this.stopped += 1 }
  }
  return { SR, instances }
}

function resultEvent(transcript, isFinal, resultIndex = 0) {
  const results = [{ 0: { transcript }, isFinal, length: 1 }]
  return { resultIndex, results }
}

function harness(overrides = {}) {
  const ptt = loadPtt()
  const mic = fakeMic()
  const input = { value: '' }
  const tips = []
  const sends = []
  const { SR, instances } = fakeSR()
  const timers = []
  const cleared = []
  const wiring = ptt.wirePushToTalk({
    mic,
    getInput: () => input,
    setTip: (s) => tips.push(s),
    SR,
    t: (key) => key,
    onVoiceSend: (text) => sends.push(text),
    state: ptt.pttIdle(),
    timeoutMs: 1500,
    setTimer: (fn) => { timers.push(fn); return fn },
    clearTimer: (id) => { cleared.push(id) },
    ...overrides,
  })
  return { ptt, mic, input, tips, sends, instances, timers, cleared, wiring }
}

// ---- pure state machine ----

test('ptt：按住时只记录，松开（end）后才发', () => {
  const { pttIdle, pttReduce } = loadPtt()
  const press = pttReduce(pttIdle(), { type: 'press' })
  assert.equal(press.state.phase, 'held')
  assert.equal(press.send, false)
  assert.equal(press.tip, 'holding')

  const interim = pttReduce(press.state, { type: 'interim', text: '你' })
  assert.equal(interim.send, false)
  assert.equal(interim.state.last, '你')
  assert.equal(interim.state.phase, 'held')

  const final = pttReduce(interim.state, { type: 'final', text: '你好' })
  assert.equal(final.send, false)
  assert.equal(final.state.phase, 'held')

  const release = pttReduce(final.state, { type: 'release' })
  assert.equal(release.send, false)
  assert.equal(release.tip, 'sending')
  assert.equal(release.state.phase, 'released')

  const end = pttReduce(release.state, { type: 'end' })
  assert.equal(end.send, true)
  assert.equal(end.text, '你好')
  assert.equal(end.state.phase, 'idle')
  assert.equal(end.tip, null)
})

test('ptt：一次按住至多一条 —— end 之后迟到的 final 不再发', () => {
  const { pttIdle, pttReduce } = loadPtt()
  let state = pttReduce(pttIdle(), { type: 'press' }).state
  assert.equal(pttReduce(state, { type: 'press' }).send, false, 'second press while held is ignored')
  assert.equal(pttReduce(state, { type: 'press' }).state.phase, 'held')

  state = pttReduce(state, { type: 'final', text: '一句话' }).state
  state = pttReduce(state, { type: 'release' }).state
  const end = pttReduce(state, { type: 'end' })
  assert.equal(end.send, true)
  assert.equal(end.text, '一句话')
  state = end.state

  assert.equal(pttReduce(state, { type: 'final', text: '迟到' }).send, false)
  assert.equal(pttReduce(state, { type: 'end' }).send, false)
  assert.equal(pttReduce(state, { type: 'timeout' }).send, false)
})

test('ptt：没有听到内容时不发、提示 empty', () => {
  const { pttIdle, pttReduce } = loadPtt()
  let state = pttReduce(pttIdle(), { type: 'press' }).state
  state = pttReduce(state, { type: 'release' }).state
  const end = pttReduce(state, { type: 'end' })
  assert.equal(end.send, false)
  assert.equal(end.tip, 'empty')
  assert.equal(end.state.phase, 'idle')
  assert.equal(end.text, '')
})

test('ptt：没按住时到达的 final / end 一律丢弃', () => {
  const { pttIdle, pttReduce } = loadPtt()
  const idle = pttIdle()
  for (const type of ['interim', 'final', 'end', 'timeout']) {
    const out = pttReduce(idle, { type, text: '噪声' })
    assert.equal(out.send, false, `${type} in idle must not send`)
    assert.equal(out.text, '')
    assert.equal(out.state.phase, 'idle')
  }
})

test('ptt：not-allowed 映射 blocked，其它 error 映射 failed，都不发', () => {
  const { pttIdle, pttReduce } = loadPtt()
  let state = pttReduce(pttIdle(), { type: 'press' }).state
  state = pttReduce(state, { type: 'final', text: '说到一半' }).state

  const denied = pttReduce(state, { type: 'error', error: 'not-allowed' })
  assert.equal(denied.send, false)
  assert.equal(denied.text, '')
  assert.equal(denied.tip, 'blocked')
  assert.equal(denied.state.phase, 'idle')

  const noSpeech = pttReduce(state, { type: 'error', error: 'no-speech' })
  assert.equal(noSpeech.tip, 'empty')
  assert.equal(noSpeech.send, false)

  for (const error of ['network', 'service-not-allowed', 'aborted', '']) {
    const out = pttReduce(state, { type: 'error', error })
    assert.equal(out.send, false, `${error || 'unknown'} must not send`)
    assert.equal(out.tip, 'failed')
    assert.equal(out.state.phase, 'idle')
  }
})

test('ptt：pttCompose 把草稿与转写合成一条消息', () => {
  const { pttCompose } = loadPtt()
  assert.equal(pttCompose('  写周报 ', ' 明天交 '), '写周报 明天交')
  assert.equal(pttCompose('', '明天交'), '明天交')
  assert.equal(pttCompose('写周报', ''), '写周报')
  assert.equal(pttCompose('   ', '  '), '')
  assert.equal(pttCompose(null, 'x'), 'x')
  assert.equal(pttCompose('x', null), 'x')
})

test('ptt：release 后超时等同于 end，只发一条', () => {
  const { pttIdle, pttReduce } = loadPtt()
  let state = pttReduce(pttIdle(), { type: 'press' }).state
  state = pttReduce(state, { type: 'final', text: '兜底发这句' }).state
  state = pttReduce(state, { type: 'release' }).state

  const timedOut = pttReduce(state, { type: 'timeout' })
  assert.equal(timedOut.send, true)
  assert.equal(timedOut.text, '兜底发这句')
  state = timedOut.state
  assert.equal(pttReduce(state, { type: 'end' }).send, false)
  assert.equal(pttReduce(state, { type: 'timeout' }).send, false)
})

// ---- wiring (fake mic / fake recogniser) ----

test('wiring：没有 SR 时只提示 unsupported，不建实例、不发消息', () => {
  const { mic, tips, sends, instances, input } = harness({ SR: undefined })
  mic.fire('pointerdown', { button: 0, pointerId: 1 })
  assert.deepEqual(instances, [])
  assert.deepEqual(sends, [])
  assert.equal(input.value, '')
  assert.equal(tips.at(-1), 'composer.voice_unsupported')
  assert.equal(mic.cls.has('rec'), false)
})

test('wiring：一次按压 pointerdown → pointerup → end，onVoiceSend 恰好一次', () => {
  const { mic, input, tips, sends, instances } = harness()
  input.value = '草稿'
  mic.fire('pointerdown', { button: 0, pointerId: 7 })
  assert.equal(instances.length, 1, 'exactly one recogniser per press')
  assert.equal(instances[0].started, true)
  mic.fire('pointerdown', { button: 0, pointerId: 8 })
  assert.equal(instances.length, 1, 'a second press while held opens no second recogniser')

  instances[0].onresult(resultEvent('你', false))
  assert.ok(tips.some((x) => x.startsWith('composer.voice_holding')), 'interim stays in the tip')
  assert.equal(input.value, '草稿', 'interim must not overwrite the draft')
  instances[0].onresult(resultEvent('你好', true))
  assert.equal(input.value, '草稿', 'final text waits for end, it is not written while held')

  mic.fire('pointerup', {})
  assert.equal(instances[0].stopped, 1, 'release stops the recogniser')
  assert.equal(sends.length, 0, 'nothing is sent before end')

  instances[0].onend()
  assert.deepEqual(sends, ['你好'])
  assert.equal(input.value, '草稿 你好', 'draft + transcript compose into the one message')
  assert.equal(mic.cls.has('rec'), false)
  assert.equal(mic.label(), 'Voice input', 'aria-label restored after the press')
})

test('wiring：页面加载与未按住时不建实例，噪声不触发发送', () => {
  const { mic, tips, sends, instances } = harness()
  assert.deepEqual(instances, [], 'no recogniser at page load')
  assert.deepEqual(tips, [], 'no tip at page load')
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture', 'keyup', 'blur']) mic.fire(type, {})
  assert.deepEqual(instances, [], 'no recogniser without a press')
  assert.deepEqual(sends, [], 'noise without a press never sends')
  assert.equal(mic.cls.has('rec'), false)
})

test('wiring：麦克风块里没有 openTodayChat、没有 fetch(\'/api/chat\'', () => {
  const micBlock = block(PURE_START, PURE_END) + block(WIRE_START, WIRE_END)
  assert.doesNotMatch(micBlock, /openTodayChat/)
  assert.doesNotMatch(micBlock, /fetch\(/)
  assert.doesNotMatch(micBlock, /\/api\/chat/)
  assert.doesNotMatch(micBlock, /sendChatResilient/)
  // One sending path: the definition plus the one call inside send().
  assert.equal((html.match(/sendChatResilient\(/g) || []).length, 2)
  // pttCompose is used exactly once (inside wirePushToTalk), so a draft is never composed twice.
  assert.equal((html.match(/pttCompose\(/g) || []).length, 2)
})

test('wiring：松手超时会兜底，end 再来不会发第二条', () => {
  const { mic, sends, instances, timers, wiring } = harness()
  mic.fire('pointerdown', { button: 0, pointerId: 2 })
  instances[0].onresult(resultEvent('超时也要发', true))
  mic.fire('pointerup', {})
  assert.equal(timers.length, 1)
  assert.equal(sends.length, 0)

  timers[0]()
  assert.deepEqual(sends, ['超时也要发'])
  instances[0].onend()
  assert.deepEqual(sends, ['超时也要发'], 'a late end after the timeout sends nothing')
  assert.equal(wiring.isHeld(), false)
})

test('wiring：用 pointerdown/pointerup/pointercancel/lostpointercapture/keyup/blur，不再有 mic.onclick', () => {
  const { mic, instances } = harness()
  for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture', 'keydown', 'keyup', 'blur']) {
    assert.equal(mic.has(type), true, `missing listener: ${type}`)
  }
  assert.doesNotMatch(html, /mic\.onclick/)

  const down = { key: ' ', preventDefault() { this.prevented = true } }
  mic.fire('keydown', down)
  assert.equal(down.prevented, true)
  assert.equal(instances.length, 1, 'Space while focused starts the hold')
  mic.fire('keyup', { key: ' ' })
  assert.equal(instances[0].stopped, 1)
})

test('wiring：按住加 rec 并运行期换 aria-label，松开还原', () => {
  const { mic, instances } = harness()
  assert.equal(mic.label(), 'Voice input', 'static markup value, untouched in the source')
  mic.fire('pointerdown', { button: 0, pointerId: 3 })
  assert.equal(mic.cls.has('rec'), true)
  assert.equal(mic.label(), 'composer.voice_holding')
  assert.deepEqual(mic.setAria, ['composer.voice_holding'])

  instances[0].onresult(resultEvent('好', true))
  mic.fire('pointerup', {})
  assert.equal(mic.cls.has('rec'), true, '.rec stays until the recogniser ends')

  mic.fire('lostpointercapture', {})
  assert.equal(mic.cls.has('rec'), true, 'a duplicate release is ignored while waiting for end')

  instances[0].onend()
  assert.equal(mic.cls.has('rec'), false)
  assert.equal(mic.label(), 'Voice input', 'aria-label is restored to the static markup value')
  assert.deepEqual(mic.setAria, ['composer.voice_holding', 'Voice input'])
})

// ---- i18n ----

test('i18n：6 个提示键 en/zh 都有，5 个死键已删', () => {
  const keys = [
    'composer.voice_holding',
    'composer.voice_sending',
    'composer.voice_empty',
    'composer.voice_blocked',
    'composer.voice_failed',
    'composer.voice_unsupported',
  ]
  for (const key of keys) {
    assert.ok(messages.en[key], `en is missing ${key}`)
    assert.ok(messages.zh[key], `zh is missing ${key}`)
  }
  for (const dead of ['chat.hint_listen', 'chat.mic_denied', 'chat.mic_nospeech', 'chat.mic_network', 'chat.mic_service']) {
    assert.equal(messages.en[dead], undefined, `dead key still in en: ${dead}`)
    assert.equal(messages.zh[dead], undefined, `dead key still in zh: ${dead}`)
  }
  assert.equal((messagesSrc.match(/composer\.voice_/g) || []).length, 12, 'six keys × en/zh')
  assert.equal((messagesSrc.match(/chat\.mic_|chat\.hint_listen/g) || []).length, 0, 'dead keys removed from the source')
})
