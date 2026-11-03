import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendMemoryEntries, chatWithBot, loadHistory, loadMemory, saveHistory, saveMemory } from '../src/web/bot-chat.js'
import { resolveDisplayName } from '../src/web/aggregation.js'
import { displayNameOf } from '../src/web/identity.js'

test('memory and history survive a save/load round-trip', async () => {
  const home = await mkdtemp(join(tmpdir(), 'odm-bot-'))
  try {
    await saveMemory(home, appendMemoryEntries('# Memory\n\n', ['用户喜欢简短回复']))
    await saveHistory(home, [
      { role: 'user', content: '你好', at: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', content: '你好！', at: '2026-01-01T00:00:01.000Z' },
    ])
    const mem = await loadMemory(home)
    const hist = await loadHistory(home)
    assert.match(mem, /用户喜欢简短回复/)
    assert.equal(hist.length, 2)
    assert.equal(hist[0].content, '你好')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('你好 talks to the bot with memory and does not invent citations', async () => {
  const home = await mkdtemp(join(tmpdir(), 'odm-bot-'))
  try {
    await saveMemory(home, '# Memory\n\n- 用户希望被称作同事\n')
    const llm = {
      async *stream() {
        yield { type: 'text', text: JSON.stringify({ text: '你好，同事！我是豆芽。', remember: [] }) }
      },
    }
    const r = await chatWithBot({ message: '你好', home, llm, cards: [] })
    assert.equal(r.status, 'answered')
    assert.match(r.text, /豆芽|同事/)
    assert.equal(r.citations.length, 0)
    const hist = await loadHistory(home)
    assert.equal(hist.length, 2)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a follow-up turn sees the prior user message in the prompt', async () => {
  const home = await mkdtemp(join(tmpdir(), 'odm-bot-'))
  try {
    let sawPrior = false
    const llm = {
      async *stream({ messages }) {
        const blob = messages.map(m => m.content).join('\n')
        if (blob.includes('我叫小明')) sawPrior = true
        yield { type: 'text', text: JSON.stringify({ text: sawPrior ? '记得，你叫小明。' : '不记得', remember: sawPrior ? ['用户叫小明'] : [] }) }
      },
    }
    await chatWithBot({ message: '我叫小明', home, llm, cards: [] })
    const r = await chatWithBot({ message: '我叫什么？', home, llm, cards: [] })
    assert.equal(sawPrior, true)
    assert.match(r.text, /小明/)
    const mem = await loadMemory(home)
    assert.match(mem, /小明/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('greeting name ignores profile leftovers and prefers human name over login', () => {
  assert.equal(resolveDisplayName('Danyang', { login: 'Birfy', name: 'Danyang Chen' }), 'Danyang Chen')
  assert.equal(resolveDisplayName('Danyang', { login: 'Birfy', name: '' }), 'Birfy')
  assert.equal(resolveDisplayName('Danyang', null), '')
  assert.equal(displayNameOf({ login: 'Birfy', name: 'Danyang Chen' }), 'Danyang Chen')
})
