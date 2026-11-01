// 多源早报的记录工具（#32 S4）。
//
// `--offline <fixture>` 重放一份 multi fixture（`test/fixtures/composio/multi/<scenario>/`），
// `--out <dir>` 写 `brief.json` 留记录；默认写 `$HOME/odm32-multi/<scenario>/` —— **不落仓库**
// （仓库里没有 `data/`，`.gitignore` 也没忽略它，写进去就会被提交）。
//
// 不带 `--offline` 时真跑：key 只从 `$COMPOSIO_API_KEY` / `$DSH_SECRET_COMPOSIO_API_KEY` 读，
// 打印里没有 key、没有邮箱、没有正文。notion 的根页面 id 从 `$COMPOSIO_NOTION_ROOT` 读；
// 今天 notion / googlecalendar 只有 EXPIRED 账号，真跑那一步等 owner 重新授权 ——
// 授权前它跑出来就是 `expired`，这是正确结果，不是失败。
//
// 这个脚本不投递飞书、不加依赖、不写超时重试（预算是 `brief.js` 里那 3 秒）。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { resolveAccount } from '../src/sources/composio/accounts.js'
import { buildBrief, COMPOSIO_TIMEOUT_MS } from '../src/sources/composio/brief.js'
import { createComposioApi } from '../src/sources/composio/api.js'
import { registry } from '../src/sources/composio/registry.js'

const USAGE = '用法：node scripts/composio-multi.mjs [--offline <fixture 目录>] [--out <目录>] [--user <user_id>]'

function parseArgs(argv) {
  const options = { offline: null, out: null, user: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--offline') options.offline = argv[++i]
    else if (arg === '--out') options.out = argv[++i]
    else if (arg === '--user') options.user = argv[++i]
    else throw new Error(`看不懂的参数：${arg}\n${USAGE}`)
  }
  return options
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// fixture 里的 app 文件：`{ toolkit, routes: [{ kind, pattern, body }] }`。
// `kind` 是 `proxyGet`（按 endpoint 匹配）或 `executeTool`（按动作名匹配），
// 路由按文件里的顺序匹配，具体的放前面。
function loadApps(appsDir) {
  if (!fs.existsSync(appsDir)) return {}
  const apps = {}
  for (const name of fs.readdirSync(appsDir)) {
    if (!name.endsWith('.json')) continue
    const fixture = readJson(path.join(appsDir, name))
    const toolkit = fixture.toolkit ?? name.replace(/\.json$/, '')
    apps[toolkit] = (Array.isArray(fixture.routes) ? fixture.routes : []).map(route => ({
      kind: route.kind ?? 'proxyGet',
      pattern: new RegExp(route.pattern),
      body: route.body,
    }))
  }
  return apps
}

function routeFor(apps, toolkit, kind, target) {
  const routes = apps[toolkit] ?? []
  const found = routes.find(route => route.kind === kind && route.pattern.test(target))
  if (!found) {
    const error = new Error(`E_FIXTURE_ROUTE: ${toolkit} 没有 ${kind} ${target} 的回放`)
    error.code = 'E_FIXTURE_ROUTE'
    throw error
  }
  return structuredClone(found.body)
}

// 离线 transport：把每个 connected account 映射回它的 toolkit，再按 fixture 回放。
function createFixtureTransport({ apps, accountToolkit }) {
  return {
    async proxyGet({ connectedAccountId, endpoint }) {
      const toolkit = accountToolkit.get(connectedAccountId)
      return routeFor(apps, toolkit, 'proxyGet', endpoint)
    },
    async executeTool({ toolSlug, connectedAccountId }) {
      const toolkit = accountToolkit.get(connectedAccountId)
      return routeFor(apps, toolkit, 'executeTool', toolSlug)
    },
  }
}

function accountsOf(scenario) {
  return Array.isArray(scenario.accounts) ? scenario.accounts : []
}

function accountForOf(accounts, userId) {
  return toolkit => resolveAccount(accounts, { toolkit, userId })
}

function writeBrief(outDir, brief) {
  fs.mkdirSync(outDir, { recursive: true })
  const file = path.join(outDir, 'brief.json')
  fs.writeFileSync(file, `${JSON.stringify(brief, null, 2)}\n`)
  return file
}

function summarize(name, brief, file) {
  const unread = brief.unread_sources.length === 0 ? '无' : brief.unread_sources.join('、')
  process.stdout.write(
    `${name}：facts ${brief.facts.length} / unread ${unread} / complete ${brief.complete}\n` +
      `  out: ${file}\n`,
  )
}

async function runOffline(options) {
  const fixtureDir = path.resolve(options.offline)
  if (!fs.existsSync(fixtureDir)) fail(`fixture 目录不存在：${fixtureDir}`)

  const scenario = readJson(path.join(fixtureDir, 'scenario.json'))
  const appsDir = path.resolve(fixtureDir, scenario.appsDir ?? 'apps')
  const apps = loadApps(appsDir)
  const accounts = accountsOf(scenario)
  const userId = options.user ?? scenario.userId

  const accountToolkit = new Map()
  for (const account of accounts) {
    const toolkit = account?.toolkit?.slug ?? account?.toolkit ?? account?.toolkit_slug
    if (account?.id && toolkit) accountToolkit.set(String(account.id), String(toolkit))
  }

  const name = path.basename(fixtureDir)
  const outDir = path.resolve(options.out ?? path.join(os.homedir(), 'odm32-multi', name))

  const brief = await buildBrief({
    registry,
    accountFor: accountForOf(accounts, userId),
    transport: createFixtureTransport({ apps, accountToolkit }),
    config: scenario.config ?? {},
    since: scenario.since ?? null,
    now: () => new Date(scenario.now ?? Date.now()),
  })

  const file = writeBrief(outDir, brief)
  summarize(name, brief, file)
}

async function runReal(options) {
  const apiKey = process.env.COMPOSIO_API_KEY || process.env.DSH_SECRET_COMPOSIO_API_KEY
  if (!apiKey) fail('缺 key：需要 COMPOSIO_API_KEY 或 DSH_SECRET_COMPOSIO_API_KEY（不会打印它）')
  const userId = options.user ?? process.env.COMPOSIO_USER_ID
  if (!userId) fail('缺 COMPOSIO_USER_ID：按人授权要「哪个人」，没有就解析不出来')

  const api = createComposioApi({ apiKey })
  const toolkits = registry.map(row => row.toolkit)
  const page = await api.listAccounts({ toolkitSlugs: toolkits, userIds: userId })
  const accounts = Array.isArray(page?.items) ? page.items : Array.isArray(page?.data) ? page.data : []

  const outDir = path.resolve(options.out ?? path.join(os.homedir(), 'odm32-multi', 'live'))
  const brief = await buildBrief({
    registry,
    accountFor: accountForOf(accounts, userId),
    transport: {
      proxyGet: args => api.proxyGet(args),
      executeTool: args => api.executeTool(args),
    },
    config: { notion: { rootId: process.env.COMPOSIO_NOTION_ROOT } },
    since: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    now: () => new Date(),
  })

  const file = writeBrief(outDir, brief)
  summarize('live', brief, file)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (COMPOSIO_TIMEOUT_MS !== 3000) fail(`E_BUDGET: COMPOSIO_TIMEOUT_MS 应该是 3000，拿到 ${COMPOSIO_TIMEOUT_MS}`)
  if (options.offline) await runOffline(options)
  else await runReal(options)
}

main().catch(error => fail(String(error?.stack ?? error)))
