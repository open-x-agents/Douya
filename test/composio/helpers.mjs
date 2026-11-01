// 多源 fixture 的读取与回放（#32 S4 的测试与 CLI 共用同一份数据形状）。
//
// fixture = `test/fixtures/composio/multi/<scenario>/`：
//   - `scenario.json`：`userId` / `since` / `now` / `config` / `accounts[]` / `appsDir`
//   - `apps/<toolkit>.json`：`{ toolkit, routes: [{ kind: 'proxyGet'|'executeTool', pattern, body }] }`
//
// `pattern` 是正则，按文件里的顺序匹配；具体的路由放前面。这样离线重放不需要起服务器，
// 也不会把「哪个端点被调过」这件事藏起来 —— 每条断言都能直接看 endpoint / 动作名。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveAccount } from '../../src/sources/composio/accounts.js'
import { buildBrief } from '../../src/sources/composio/brief.js'
import { registry } from '../../src/sources/composio/registry.js'

export const MULTI_ROOT = fileURLToPath(new URL('../fixtures/composio/multi/', import.meta.url))

export const SCENARIOS = ['all-ok', 'drop-gmail', 'drop-googlecalendar', 'drop-notion', 'drop-slack', 'same-page']

export function scenarioDir(name) {
  return path.join(MULTI_ROOT, name)
}

function loadApps(appsDir) {
  if (!fs.existsSync(appsDir)) return {}
  const apps = {}
  for (const file of fs.readdirSync(appsDir)) {
    if (!file.endsWith('.json')) continue
    const fixture = JSON.parse(fs.readFileSync(path.join(appsDir, file), 'utf8'))
    const toolkit = fixture.toolkit ?? file.replace(/\.json$/, '')
    apps[toolkit] = (Array.isArray(fixture.routes) ? fixture.routes : []).map(route => ({
      kind: route.kind ?? 'proxyGet',
      pattern: new RegExp(route.pattern),
      body: route.body,
    }))
  }
  return apps
}

export function loadScenario(name) {
  const dir = scenarioDir(name)
  const scenario = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'))
  const appsDir = path.resolve(dir, scenario.appsDir ?? 'apps')
  return { name, dir, scenario, apps: loadApps(appsDir) }
}

export function accountsOf(scenario) {
  return Array.isArray(scenario.accounts) ? scenario.accounts : []
}

export function accountForOf(accounts, userId) {
  return toolkit => resolveAccount(accounts, { toolkit, userId })
}

export function accountToolkitOf(accounts) {
  const map = new Map()
  for (const account of accounts) {
    const toolkit = account?.toolkit?.slug ?? account?.toolkit ?? account?.toolkit_slug
    if (account?.id && toolkit) map.set(String(account.id), String(toolkit))
  }
  return map
}

// 回放 transport：记录每一次调用（`calls`），路由按 fixture 顺序匹配。
export function fixtureTransport({ apps, accountToolkit, calls = [] } = {}) {
  function routeFor(toolkit, kind, target) {
    const routes = apps[toolkit] ?? []
    const found = routes.find(route => route.kind === kind && route.pattern.test(target))
    if (!found) {
      const error = new Error(`E_FIXTURE_ROUTE: ${String(toolkit)} 没有 ${kind} ${target} 的回放`)
      error.code = 'E_FIXTURE_ROUTE'
      throw error
    }
    return structuredClone(found.body)
  }

  return {
    calls,
    async proxyGet({ connectedAccountId, endpoint }) {
      const toolkit = accountToolkit.get(connectedAccountId)
      calls.push({ kind: 'proxyGet', toolkit, endpoint })
      return routeFor(toolkit, 'proxyGet', endpoint)
    },
    async executeTool({ toolSlug, connectedAccountId, arguments: args }) {
      const toolkit = accountToolkit.get(connectedAccountId)
      calls.push({ kind: 'executeTool', toolkit, toolSlug, arguments: args })
      return routeFor(toolkit, 'executeTool', toolSlug)
    },
  }
}

export function transportFor(loaded, calls = []) {
  return fixtureTransport({
    apps: loaded.apps,
    accountToolkit: accountToolkitOf(accountsOf(loaded.scenario)),
    calls,
  })
}

// 一份 fixture 里**输入真的有的** ref —— 从回放 body 推出来，不经过适配器，
// 免得「facts 指到 ref」这条断言拿适配器的输出给自己作证。
export function fixtureRefs({ apps }) {
  const refs = new Set()

  for (const route of apps.gmail ?? []) {
    if (route.kind !== 'proxyGet' || !String(route.pattern).includes('format=metadata')) continue
    if (route.body?.id) refs.add(`composio:gmail:thread/${route.body.id}`)
  }

  for (const route of apps.googlecalendar ?? []) {
    for (const item of Array.isArray(route.body?.items) ? route.body.items : []) {
      if (item?.id) refs.add(`composio:googlecalendar:event/${item.id}`)
    }
  }

  for (const route of apps.notion ?? []) {
    for (const block of Array.isArray(route.body?.results) ? route.body.results : []) {
      if (block?.id) refs.add(`composio:notion:page/${block.id}`)
    }
  }

  const channels = []
  for (const route of apps.slack ?? []) {
    for (const channel of Array.isArray(route.body?.data?.channels) ? route.body.data.channels : []) {
      channels.push(channel)
    }
  }
  for (const route of apps.slack ?? []) {
    if (route.kind !== 'executeTool' || !String(route.pattern).includes('HISTORY')) continue
    const messages = Array.isArray(route.body?.data?.messages) ? route.body.data.messages : []
    for (const message of messages) {
      if (message?.ts) refs.add(`composio:slack:message/${channels[0]?.id ?? 'C0GENERAL'}/${message.ts}`)
    }
  }

  return refs
}

// 用一份 fixture 跑一次 brief。`build` 覆盖 buildBrief 的入参（测试注入假时钟 / 假适配器）。
export async function briefFromFixture(name, { build = {}, calls = [] } = {}) {
  const loaded = loadScenario(name)
  const accounts = accountsOf(loaded.scenario)
  const userId = build.userId ?? loaded.scenario.userId
  const brief = await buildBrief({
    registry,
    accountFor: accountForOf(accounts, userId),
    transport: transportFor(loaded, calls),
    config: loaded.scenario.config ?? {},
    since: loaded.scenario.since ?? null,
    now: () => new Date(loaded.scenario.now ?? Date.now()),
    ...build,
  })
  return { brief, loaded, accounts }
}
