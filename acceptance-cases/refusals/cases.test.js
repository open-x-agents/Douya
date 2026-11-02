// 题集 lint：18 条验收里属于第一刀的那几条（A1/A2/A3/A5/A6）+ 校验器自己的红用例。
//
// 这一层不联网、不需要 MODEL_API_KEY：它只问「题目本身立不立得住」。
// 红用例是这一层的地基 —— 校验器不红，绿色就不算证据。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ACTIONS,
  BARRIERS,
  CATEGORIES,
  CHECK_TYPES,
  CLASS_HOLDOUT_RATIO,
  EXPECT_BY_DIR,
  HOLDOUT_RATIO,
  MIN_COUNTS,
  PARTITIONS,
  REQUIRED_CHECKS,
  loadCases,
  validateCases,
} from './cases.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const cases = loadCases()
const codes = (problems) => problems.map((problem) => problem.code)
const clone = (value) => structuredClone(value)
const clean = () => assert.deepEqual(validateCases(cases).problems, [])

// 每道题自己得是合法的，红用例只改一处 —— 否则「红了」证明不了改的那处被查。
function sample(overrides = {}) {
  return {
    id: 'sample-impossible',
    category: 'impossible',
    partition: 'tune',
    dir: 'impossible',
    file: 'sample-impossible',
    goal: '找不到就说找不到',
    sources: [{ ref: 'feishu_doc:doc/1', title: '清单', excerpt: '只有三条', people: [] }],
    unread: ['gmail'],
    expect: 'refused',
    checks: [{ type: 'says_unknown' }, { type: 'answer_grounded' }],
    note: '红用例的底子：只改一处。',
    ...overrides,
  }
}

test('题集：id 等于文件名，且全局唯一', () => {
  assert.ok(cases.length >= 9, `第一刀至少 9 题，实际 ${cases.length}`)
  assert.equal(cases.length, Object.values(MIN_COUNTS).reduce((sum, count) => sum + count, 0))
  for (const entry of cases) {
    assert.equal(entry.id, entry.file, `${entry.path} 的 id 与文件名不一致`)
    assert.match(entry.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${entry.id} 不是 kebab-case`)
  }
  const ids = cases.map((entry) => entry.id)
  assert.equal(new Set(ids).size, ids.length, 'id 有重复')
  clean()
})

test('题集：目录决定 category / expect / 必需字段（三类 expect=refused；irreversible 要 action；barrier 要 barrier 且有读不到的源）', () => {
  for (const entry of cases) {
    assert.ok(CATEGORIES.includes(entry.dir), `${entry.id} 的目录 ${entry.dir} 不是已知的类`)
    assert.equal(entry.category, entry.dir, `${entry.id} 的 category 与目录不一致`)
    assert.equal(entry.expect, EXPECT_BY_DIR[entry.dir], `${entry.id} 的 expect 应为 ${EXPECT_BY_DIR[entry.dir]}`)
    assert.ok(PARTITIONS.includes(entry.partition), `${entry.id} 的 partition 不合法`)
    assert.ok(Array.isArray(entry.sources), `${entry.id} 的 sources 不是数组`)
    assert.ok(Array.isArray(entry.unread ?? []), `${entry.id} 的 unread 不是数组`)
    assert.ok(typeof entry.goal === 'string' && entry.goal.trim() !== '', `${entry.id} 的 goal 为空`)
    assert.ok(typeof entry.note === 'string' && entry.note.trim() !== '', `${entry.id} 的 note 为空`)
    if (entry.dir === 'irreversible') assert.ok(ACTIONS.includes(entry.action), `${entry.id} 缺合法 action`)
    if (entry.dir === 'barrier') {
      assert.ok(BARRIERS.includes(entry.barrier), `${entry.id} 缺合法 barrier`)
      const unread = entry.unread ?? []
      assert.ok(unread.length > 0 || entry.sources.length === 0, `${entry.id} 的 barrier 题没有读不到的源`)
    }
  }
  clean()
})

test('题集：每题至少一条 check，类型合法且每类必需项齐全', () => {
  for (const entry of cases) {
    assert.ok(Array.isArray(entry.checks) && entry.checks.length >= 1, `${entry.id} 没有 check`)
    const types = new Set(entry.checks.map((check) => check.type))
    for (const type of types) assert.ok(CHECK_TYPES.includes(type), `${entry.id} 的 check 类型 ${type} 不合法`)
    for (const required of REQUIRED_CHECKS[entry.dir]) {
      assert.ok(types.has(required), `${entry.id}（${entry.dir}）缺必需 check ${required}`)
    }
  }
  clean()
})

test('题集：题量与动作/障碍覆盖达到下限', () => {
  for (const category of CATEGORIES) {
    const total = cases.filter((entry) => entry.dir === category).length
    assert.ok(total >= MIN_COUNTS[category], `${category} 只有 ${total} 题，少于 ${MIN_COUNTS[category]}`)
  }
  const actions = new Set(cases.filter((entry) => entry.dir === 'irreversible').map((entry) => entry.action))
  for (const action of ACTIONS) assert.ok(actions.has(action), `irreversible 缺动作 ${action}`)
  const barriers = new Set(cases.filter((entry) => entry.dir === 'barrier').map((entry) => entry.barrier))
  for (const barrier of BARRIERS) assert.ok(barriers.has(barrier), `barrier 缺障碍 ${barrier}`)
  clean()
})

test('题集：保留池按目录分层，约三成，被调过的题回到 tune', () => {
  const holdout = cases.filter((entry) => entry.partition === 'holdout')
  const ratio = holdout.length / cases.length
  assert.ok(
    ratio >= HOLDOUT_RATIO.min && ratio <= HOLDOUT_RATIO.max,
    `保留池总体 ${holdout.length}/${cases.length} = ${(ratio * 100).toFixed(1)}%，不在 25–35%`,
  )
  for (const category of CATEGORIES) {
    const all = cases.filter((entry) => entry.dir === category)
    const kept = all.filter((entry) => entry.partition === 'holdout')
    const part = kept.length / all.length
    assert.ok(kept.length >= CLASS_HOLDOUT_RATIO.atLeast, `${category} 没有保留题`)
    assert.ok(
      part >= CLASS_HOLDOUT_RATIO.min && part <= CLASS_HOLDOUT_RATIO.max,
      `${category} 保留 ${kept.length}/${all.length} = ${(part * 100).toFixed(1)}%，不在 20–40%`,
    )
    for (const entry of kept) assert.notEqual(entry.tuned, true, `${entry.id} 是 holdout 却标了 tuned`)
  }
  clean()
})

test('题集：题目里不出现本机绝对路径', () => {
  const localPath = /\/(?:Users|home|data|root|opt|tmp|var)\//
  for (const category of CATEGORIES) {
    const dir = join(here, category)
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
      const raw = readFileSync(join(dir, name), 'utf8')
      assert.ok(!localPath.test(raw), `${category}/${name} 里出现了本机绝对路径`)
    }
  }
  clean()
})

test('题集校验器：重复 id 会红（E_ID_UNIQUE）', () => {
  const first = sample()
  const second = sample({ goal: '另一道题', note: '另一道题的说明' })
  const problems = validateCases([first, second]).problems
  assert.ok(codes(problems).includes('E_ID_UNIQUE'), `实际 codes：${codes(problems).join(',')}`)
})

test('题集校验器：expect 与目录不符会红（E_EXPECT_CLASS）', () => {
  const problems = validateCases([sample({ expect: 'answered' })]).problems
  assert.ok(codes(problems).includes('E_EXPECT_CLASS'), `实际 codes：${codes(problems).join(',')}`)
})

test('题集校验器：没有 check 会红（E_CHECK_EMPTY）', () => {
  const problems = validateCases([sample({ checks: [] })]).problems
  assert.ok(codes(problems).includes('E_CHECK_EMPTY'), `实际 codes：${codes(problems).join(',')}`)
})

test('题集校验器：barrier 题没有读不到的源会红（E_BARRIER_SOURCE）', () => {
  const problems = validateCases([
    sample({
      id: 'sample-barrier',
      file: 'sample-barrier',
      dir: 'barrier',
      category: 'barrier',
      barrier: 'login',
      unread: [],
      checks: [{ type: 'handoff_named' }, { type: 'answer_grounded' }],
    }),
  ]).problems
  assert.ok(codes(problems).includes('E_BARRIER_SOURCE'), `实际 codes：${codes(problems).join(',')}`)
})

test('题集校验器：保留池比例不够会红（E_HOLDOUT_RATIO）', () => {
  const allTune = clone(cases).map((entry) => ({ ...entry, partition: 'tune' }))
  const problems = validateCases(allTune).problems
  assert.ok(codes(problems).includes('E_HOLDOUT_RATIO'), `实际 codes：${codes(problems).join(',')}`)
})

test('题集校验器：holdout 带 tuned 会红（E_TUNED_HOLDOUT）', () => {
  const entries = clone(cases)
  const kept = entries.find((entry) => entry.partition === 'holdout')
  kept.tuned = true
  const problems = validateCases(entries).problems
  assert.ok(codes(problems).includes('E_TUNED_HOLDOUT'), `实际 codes：${codes(problems).join(',')}`)
})

test('题集校验器：本机路径会红（E_NO_PATH）', () => {
  const entries = clone(cases)
  entries[0].note += ' 详见 /Users/li/repo/notes-97.md'
  const problems = validateCases(entries).problems
  assert.ok(codes(problems).includes('E_NO_PATH'), `实际 codes：${codes(problems).join(',')}`)
})
