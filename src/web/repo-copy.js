// Repo tile copy helpers shared by the digest and the store repair.

/** Drop zero-count phrases the headline/summary template tends to produce ("0 reviews pending", "合并了 0 个 PR"). */
export function tidyRepoCopy(headline = '', summary = '') {
  const h = String(headline)
    .replace(/[,，;；·\-–—]\s*0 (?:PRs? |reviews? |review requests? )?(?:pending|awaiting review|to review)\b\.?/gi, '')
    .replace(/^\s*0 (?:reviews? )?pending[,，]?\s*/i, '')
    // headline cut at 60 chars mid-phrase: "…, 0 revi" / "…, 0" / "…; 0 reviews pend"
    .replace(/\s*[,，;；]\s*0(?:\s+[a-z]*){0,2}…?\s*$/i, '')
    .trim()
  const sm = String(summary)
    .replace(/[，,；;]?\s*(?:还有|另有|目前)?\s*0\s*个\s*PR\s*(?:等待|等|待)\s*review[。.]?/g, '。')
    .replace(/过去\s*24h\s*合并了\s*0\s*个\s*PR[，,]?\s*(?:主要)?(?:围绕|是)?/g, '过去 24h 主要在推进')
    .replace(/。{2,}/g, '。').replace(/[，,；;]。/g, '。').replace(/\s+。/g, '。')
    .trim()
  const fixed = sm.includes('主要在推进') ? sm.replace(/([^，,；;。]*主要在推进[^，,；;。]*?)推进(?=[。；;，,]|$)/, '$1') : sm
  return { headline: h || headline, summary: fixed || summary }
}


const ZERO_OR_REPO_WIDE_NEXT = /^逐个推进 \d+ 个 PR/
/**
 * Repair stored repo tiles written before the fix: zero-count copy, and a next step / action built from the
 * repo-wide PR count ("逐个推进 157 个 PR", "查看 157 个 PR") instead of a concrete related item. Idempotent.
 */
export function fixRepoCard(card) {
  if (!card || card.type !== 'project-cluster') return card
  const { headline, summary } = tidyRepoCopy(card.title || '', card.body || '')
  let next = card
  if (headline !== card.title || summary !== card.body) next = { ...next, title: headline || card.title, body: summary || card.body }
  if (ZERO_OR_REPO_WIDE_NEXT.test(card.nextAction || '')) {
    const ll = (card.blocks || []).find(b => b?.type === 'link-list')
    const first = ll?.links?.find(l => l?.url)
    if (first) {
      const num = first.url.match(/\/(?:pull|issues)\/(\d+)/)?.[1] || String(first.title || '').match(/#(\d+)/)?.[1]
      next = {
        ...next,
        nextAction: `先看「${String(first.title || '').replace(/^(Re:\s*)?\[[^\]]+\]\s*/i, '').slice(0, 40)}」的最新回复`,
        actions: [{ label: num ? `看 #${num} 的最新进展` : '看最新一条', value: first.url, primary: true }, ...(card.actions || []).filter(a => !/^查看 \d+ 个 PR$/.test(a?.label || ''))],
      }
    }
  }
  return next
}
