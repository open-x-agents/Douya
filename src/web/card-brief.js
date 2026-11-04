// Prepared help on a card, computed from REAL source data (no model, nothing invented):
// a PR's size / touched areas / CI / review state / risk flags, so 「审 #N」 starts with what changed and what to look at.
// Everything comes from GitHub via Composio; missing data is simply left out.
import { cardLinks, linkType } from './card-prep.js'

const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const ghRef = url => { const m = String(url || '').match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/); return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null }
/** Composio wraps tool output differently per tool/version; dig out the payload. */
export const payload = res => {
  let d = res?.data ?? res
  for (let i = 0; i < 3 && d && typeof d === 'object' && !Array.isArray(d); i++) {
    if (d.number || d.check_runs || d.html_url) break // already the GitHub object
    const inner = [d.response_data, d.data, d.details].find(x => x && typeof x === 'object')
    if (inner === undefined) break
    d = inner
  }
  return d
}

const RISK = [
  [/(^|\/)(migrations?|schema|alembic)\b|\.sql$/i, '动了数据库迁移 / schema'],
  [/(auth|permission|acl|security|token|secret|crypto|oauth)/i, '涉及鉴权 / 安全'],
  [/(^|\/)\.github\/workflows\/|(^|\/)(Dockerfile|docker-compose[^/]*|Makefile|\.gitlab-ci\.ya?ml)$/i, '改了 CI / 部署配置'],
  [/(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|go\.sum|requirements[^/]*\.txt)$/i, '依赖有变化'],
]
const isTest = p => /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$/i.test(p)

/** Top-level areas touched (first two path segments), by lines changed. */
function areas(files) {
  const m = new Map()
  for (const f of files) {
    const p = String(f.filename || ''); if (!p) continue
    const seg = p.split('/'); const k = seg.length > 2 ? `${seg[0]}/${seg[1]}` : seg.length === 2 ? seg[0] : p
    m.set(k, (m.get(k) || 0) + (Number(f.changes) || (Number(f.additions) || 0) + (Number(f.deletions) || 0)))
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
}

/**
 * Pure: build the brief from GitHub objects.
 * @param {object} pr  GitHub pull request object
 * @param {object[]} files  list-files result
 * @param {object[]} checks check runs (name, status, conclusion)
 * @param {{mine?:boolean}} opts
 */
export function buildPrBrief(pr = {}, files = [], checks = [], { mine = false } = {}) {
  if (!pr || !pr.number) return null
  const add = Number(pr.additions) || files.reduce((n, f) => n + (Number(f.additions) || 0), 0)
  const del = Number(pr.deletions) || files.reduce((n, f) => n + (Number(f.deletions) || 0), 0)
  const nFiles = Number(pr.changed_files) || files.length
  const where = areas(files).slice(0, 3)
  const lines = []
  if (add || del || nFiles) lines.push({ k: '改动', v: `+${add} −${del} · ${nFiles} 个文件${where.length ? `，主要在 ${where.join('、')}` : ''}` })
  const failed = checks.filter(c => ['failure', 'timed_out', 'cancelled', 'action_required'].includes(c.conclusion))
  const pending = checks.filter(c => c.status && c.status !== 'completed')
  let ci = null
  if (checks.length) ci = failed.length ? `CI ${failed.length} 项失败：${failed.slice(0, 2).map(c => clip(c.name, 30)).join('、')}` : pending.length ? `CI 还在跑（${pending.length} 项）` : 'CI 全部通过'
  const state = pr.merged || pr.merged_at ? '已合并' : pr.state === 'closed' ? '已关闭' : null
  const draft = !state && pr.draft ? '草稿' : null
  const conflict = pr.mergeable === false || pr.mergeable_state === 'dirty' ? '有冲突' : null
  const reviewers = (pr.requested_reviewers || []).map(r => r?.login).filter(Boolean)
  const approved = pr.approvals || [], changes = pr.changesRequested || []
  const status = [state, draft, ci, conflict, changes.length ? `${changes.slice(0, 2).join('、')} 要求修改` : null, approved.length ? `${approved.slice(0, 2).join('、')} 已批准` : null, !approved.length && !changes.length && reviewers.length ? `等 ${reviewers.slice(0, 3).join('、')} review` : null].filter(Boolean)
  if (status.length) lines.push({ k: '状态', v: status.join(' · ') })
  const risks = []
  for (const [re, label] of RISK) if (files.some(f => re.test(String(f.filename || '')))) risks.push(label)
  if (add + del > 800) risks.push('改动量大，建议分段看')
  if (files.length && !files.some(f => isTest(String(f.filename || ''))) && add > 40) risks.push('没有改测试')
  if (risks.length) lines.push({ k: '留意', v: risks.slice(0, 3).join('；') })
  // First real sentence of the description (skip template headings / comments / checkboxes).
  const intro = String(pr.body || '').split(/\r?\n/).map(s => s.trim()).filter(s => s && !/^(#|<!--|- \[[ x]\]|\|)/i.test(s) && !/[:：]$/.test(s))
    .map(s => s.replace(/^[>*\-\s]+/, '').trim()).find(s => s.length > 8)
  if (intro) lines.push({ k: '作者说', v: clip(intro, 90) })
  // The one concrete next move, from the facts above.
  let next
  if (state) next = `${state}，这一项可以从今天移走`
  else if (draft && !mine) next = '还是草稿，等作者标 ready 再细审；现在只需扫一眼方向'
  else if (draft && mine && !failed.length) next = '还是草稿：准备好了就标 ready for review 并指定 reviewer'
  else if (mine && failed.length) next = `先修 CI：${clip(failed[0].name, 30)}`
  else if (mine && conflict) next = '先解决冲突再催 review'
  else if (mine && changes.length) next = `先改 ${changes[0]} 提的意见`
  else if (mine && approved.length && !failed.length) next = '已有人批准、CI 没红，可以合并了'
  else if (mine) next = reviewers.length ? `等 ${reviewers[0]} review，超过一天没动就催一下` : '还没指定 reviewer，先找人 review'
  else if (failed.length) next = `CI 还红着（${clip(failed[0].name, 24)}），可以先请作者修再审`
  else next = `先看 ${where[0] || '主要改动'}${risks.length ? `，重点看「${risks[0]}」` : ''}，没问题就批准`
  return { kind: 'pr', url: pr.html_url || null, number: pr.number, title: clip(pr.title, 80), mine, lines, next, resolved: !!state, ciFailed: failed.length > 0, at: new Date().toISOString() }
}

/** The link on a card the brief is about: a PR to review first, then the user's own PR. */
export function briefTarget(card, itemStatus = {}) {
  const open = cardLinks(card).filter(l => !itemStatus[l.url] && !(card.itemStatus || {})[l.url] && linkType(l) === 'pr' && ghRef(l.url))
  const review = open.find(l => !/mine/.test(String(l.type)))
  const mine = open.find(l => /mine/.test(String(l.type)))
  const pick = review || mine
  return pick ? { url: pick.url, mine: pick === mine && !review, ...ghRef(pick.url) } : null
}

/** Fetch + build (Composio). Errors become { error } — the card just shows no brief.
 * GITHUB_GET_A_PULL_REQUEST comes back as a patch through Composio, so the PR object is assembled from the issue
 * view (title/state/body/draft/merged), the file list (+/−, paths, head sha in blob_url), reviewers, reviews, check runs. */
export async function fetchPrBrief(client, target) {
  const { owner, repo, number } = target
  const exec = (slug, args) => client.executeAction(slug, args).then(payload).catch(e => ({ __error: e.message }))
  const [issue, files, requested, reviews] = await Promise.all([
    exec('GITHUB_GET_AN_ISSUE', { owner, repo, issue_number: number }),
    exec('GITHUB_LIST_PULL_REQUESTS_FILES', { owner, repo, pull_number: number, per_page: 100 }),
    exec('GITHUB_LIST_REQUESTED_REVIEWERS_FOR_A_PULL_REQUEST', { owner, repo, pull_number: number }),
    exec('GITHUB_LIST_REVIEWS_FOR_A_PULL_REQUEST', { owner, repo, pull_number: number, per_page: 50 }),
  ])
  if (!issue || issue.__error || !issue.number) return { error: issue?.__error || '拿不到这个 PR' }
  const fl = Array.isArray(files) ? files : Array.isArray(files?.files) ? files.files : []
  const sha = (fl.map(f => (String(f.blob_url || '').match(/\/blob\/([0-9a-f]{40})\//) || [])[1]).find(Boolean)) || null
  let checks = []
  if (sha) {
    const c = await exec('GITHUB_LIST_CHECK_RUNS_FOR_A_REF', { owner, repo, ref: sha, per_page: 50 })
    checks = Array.isArray(c?.check_runs) ? c.check_runs : Array.isArray(c) ? c : []
    if (!checks.length) { // older Composio tool sets: Actions workflow runs for the head commit
      const w = await exec('GITHUB_LIST_WORKFLOW_RUNS_FOR_A_REPOSITORY', { owner, repo, head_sha: sha, per_page: 30 })
      const runs = Array.isArray(w?.workflow_runs) ? w.workflow_runs : []
      checks = runs.filter(r => !r.head_sha || r.head_sha === sha).map(r => ({ name: r.name || r.display_title, status: r.status, conclusion: r.conclusion }))
      if (!checks.length) console.log('[card-brief] no CI data', sha, JSON.stringify(w).slice(0, 200))
    }
  }
  const rv = Array.isArray(reviews) ? reviews : []
  const latest = new Map(); for (const r of rv) if (r?.user?.login && r.state !== 'COMMENTED') latest.set(r.user.login, r.state)
  const pr = {
    number: issue.number, title: issue.title, body: issue.body, html_url: issue.html_url, state: issue.state, draft: !!issue.draft,
    merged_at: issue.pull_request?.merged_at || null,
    requested_reviewers: Array.isArray(requested?.users) ? requested.users : [],
    approvals: [...latest.entries()].filter(([, st]) => st === 'APPROVED').map(([u]) => u),
    changesRequested: [...latest.entries()].filter(([, st]) => st === 'CHANGES_REQUESTED').map(([u]) => u),
  }
  return buildPrBrief(pr, fl, checks, { mine: target.mine })
}
