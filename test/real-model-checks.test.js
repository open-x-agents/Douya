// 这道闸自己的测：不联网、不花钱、不需要 key。
//
// 每个用例对应 #24 的一条验收（A5–A10 与契约词汇/长度），喂的都是真模型的桩输出形状。
// 判定住 `test/e2e/real-model-checks.mjs`，所以「判定会不会红」第一次能在这里被证明，
// 而不是靠人肉跑一次带 key 的 e2e（docs/testing.md:31-32 的要求）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { judgePanel, parseModelJson, REF_MEMBERSHIP_ENFORCED } from './e2e/real-model-checks.mjs'

// 与 `test/e2e/real-model.e2e.mjs` 的夹具同词汇、同 ref（面板词汇 `<source>:<id>`）。
const COMPLETE = {
  sources: [
    {
      ref: 'feishu_cal:event/evt-77',
      source: 'feishu_cal',
      title: '评审会',
      excerpt: '14:00 开始，4 人',
      at: '2026-10-30T06:00:00Z',
    },
    {
      ref: 'github:pr/42',
      source: 'github',
      title: 'PR #42 在合并队列里等了 40 分钟',
      excerpt: '',
      at: '2026-10-30T05:20:00Z',
    },
    {
      ref: 'gmail:thread/9a1',
      source: 'gmail',
      title: '供应商报价 v3',
      excerpt: '（只读主题与收发关系，未读正文）',
      at: '2026-10-30T01:10:00Z',
    },
  ],
  unreadable: [],
}

const MISSING_MAIL = { sources: COMPLETE.sources.slice(0, 2), unreadable: ['gmail'] }

const codes = (problems) => problems.map((problem) => problem.code)
const find = (problems, code) => problems.find((problem) => problem.code === code)

test('parseModelJson：输出里没有 JSON 时抛 E_NO_JSON', () => {
  assert.throws(
    () => parseModelJson('抱歉，我读不到今天的信源。'),
    (error) => error.code === 'E_NO_JSON' && /输出里没有 JSON/.test(error.message),
  )
  // 围栏和前后废话都允许，规则只看第一个 { 到最后一个 }
  assert.deepEqual(parseModelJson('好的：\n```json\n{"headline":"一句话"}\n```'), { headline: '一句话' })
})

test('judgePanel：输出缺 facts 时返回 E_SHAPE，不抛 TypeError', () => {
  const panel = { headline: '今天两件事', advice: '先看评审' }
  let result
  assert.doesNotThrow(() => {
    result = judgePanel({ panel, fixture: COMPLETE, label: '正向' })
  })
  assert.deepEqual(codes(result.problems), ['E_SHAPE'])
  assert.equal(result.problems[0].message, '输出是 JSON 且有 facts/headline/advice')
  assert.match(result.problems[0].detail, /facts 不是数组/)
})

test('judgePanel：编一个不存在的 ref 就红', () => {
  assert.equal(REF_MEMBERSHIP_ENFORCED, true, 'A11 的开关必须默认为 true')
  const panel = {
    headline: '今天两件事',
    advice: '先看评审',
    facts: [{ text: '评审会 14:00 开始', evidence_ref: 'feishu_cal:event/999' }],
    unread_sources: [],
  }
  const problems = judgePanel({ panel, fixture: COMPLETE, label: '负向' }).problems
  const problem = find(problems, 'E_FACT_REF')
  assert.ok(problem, `应当报 E_FACT_REF，实际：${codes(problems).join(', ') || '（无）'}`)
  assert.match(problem.detail, /feishu_cal:event\/999/)
})

test('judgePanel：数字编在真 ref 名下也红（12.8万 不在 github:pr/42 里）', () => {
  const panel = {
    headline: '今天两件事',
    advice: '先看评审',
    facts: [{ text: '报价 12.8 万已发出', evidence_ref: 'github:pr/42' }],
    unread_sources: [],
  }
  const problems = judgePanel({ panel, fixture: COMPLETE, label: '负向' }).problems
  const problem = find(problems, 'E_INVENTED_ANCHOR')
  assert.ok(problem, `应当报 E_INVENTED_ANCHOR，实际：${codes(problems).join(', ') || '（无）'}`)
  assert.match(problem.detail, /12\.8万 不在 github:pr\/42 的原文里/)
})

test('judgePanel：缺源时必须在 unread_sources 点名，且不得引用该源', () => {
  const honest = {
    headline: '今天两件事',
    advice: '先看评审',
    facts: [
      { text: '评审会 14:00 开始', evidence_ref: 'feishu_cal:event/evt-77' },
      { text: 'PR #42 在合并队列里等了 40 分钟', evidence_ref: 'github:pr/42' },
    ],
    unread_sources: [],
  }
  const silent = judgePanel({ panel: honest, fixture: MISSING_MAIL, label: '负向' }).problems
  assert.ok(find(silent, 'E_UNREAD_MISSING'), `应当报 E_UNREAD_MISSING，实际：${codes(silent).join(', ') || '（无）'}`)

  const named = judgePanel({
    panel: { ...honest, unread_sources: ['gmail'] },
    fixture: MISSING_MAIL,
    label: '负向',
  }).problems
  assert.deepEqual(codes(named), [], `点名之后就应当没有 problem，实际：${codes(named).join(', ')}`)

  const claimed = judgePanel({
    panel: {
      ...honest,
      facts: [...honest.facts, { text: '供应商报价 12.8 万', evidence_ref: 'gmail:thread/9a1' }],
      unread_sources: ['gmail'],
    },
    fixture: MISSING_MAIL,
    label: '负向',
  }).problems
  assert.ok(
    find(claimed, 'E_UNREAD_SOURCE_CLAIMED'),
    `引用读不到的信源应当红，实际：${codes(claimed).join(', ') || '（无）'}`,
  )
})

test('judgePanel：正向至少用到 2 条不同信源（阈值不变）', () => {
  const one = {
    headline: '今天两件事',
    advice: '先看评审',
    facts: [{ text: '评审会 14:00 开始', evidence_ref: 'feishu_cal:event/evt-77' }],
    unread_sources: [],
  }
  assert.ok(
    find(judgePanel({ panel: one, fixture: COMPLETE, label: '正向' }).problems, 'E_COVERAGE'),
    '只引用 1 条来源应当报 E_COVERAGE',
  )

  const two = {
    ...one,
    facts: [
      ...one.facts,
      { text: 'PR #42 在合并队列里等了 40 分钟', evidence_ref: 'github:pr/42' },
    ],
  }
  assert.deepEqual(
    codes(judgePanel({ panel: two, fixture: COMPLETE, label: '正向' }).problems),
    [],
    '2 条不同来源不该再报 E_COVERAGE',
  )
})

test('judgePanel：cal:evt-77 这种非面板词汇的 ref 直接红', () => {
  const fixture = {
    sources: [{ ref: 'cal:evt-77', source: 'cal', title: '评审会', excerpt: '' }],
    unreadable: [],
  }
  const panel = {
    headline: '今天两件事',
    advice: '先看评审',
    facts: [{ text: '评审会', evidence_ref: 'cal:evt-77' }],
    unread_sources: [],
  }
  const problems = judgePanel({ panel, fixture, label: '负向' }).problems
  const problem = find(problems, 'E_SOURCE_VOCAB')
  assert.ok(problem, `应当报 E_SOURCE_VOCAB，实际：${codes(problems).join(', ') || '（无）'}`)
  assert.match(problem.detail, /cal:evt-77/)
})

test('judgePanel：结论超过 40 字、建议超过 20 字各自红', () => {
  const panel = {
    headline: '字'.repeat(41),
    advice: '建'.repeat(21),
    facts: [{ text: '评审会 14:00 开始', evidence_ref: 'feishu_cal:event/evt-77' }],
    unread_sources: [],
  }
  const problems = judgePanel({ panel, fixture: COMPLETE, label: '负向' }).problems
  assert.deepEqual(codes(problems), ['E_HEADLINE_LEN', 'E_ADVICE_LEN'])
})
