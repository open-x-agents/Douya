// 面板判定的全部规则，住在这里而不在 e2e 里 —— 因为这道闸自己也得被测。
//
// `test/e2e/real-model.e2e.mjs` 只有真模型能跑（要 key、要网络、要钱），所以它的判定
// 如果写在文件里，就永远证明不了「判定会不会红」。这一层是纯函数：给一份面板和一份夹具，
// 返回 problems。`test/real-model-checks.test.js` 用桩输出喂它，不联网也能看见红。
//
// 词汇对齐产品（`src/host/panel.js` 的 SOURCE_NAMES、`src/host/ask.js` 的 SOURCE_LABELS）：
// ref 形如 `<source>:<id>`，source ∈ KNOWN_SOURCES。夹具用这份词汇，闸才在测产品里的东西。

import { anchorsOf, sourceLabel } from '../../src/host/ask.js'

export const KNOWN_SOURCES = ['gcal', 'gmail', 'feishu_doc', 'feishu_cal', 'feishu_msg', 'github', 'composio']

// A11 的唯一注入点：把它改成 false，E_FACT_REF 不再报，`judgePanel：编一个不存在的 ref 就红` 必须变红。
export const REF_MEMBERSHIP_ENFORCED = true

// 失败时打给人的那一句，由 code 定，不在调用方另写（A5 的中文断言靠它）。
export const MESSAGES = {
  E_SHAPE: '输出是 JSON 且有 facts/headline/advice',
  E_HEADLINE_LEN: '结论不超过 40 字',
  E_ADVICE_LEN: '建议不超过 20 字',
  E_FACT_COUNT: 'facts 在 1 到 3 条之间',
  E_SOURCE_VOCAB: '夹具的 ref 要用产品词汇 <source>:<id>',
  E_FACT_REF: '每条事实的 evidence_ref 原样取自信源列表',
  E_INVENTED_ANCHOR: '事实里的数字/时刻必须出现在被引用的信源里',
  E_UNREAD_MISSING: '读不到的信源要写进 unread_sources',
  E_UNREAD_SOURCE_CLAIMED: '没用读不到的信源编事实',
  E_COVERAGE: '正向至少用到 2 条不同信源',
}

const text = (value) => (typeof value === 'string' ? value : '')
const squash = (value) => String(value ?? '').replace(/\s+/g, '')
const chars = (value) => [...String(value ?? '')].length

// 模型输出里的 JSON：允许前后有废话和 ```json 围栏，只认第一个 { 到最后一个 }。
// 拿不到就抛 code=E_NO_JSON，而不是让 JSON.parse 的 SyntaxError 冒到日志里。
export function parseModelJson(output) {
  const cleaned = String(output ?? '')
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/m, '')
    .trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw { code: 'E_NO_JSON', message: `输出里没有 JSON：${cleaned.slice(0, 120)}` }
  }
  const body = cleaned.slice(start, end + 1)
  try {
    return JSON.parse(body)
  } catch (error) {
    throw { code: 'E_NO_JSON', message: `输出里没有 JSON：${body.slice(0, 120)}（${error.message}）` }
  }
}

// 一份面板对着它的夹具判。按顺序判，全部返回 problem，绝不抛错 —— 缺 facts 时抛的
// TypeError 正是缺口 4（「理由是一句 JS 报错」）。
export function judgePanel({ panel, fixture, label = '正向' }) {
  const problems = []
  const add = (code, detail = '') => problems.push({ code, message: MESSAGES[code], detail })
  const sources = Array.isArray(fixture?.sources) ? fixture.sources : []
  const unreadable = Array.isArray(fixture?.unreadable) ? fixture.unreadable : []
  const byRef = new Map(sources.map((source) => [source?.ref, source]))

  // 1. 形状。这一条不过就停：下面每条都假设 facts 是数组。
  const headline = text(panel?.headline).trim()
  const adviceOk = typeof panel?.advice === 'string'
  const facts = Array.isArray(panel?.facts) ? panel.facts : null
  if (headline === '' || facts === null || !adviceOk) {
    const missing = []
    if (headline === '') missing.push('headline 不是非空字符串')
    if (facts === null) missing.push('facts 不是数组')
    if (!adviceOk) missing.push('advice 不是字符串')
    add('E_SHAPE', missing.join('；'))
    return { problems }
  }

  // 2. 长度
  if (chars(headline) > 40) add('E_HEADLINE_LEN', `${chars(headline)} 字`)
  if (chars(panel.advice) > 20) add('E_ADVICE_LEN', `${chars(panel.advice)} 字`)

  // 3. 条数
  if (facts.length < 1 || facts.length > 3) add('E_FACT_COUNT', `${facts.length} 条`)

  // 4. 夹具本身得说产品的话，否则测的是一份不存在的词汇表
  for (const source of sources) {
    const ref = String(source?.ref ?? '')
    const prefix = ref.split(':')[0]
    if (!KNOWN_SOURCES.includes(prefix)) add('E_SOURCE_VOCAB', ref || '（空 ref）')
  }

  // 5. 每条事实都得指到夹具里真的有的那条信源（原样，不归一化）
  if (REF_MEMBERSHIP_ENFORCED) {
    const invented = facts.map((fact) => String(fact?.evidence_ref ?? '')).filter((ref) => !byRef.has(ref))
    if (invented.length > 0) add('E_FACT_REF', `编出来的 ref：${invented.join(', ')}`)
  }

  // 6. 数字/时刻必须出现在被引用的那条信源里 —— 「12.8 万」挂在一个真 ref 名下也算编。
  //    （supportedClaim() 这里不能用：它把锚点去空格却没把信源去空格，会丢真话。）
  for (const fact of facts) {
    const ref = String(fact?.evidence_ref ?? '')
    const source = byRef.get(ref)
    if (!source) continue // 指不到信源由第 5 条判，这里不重复报
    const evidence = squash(`${text(source.title)} ${text(source.excerpt)}`)
    for (const anchor of anchorsOf(text(fact?.text))) {
      if (!evidence.includes(anchor)) add('E_INVENTED_ANCHOR', `${anchor} 不在 ${ref} 的原文里`)
    }
  }

  // 7. 读不到的信源必须被点名（按源前缀或中文标签）
  const named = (Array.isArray(panel.unread_sources) ? panel.unread_sources : []).map((value) =>
    squash(value).toLowerCase(),
  )
  for (const source of unreadable) {
    const key = squash(source).toLowerCase()
    const label = squash(sourceLabel(key)).toLowerCase()
    const told = named.some((entry) => entry.includes(key) || (label !== '' && entry.includes(label)))
    if (!told) add('E_UNREAD_MISSING', `unread_sources 里没有 ${source}`)
  }

  // 8. 不许拿读不到的信源编事实，也不许出现全部信源里都找不到的数字/时刻
  const unreadPrefixes = new Set(unreadable.map((source) => String(source).toLowerCase()))
  const allText = squash(sources.map((source) => `${text(source?.title)} ${text(source?.excerpt)}`).join(' '))
  for (const fact of facts) {
    const ref = String(fact?.evidence_ref ?? '')
    if (unreadPrefixes.has(ref.split(':')[0].toLowerCase())) {
      add('E_UNREAD_SOURCE_CLAIMED', `引用了读不到的信源：${ref}`)
    }
    for (const anchor of anchorsOf(text(fact?.text))) {
      if (!allText.includes(anchor)) add('E_UNREAD_SOURCE_CLAIMED', `${anchor} 在全部信源里都找不到`)
    }
  }

  // 9. 正向至少用到 2 条不同信源（沿用旧阈值，不收紧到 3/3）
  if (label === '正向') {
    const used = new Set(facts.map((fact) => String(fact?.evidence_ref ?? ''))).size
    if (used < 2) add('E_COVERAGE', `用到 ${used} 条来源`)
  }

  return { problems }
}
