// 加第 5 个 app（#32 S6 / 验收 A11）：googledrive 只靠「注册表一行 + 一个适配器 + 一份契约测试」
// 就从数据走到事件与面板，**report / cards / 面板一行都不用改**。
//
// 这里走的是产品自己的路径：注册表里那一行的 `adapter` 路径动态 import 出 `create()`，
// `buildBrief()` 用默认加载器把它接上；观察再进 `normalizeEvents()` 变成事件，最后由面板渲染。
// 第二条用例把「面板不认具体 app 名」钉成静态断言 —— 以后谁为了一个 app 去改 `src/host/**`，
// 这条会先红。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeEvents } from '../../src/host/normalize.js'
import { panelData, renderSections } from '../../src/host/panel.js'
import { buildBrief } from '../../src/sources/composio/brief.js'
import { READ_MEMBERS } from '../../src/sources/composio/adapter.js'
import { labelOf, registry } from '../../src/sources/composio/registry.js'

const ZONE = 'Asia/Shanghai'
const SINCE = '2025-10-30T00:00:00.000Z'
const NOW = '2025-11-01T09:00:00.000Z'

const FILE = {
  id: 'f1',
  name: '季度计划.docx',
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  modifiedTime: '2025-10-31T07:30:00.000Z',
  owners: [{ displayName: '李娜', emailAddress: 'lina@example.com' }],
}

const ACCOUNT = { state: 'ok', reason: null, account_id: 'ca-drive-1' }

const driveTransport = {
  async proxyGet({ endpoint }) {
    if (/^\/drive\/v3\/files\?/.test(endpoint)) return { files: [FILE], nextPageToken: null }
    if (/^\/drive\/v3\/files\/f1\?/.test(endpoint)) return structuredClone(FILE)
    throw new Error(`E_TEST_ROUTE: ${endpoint}`)
  },
}

const accountFor = toolkit => (toolkit === 'googledrive' ? ACCOUNT : { state: 'missing', reason: 'no-account', account_id: null })

function googledriveRow() {
  const row = registry.find(item => item.toolkit === 'googledrive')
  assert.ok(row, '注册表里没有 googledrive 那一行')
  return row
}

function dayOf(events) {
  return {
    days: {
      '2025-10-31': {
        day: '2025-10-31',
        time_zone: ZONE,
        conclusion: '今天有一份计划要看。',
        meeting_hours: 0,
        events,
      },
    },
  }
}

test('a fifth app goes from one registry row to events without touching the report, the cards or the panel', async () => {
  assert.equal(registry.length, 5, '五个 app 各一行')
  const row = googledriveRow()
  assert.equal(row.toolkit, 'googledrive')
  assert.equal(row.adapter, './googledrive.js')
  assert.equal(row.readScope, 'metadata')
  assert.equal(row.actions.length, 4)
  assert.equal(labelOf('composio:googledrive'), row.label)

  // 注册表那一行指到适配器文件：动态 import 它，拿到五个只读成员。
  const adapterUrl = new URL(`../../src/sources/composio/${row.adapter.replace(/^\.\//, '')}`, import.meta.url)
  const module = await import(adapterUrl.href)
  assert.equal(typeof module.create, 'function', `${row.adapter} 没有导出 create()`)
  const adapter = module.create({ account: ACCOUNT, transport: driveTransport })
  for (const member of READ_MEMBERS) assert.ok(member in adapter, `适配器缺成员 ${member}`)
  assert.equal(adapter.id, 'composio:googledrive')

  // 一行注册表 → brief 的一条 fact（默认加载器按 row.adapter 认文件，测试不替它接线）。
  const brief = await buildBrief({
    registry: [row],
    accountFor,
    transport: driveTransport,
    since: SINCE,
    now: () => new Date(NOW),
  })
  assert.equal(brief.complete, true)
  assert.equal(brief.sources['composio:googledrive'].ok, true)
  assert.equal(brief.facts.length, 1)
  assert.equal(brief.facts[0].evidence_ref, 'composio:googledrive:file/f1')
  assert.match(brief.facts[0].text, /谷歌云盘/)
  assert.match(brief.facts[0].text, /季度计划/)

  // 同一条观察进事件层：source / ref 原样保留，面板不用改就能画。
  const listed = await adapter.list(SINCE)
  assert.equal(listed.observations.length, 1)
  const events = normalizeEvents(listed.observations)
  assert.equal(events.length, 1)
  assert.equal(events[0].title, '季度计划.docx')
  assert.equal(events[0].sources.length, 1)
  assert.equal(events[0].sources[0].source, 'composio:googledrive')
  assert.equal(events[0].sources[0].ref, 'composio:googledrive:file/f1')

  const data = panelData(dayOf(events), {
    today: '2025-10-31',
    timeZone: ZONE,
    sources: { 'composio:googledrive': { connected: true } },
  })
  assert.equal(data.events.length, 1)
  const html = renderSections(data)
  assert.match(html, /季度计划\.docx/)
  assert.match(html, /谷歌云盘/, '面板的源标签来自注册表那一行')
  assert.match(html, /已读：谷歌云盘/)
})

test('the fifth row is the only code change an app needs, and the panel still has no app names', () => {
  const hostDir = fileURLToPath(new URL('../../src/host/', import.meta.url))
  const appNames = /notion|slack|googlecalendar|googledrive/i

  for (const file of fs.readdirSync(hostDir).filter(name => name.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(hostDir, file), 'utf8')
    assert.doesNotMatch(text, appNames, `src/host/${file} 里出现了具体 app 名`)
  }
  for (const file of ['report.js', 'cards.js']) {
    assert.equal(
      fs.readFileSync(path.join(hostDir, file), 'utf8').includes('composio'),
      false,
      `src/host/${file} 不该认识 composio`,
    )
  }

  // 注册表里每个 app 恰好一行，adapter 都指向 src/sources/composio/<app>.js。
  const toolkits = registry.map(row => row.toolkit)
  assert.equal(new Set(toolkits).size, toolkits.length, '注册表里有重复的 app')
  assert.equal(toolkits.length, 5)
  for (const toolkit of toolkits) {
    const row = registry.find(item => item.toolkit === toolkit)
    assert.equal(row.adapter, `./${toolkit}.js`, `${toolkit} 的 adapter 不是 ./${toolkit}.js`)
  }
})
