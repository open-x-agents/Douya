// #16「一天真数据 e2e」的验收判定器。
//
// 第一刀只有两段，它们判的都是「记录自己」：
//   status —— docs/e2e-day1/run.json 是不是一条像样的记录（schema / 状态 / run 块）
//   doc    —— 文档十节是否齐全、Status 与 run.status 是否一致、跑不通时有没有写清卡在哪，
//             以及 A1 的四条附加断言里不依赖外部证据的三条（四步齐全、两列延迟可复算、
//             面板数字指得到 report: / member: ref）与「五张截图真的在」。
//
// samples / latency / failure / writes / day2 五段、采集器、只读钩子、nightly 作业按 issue
// 的分步留到后续切片。这一段不实现它们，也不假装判过。
//
// 退出码：0 全过；1 记录不合格（真红）；2 只有一种情况——run.json 还不存在（今晚还没跑）。
// 2 是唯一的「免检出口」：一旦有 run.json，任何缺字段、状态写反都是 1。

import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export const SECTIONS = [
  '## 环境',
  '## 一天时间线',
  '## 面板数字',
  '## 时延四项',
  '## 20 句抽查',
  '## 失败场景',
  '## 零写操作',
  '## 截图',
  '## 复现',
  '## 卡在哪',
]

export const STEP_NAMES = ['morning_report', 'closure', 'evening_report', 'next_day_view']
export const REPORT_DEADLINES = { morning_report: '08:45', evening_report: '18:30' }
export const KNOWN_BLOCKERS = [9, 10, 11, 12, 14, 15]
export const SHOTS = [
  'morning-report.png',
  'closure.png',
  'evening-report.png',
  'missing-source.png',
  'next-day.png',
]
export const STATUS_TEXT = { pass: '跑通', fail: '跑不通' }

// 时间一律 UTC，YYYY-MM-DDTHH:MM:SSZ；带偏移的写法先转成 UTC 再进记录。
export const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''
const isIsoUtc = (value) => typeof value === 'string' && ISO_UTC.test(value) && Number.isFinite(Date.parse(value))
const isNonNegativeInt = (value) => Number.isInteger(value) && value >= 0

const formatters = new Map()
function zonedFormatter(tz) {
  if (!formatters.has(tz)) {
    formatters.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }))
  }
  return formatters.get(tz)
}

export function isValidTimeZone(tz) {
  if (!isNonEmptyString(tz)) return false
  try {
    zonedFormatter(tz).format(new Date(0))
    return true
  } catch {
    return false
  }
}

export function zonedParts(ms, tz) {
  const fields = {}
  for (const part of zonedFormatter(tz).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') fields[part.type] = part.value
  }
  return {
    year: Number(fields.year),
    month: Number(fields.month),
    day: Number(fields.day),
    hour: Number(fields.hour),
    minute: Number(fields.minute),
    second: Number(fields.second),
  }
}

// 该时刻在 tz 里的偏移量（毫秒）：把「tz 里的墙上时间」当成 UTC 读出来，再减去真实时刻。
function zoneOffsetMs(ms, tz) {
  const p = zonedParts(ms, tz)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(ms / 1000) * 1000
}

// 把「某天 tz 的 08:45」换成一个真实时刻。没有时区库，靠猜一次 + 用算出的偏移修正第二次；
// 夏令时跳变的两个小时内可能差一小时，但 Asia/Shanghai 没有夏令时，记录里也只允许这一个时区之外的合法 IANA 名。
export function zonedLocalToMs({ year, month, day, hour, minute }, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0)
  let ms = guess - zoneOffsetMs(guess, tz)
  const corrected = zoneOffsetMs(ms, tz)
  if (corrected !== zoneOffsetMs(guess, tz)) ms = guess - corrected
  return ms
}

// ---------- status：记录自己是不是像样的 ----------

export function checkStatus(run) {
  const problems = []
  if (!isObject(run)) return ['run.json 不是 JSON 对象']
  if (run.schema !== 1) problems.push(`schema 必须是 1，现在是 ${JSON.stringify(run.schema)}`)
  if (run.status !== 'pass' && run.status !== 'fail') {
    problems.push(`status 只能是 pass / fail，现在是 ${JSON.stringify(run.status)}`)
  }
  if (!isObject(run.run)) {
    problems.push('缺 run 块（sha / tz / machine / started_at / ended_at / operator）')
    return problems
  }
  const meta = run.run
  if (typeof meta.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(meta.sha)) {
    problems.push(`run.sha 必须是 40 位十六进制，现在是 ${JSON.stringify(meta.sha)}`)
  }
  if (!isValidTimeZone(meta.tz)) problems.push(`run.tz 不是合法时区：${JSON.stringify(meta.tz)}`)
  if (!isNonEmptyString(meta.machine)) problems.push('run.machine 不能为空')
  if (!isIsoUtc(meta.started_at)) problems.push('run.started_at 必须写成 UTC 的 YYYY-MM-DDTHH:MM:SSZ')
  if (!isIsoUtc(meta.ended_at)) problems.push('run.ended_at 必须写成 UTC 的 YYYY-MM-DDTHH:MM:SSZ')
  if (isIsoUtc(meta.started_at) && isIsoUtc(meta.ended_at)
    && Date.parse(meta.ended_at) < Date.parse(meta.started_at)) {
    problems.push('run.ended_at 早于 run.started_at')
  }
  if (!isNonEmptyString(meta.operator)) problems.push('run.operator 不能为空（谁跑的要写出来）')
  return problems
}

// ---------- doc：文档与记录对不对得上 ----------

function docLines(doc) {
  return String(doc).split('\n').map((line) => line.trimEnd())
}

export function sectionMap(doc) {
  const map = new Map()
  let current = null
  for (const line of docLines(doc)) {
    if (line.startsWith('## ')) {
      current = SECTIONS.includes(line) && !map.has(line) ? line : null
      if (current) map.set(current, [])
      continue
    }
    if (current) map.get(current).push(line)
  }
  for (const [title, body] of map) map.set(title, body.join('\n').trim())
  return map
}

export function statusText(doc) {
  const match = /^Status:[ \t]*(.*)$/m.exec(String(doc))
  return match ? match[1].trim() : null
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function checkSections(doc, problems) {
  const lines = docLines(doc)
  const positions = SECTIONS.map((title) => ({ title, at: lines.indexOf(title) }))
  for (const { title, at } of positions) if (at < 0) problems.push(`少了 ${title} 这一节`)
  const present = positions.filter(({ at }) => at >= 0)
  for (let i = 1; i < present.length; i += 1) {
    if (present[i].at < present[i - 1].at) {
      problems.push(`${present[i].title} 必须排在 ${present[i - 1].title} 之后`)
      break
    }
  }
}

function checkSteps(run, problems) {
  const steps = run?.steps
  if (!Array.isArray(steps) || steps.length !== 4) {
    problems.push(`run.steps 必须恰好 4 条（早报 / 关一件 / 晚报 / 次日再看），现在是 ${
      Array.isArray(steps) ? steps.length : '不是数组'}`)
    return
  }
  const names = steps.map((step) => step?.name)
  for (const name of STEP_NAMES) if (!names.includes(name)) problems.push(`run.steps 少了 ${name}`)
  if (new Set(names).size !== names.length) problems.push('run.steps 里有重复的 name')
  for (const step of steps) {
    if (!isIsoUtc(step?.at)) problems.push(`步骤 ${step?.name ?? '?'} 的 at 必须写成 UTC 的 YYYY-MM-DDTHH:MM:SSZ`)
    if ('deadline_local' in (step ?? {}) && !(step.name in REPORT_DEADLINES)) {
      problems.push(`${step.name} 不该有 deadline_local（只有早报 / 晚报卡点）`)
    }
  }
  const closure = steps.find((step) => step?.name === 'closure')
  if (closure && !isNonEmptyString(closure.evidence_ref)) {
    problems.push('closure 步必须写 evidence_ref（关掉的那件证据来自哪次真实消息 / 哪次文档改动）')
  }
  const tz = run?.run?.tz
  for (const [name, deadlineLocal] of Object.entries(REPORT_DEADLINES)) {
    const step = steps.find((item) => item?.name === name)
    if (!step) continue
    if (step.deadline_local !== deadlineLocal) {
      problems.push(`${name} 的 deadline_local 必须是 ${deadlineLocal}，现在是 ${JSON.stringify(step.deadline_local)}`)
    }
    for (const key of ['latency_ms', 'deadline_ms']) {
      if (!isNonNegativeInt(step[key])) {
        problems.push(`${name}.${key} 必须是非负整数，现在是 ${JSON.stringify(step[key])}`)
      }
    }
    if (!isNonNegativeInt(step.deadline_ms) || !isIsoUtc(step.at) || !isValidTimeZone(tz)
      || step.deadline_local !== deadlineLocal) continue
    const [hour, minute] = deadlineLocal.split(':').map(Number)
    const local = zonedParts(Date.parse(step.at), tz)
    const deadlineMs = zonedLocalToMs({ year: local.year, month: local.month, day: local.day, hour, minute }, tz)
    const expected = Date.parse(step.at) - deadlineMs
    if (Math.abs(step.deadline_ms - expected) > 1000) {
      problems.push(`${name}.deadline_ms 与重算差 ${Math.abs(step.deadline_ms - expected)}ms`
        + `（记录 ${step.deadline_ms}，按 ${tz} 重算是 ${expected}）`)
    }
  }
}

function checkPanel(run, doc, problems) {
  const panel = run?.panel
  if (!isObject(panel)) {
    problems.push('缺 run.panel（面板上的数字要指得到 source）')
    return
  }
  const memberIds = panel.member_ids
  const reportKeys = panel.report_keys
  const numbers = panel.numbers
  if (!Array.isArray(memberIds) || memberIds.length === 0 || !memberIds.every(isNonEmptyString)) {
    problems.push('run.panel.member_ids 必须是非空字符串数组')
  }
  if (!Array.isArray(reportKeys) || !reportKeys.every(isNonEmptyString)) {
    problems.push('run.panel.report_keys 必须是字符串数组')
  }
  if (!Array.isArray(numbers) || numbers.length !== 2) {
    problems.push('run.panel.numbers 必须恰好两条（提交率 / 未交数）')
    return
  }
  const byLabel = new Map(numbers.map((entry) => [entry?.label, entry]))
  const rate = byLabel.get('提交率')
  const missing = byLabel.get('未交数')
  if (!rate) problems.push('run.panel.numbers 缺「提交率」')
  if (!missing) problems.push('run.panel.numbers 缺「未交数」')
  const ids = new Set(Array.isArray(memberIds) ? memberIds : [])

  if (rate) {
    if (!Array.isArray(rate.refs)) {
      problems.push('提交率.refs 必须是数组')
    } else {
      const dated = new Set()
      for (const ref of rate.refs) {
        const match = typeof ref === 'string' ? /^report:([^:]+):(\d{4}-\d{2}-\d{2})$/.exec(ref) : null
        if (!match) {
          problems.push(`提交率的 ref 必须是 report:<memberId>:<YYYY-MM-DD>，现在是 ${JSON.stringify(ref)}`)
          continue
        }
        if (!ids.has(match[1])) problems.push(`提交率的 ref 里的 ${match[1]} 不在 member_ids 里`)
        dated.add(`${match[1]}:${match[2]}`)
      }
      const expected = `${dated.size}/${ids.size}`
      if (rate.value !== expected) {
        problems.push(`提交率的 value 应是 ${expected}（refs 里不重复的 report 数 / member_ids 数），现在是 ${JSON.stringify(rate.value)}`)
      }
      if (Array.isArray(reportKeys)) {
        for (const key of dated) if (!reportKeys.includes(key)) problems.push(`提交率的 ref ${key} 不在 report_keys 里`)
      }
    }
  }

  if (missing) {
    if (!Array.isArray(missing.refs)) {
      problems.push('未交数.refs 必须是数组')
    } else {
      const reported = new Set((Array.isArray(reportKeys) ? reportKeys : []).map((key) => String(key).split(':')[0]))
      for (const ref of missing.refs) {
        const match = typeof ref === 'string' ? /^member:(.+)$/.exec(ref) : null
        if (!match) {
          problems.push(`未交数的 ref 必须是 member:<memberId>，现在是 ${JSON.stringify(ref)}`)
          continue
        }
        if (!ids.has(match[1])) problems.push(`未交数的 ref 里的 ${match[1]} 不在 member_ids 里`)
        if (reported.has(match[1])) problems.push(`未交数的 ref ${match[1]} 今天已经交过（在 report_keys 里）`)
      }
      if (missing.value !== String(missing.refs.length)) {
        problems.push(`未交数的 value 应等于 refs 的条数 ${missing.refs.length}，现在是 ${JSON.stringify(missing.value)}`)
      }
    }
  }

  const panelBody = sectionMap(doc).get('## 面板数字')
  if (panelBody == null) return
  if (rate && isNonEmptyString(rate.value)) {
    const pattern = new RegExp(`提交率\\s*[:：]?\\s*${escapeRegExp(rate.value)}`)
    if (!pattern.test(panelBody)) problems.push(`## 面板数字 里要写出提交率 ${rate.value}`)
  }
  if (missing && isNonEmptyString(missing.value)) {
    const pattern = new RegExp(`未交[^0-9]*${escapeRegExp(missing.value)}`)
    if (!pattern.test(panelBody)) problems.push(`## 面板数字 里要写出未交数 ${missing.value}`)
  }
}

function checkShots(shotsDir, problems) {
  for (const name of SHOTS) {
    const file = join(shotsDir, name)
    if (!existsSync(file)) problems.push(`截图缺 ${name}（docs/e2e-day1/shots/${name}）`)
    else if (statSync(file).size === 0) problems.push(`截图是空文件：docs/e2e-day1/shots/${name}`)
  }
}

export function checkDoc({ doc, run, shotsDir }) {
  const problems = []
  const text = String(doc ?? '')
  const status = statusText(text)
  if (status == null) problems.push('文档没有 Status: 行')
  else if (status !== '跑通' && status !== '跑不通') {
    problems.push(`Status: 只能写 跑通 / 跑不通，现在是「${status}」`)
  }

  checkSections(text, problems)

  if (status && run?.status === 'pass' && status !== STATUS_TEXT.pass) {
    problems.push(`run.status=pass，文档里应该写 Status: ${STATUS_TEXT.pass}，现在是 ${status}`)
  }
  if (status && run?.status === 'fail' && status !== STATUS_TEXT.fail) {
    problems.push(`run.status=fail，文档里应该写 Status: ${STATUS_TEXT.fail}，现在是 ${status}`)
  }

  if (status === '跑不通') {
    const body = sectionMap(text).get('## 卡在哪') ?? ''
    if (!/#\d+/.test(body)) problems.push('跑不通 但 ## 卡在哪 里没有列出卡住的 issue 号')
  }

  checkSteps(run, problems)
  checkPanel(run, text, problems)
  if (shotsDir) checkShots(shotsDir, problems)
  return problems
}

// ---------- 跑哪几段、怎么报 ----------

export function runChecks({ doc, run, shotsDir, only = null }) {
  const checks = [
    { name: 'status', problems: () => checkStatus(run) },
    { name: 'doc', problems: () => checkDoc({ doc, run, shotsDir }) },
  ]
  const selected = only ? checks.filter((check) => check.name === only) : checks
  if (only && selected.length === 0) {
    throw new Error(`不认识的段：${only}（这一刀只有 ${checks.map((check) => check.name).join(' / ')}）`)
  }
  const results = selected.map((check) => ({ name: check.name, problems: check.problems() }))

  // 「跑不通」必须有至少一段是 FAIL：各段全过却写跑不通，就是状态写反了。
  // 只跑单段（--only）时判不了别段，所以这条只在整跑时生效。
  if (selected.length === checks.length && statusText(doc) === '跑不通'
    && results.every((result) => result.problems.length === 0)) {
    results.find((result) => result.name === 'doc')
      .problems.push('状态写反了：各段全过却写 跑不通（跑通了就写 跑通，没跑通就至少有一段 FAIL）')
  }
  return results
}

export function formatResults(results) {
  const lines = []
  for (const result of results) {
    if (result.problems.length === 0) {
      lines.push(`PASS ${result.name}`)
      continue
    }
    lines.push(`FAIL ${result.name} — ${result.problems[0]}`)
    for (const problem of result.problems.slice(1)) lines.push(`  · ${problem}`)
  }
  const passed = results.filter((result) => result.problems.length === 0).length
  const total = results.length
  lines.push(passed === total ? `PASS ${passed}/${total}` : `FAIL ${passed}/${total}`)
  return { lines, passed, total }
}

// ---------- 命令行 ----------

const USAGE = '用法：node scripts/e2e-day1-check.mjs [docs/e2e-day1.md] [--only status|doc] [--run <run.json>] [--shots <截图目录>]'

export function parseArgs(argv) {
  const options = { docPath: 'docs/e2e-day1.md', runPath: null, shotsDir: null, only: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--only') options.only = argv[++i]
    else if (arg === '--run') options.runPath = argv[++i]
    else if (arg === '--shots') options.shotsDir = argv[++i]
    else if (arg.startsWith('-')) throw new Error(`看不懂的参数：${arg}\n${USAGE}`)
    else options.docPath = arg
  }
  if (options.only && options.only !== 'status' && options.only !== 'doc') {
    throw new Error(`--only 只认 status / doc，现在是 ${options.only}\n${USAGE}`)
  }
  return options
}

function defaultPaths(docPath) {
  const absolute = resolve(docPath)
  const stem = join(dirname(absolute), basename(absolute).replace(/\.md$/i, ''))
  return {
    docPath: absolute,
    runPath: join(stem, 'run.json'),
    shotsDir: join(stem, 'shots'),
  }
}

export function main(argv) {
  const options = parseArgs(argv)
  const defaults = defaultPaths(options.docPath)
  const runPath = options.runPath ? resolve(options.runPath) : defaults.runPath
  const shotsDir = options.shotsDir ? resolve(options.shotsDir) : defaults.shotsDir

  // 只有这一种情况是 2：还没有 run.json，今晚还没跑。其它都不许走免检。
  if (!existsSync(runPath)) {
    console.log('NO-RUN 今晚还没跑')
    return 2
  }
  if (!existsSync(defaults.docPath)) {
    console.log(`FAIL doc — 找不到 ${defaults.docPath}`)
    return 1
  }
  const doc = readFileSync(defaults.docPath, 'utf8')
  let run
  try {
    run = JSON.parse(readFileSync(runPath, 'utf8'))
  } catch (error) {
    console.log(`FAIL status — run.json 不是合法 JSON：${error.message}`)
    return 1
  }
  const results = runChecks({ doc, run, shotsDir, only: options.only })
  const { lines, passed, total } = formatResults(results)
  console.log(lines.join('\n'))
  return passed === total ? 0 : 1
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('e2e-day1-check.mjs')
if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`判定器自己坏了：${error.message}`)
    process.exitCode = 1
  }
}
