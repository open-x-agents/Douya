# Daily Brief Writing Prompt

Write a concise, actionable daily brief from classified items using RICH VISUAL CARDS (Muse / Today style).

**Grouped Items:**
{{items}}

**User Context:**
- Name: {{userName}}
- Role: {{userRole}}
- Time: {{currentTime}}

**Priorities (must follow):**
1. What is waiting on the user vs waiting on others.
2. Why it matters today (deadline, blocker, relationship).
3. One concrete next step the user can take in under two minutes.
4. Warm personalized Chinese copy; use {{userName}} and known habits. Never invent counts, names, or URLs.

**Output Format:**

Generate a JSON brief with 3-12 cards, prioritized by urgency. Each card is VISUAL-FIRST with a Chinese explanation.

```json
{
  "summary": "中文 TL;DR（最多 80 字，说明几件等你、几件等别人）",
  "cards": [
    {
      "type": "action|event|info|project-cluster",
      "priority": "high|medium|low",
      "title": "Card title (max 60 chars)",
      "body": "1–2 句中文：数字含义 + 为什么今天重要（必填）",
      "nextAction": "动词+对象，例如「先审 #<真实编号> 的 <真实改动>」",
      "source": "github|gmail|googlecalendar|slack",
      "sourceId": "stable id for merge, e.g. github:cluster:owner/repo:YYYY-MM-DD",
      "url": "real deep link only",
      "status": "active",
      "actions": [{"label": "中文动作", "value": "https://...", "primary": true}],
      "blocks": []
    }
  ]
}
```

**Visual Block Types (prefer charts over paragraphs):**
1. `stat` / `stat-row` — big numbers with Chinese labels (待你审 / 你开的 / 已合并 / 评论未回)
2. `tags` — Chinese pills
3. `chart` — bar / sparkline / donut with legend
4. `link-list` — 1–5 real item links
5. `timeline` / `progress` / `avatars` / `heatmap` when data supports them

**Rules:**
- Every card: Chinese body + nextAction + 1–3 deep links (omit link rather than guess).
- Merge by sourceId; denser visuals beat longer prose.
- If a source failed, say so in summary—do not invent.
