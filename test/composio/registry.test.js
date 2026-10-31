// 注册表的形状与只读判定。纯函数，不联网、不要 key。
//
// 这里钉死三件真实探测才会知道的事：
//   - 名字会撒谎两个方向，只读只能看 tag；
//   - 快照里没有的动作一律判写（fail-closed），不猜名字；
//   - 快照记的是「什么时候的事实」，`/tools` 撞 limit 时是截断（slack），不是总数。

import test from 'node:test'
import assert from 'node:assert/strict'
import { labelOf, registry } from '../../src/sources/composio/registry.js'
import { isReadOnly, isReadOnlyIn, SNAPSHOT } from '../../src/sources/composio/capabilities.js'

const REQUIRED = ['gmail', 'googlecalendar', 'notion', 'slack']

test('the registry has the four required rows with toolkit, adapter, actions and readScope', () => {
  const byToolkit = new Map(registry.map(row => [row.toolkit, row]))
  for (const toolkit of REQUIRED) {
    const row = byToolkit.get(toolkit)
    assert.ok(row, `注册表缺 ${toolkit}`)
    assert.equal(typeof row.label, 'string', `${toolkit} 没有 label`)
    assert.equal(typeof row.adapter, 'string', `${toolkit} 没有 adapter`)
    assert.ok(row.adapter.length > 0, `${toolkit} 的 adapter 是空的`)
    assert.ok(Array.isArray(row.actions) && row.actions.length > 0, `${toolkit} 没有 actions`)
    assert.equal(row.readScope, 'metadata', `${toolkit} 的 readScope 不是 metadata`)
  }
  // 不锁死总行数：S6 加第 5 个 app 时这张表不用改。
  assert.ok(registry.length >= REQUIRED.length)
})

test('every action in the registry carries readOnlyHint in the capability snapshot', () => {
  for (const row of registry) {
    for (const action of row.actions) {
      assert.equal(isReadOnly(row.toolkit, action), true, `${row.toolkit} 的 ${action} 不在快照的 read_only 里`)
    }
  }
})

test('a name that looks like a read is still a write, and a name that looks like a write can be a read', () => {
  // 名字带 _LIST，tags 里没有 readOnlyHint：真写。
  assert.equal(isReadOnly('googlecalendar', 'GOOGLECALENDAR_CALENDAR_LIST_INSERT'), false)
  assert.ok(SNAPSHOT.toolkits.googlecalendar.not_read_only.includes('GOOGLECALENDAR_CALENDAR_LIST_INSERT'))
  // 名字带 CREATE，tags 里有 readOnlyHint，description 是 Fetches …：真读。
  assert.equal(isReadOnly('linear', 'LINEAR_CREATE_LINEAR_ISSUE_DETAILS'), true)
})

test('an action the snapshot does not know is refused, not guessed', () => {
  assert.equal(isReadOnly('gmail', 'GMAIL_FETCH_EMAILS_V2'), false)
  assert.equal(isReadOnly('myspace', 'GMAIL_FETCH_EMAILS'), false)
  // 换一份空快照也是 false：判定不依赖同名动作在别的 toolkit 里是否存在。
  assert.equal(isReadOnlyIn({ toolkits: {} }, 'gmail', 'GMAIL_FETCH_EMAILS'), false)
  assert.equal(isReadOnlyIn(null, 'gmail', 'GMAIL_FETCH_EMAILS'), false)
})

test('the snapshot records when it was taken and marks a capped tool list', () => {
  assert.equal(new Date(SNAPSHOT.at).toISOString(), SNAPSHOT.at)
  assert.equal(SNAPSHOT.toolkits.slack.capped, true)
  assert.equal(SNAPSHOT.toolkits.slack.visible, 100)
  assert.equal(SNAPSHOT.toolkits.gmail.capped, false)
  // tools_count 是 toolkit 版本总数，不许当「可用动作数」写进快照。
  assert.equal('tools_count' in SNAPSHOT.toolkits.gmail, false)
})

test('a label comes from the registry row, so adding an app never touches the panel', () => {
  assert.equal(labelOf('composio:notion'), 'Notion')
  assert.equal(labelOf('notion'), 'Notion')
  assert.equal(labelOf('composio:googlecalendar'), '谷歌日历')
  assert.equal(labelOf('composio:unknown_app'), null)
  assert.equal(labelOf(undefined), null)
})
