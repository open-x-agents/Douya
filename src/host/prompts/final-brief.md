# Final Brief Prompt

Generate the final daily brief from normalized items.

## Research Patterns Applied

Based on Linear Pulse, Superhuman AI Triage, Shortwave, Motion:
- **Urgency/importance triage**: What needs you NOW vs FYI vs can wait
- **"What changed since you last looked"**: Show delta, not everything
- **Commitments extraction**: Pull out promises you made (comments like "I'll send this by EOD")
- **Dedupe aggressively**: Group similar items, don't spam
- **Deep links**: Every action button should go to the exact place (PR /files, specific Gmail thread, GitHub search query)

## Input Variables

- `{{items}}`: Array of normalized items (GitHub PRs, issues, emails, calendar events)
- `{{userProfile}}`: User's interaction history, preferences, top repos/senders, active hours

## Prompt Template

```
从以下归一化数据生成每日简报卡片。

**用户档案（学习的真实偏好）**:
{{userProfile}}

**所有项目（真实数据，不要编造任何东西）**:
{{items}}

---

## 生成卡片 (JSON array)

生成 8-20 张卡片，每张卡片是一个项目聚类、一个邮件汇总或一个日历块。

### 分类优先级（参考 Superhuman / Linear Pulse 分类法）

1. **Blocked on you** (高优先级): 别人在等你
   - PRs with review-requested
   - Issues assigned to you
   - Emails from important people asking questions
   
2. **In progress** (中优先级): 你的主动工作
   - PRs authored by you
   - Issues you commented on recently
   
3. **FYI** (低优先级): 信息性通知
   - Newsletter emails
   - GitHub notification emails
   - Merged PRs you weren't involved in
   
4. **Noise** (不显示): 过滤掉
   - Marketing emails
   - Old notifications

### 去重策略（参考 Shortwave "Smart grouping"）

- **同一仓库**: 聚合成一张 repo 卡片，不要为每个 PR/issue 生成单独卡片
- **同一发件人**: 邮件按发件人聚类
- **同类 newsletter**: 所有 newsletter 合并为一张"Newsletter 汇总"卡片

### 卡片结构

每张卡片 JSON:

```json
{
  "id": "cluster_xxx",
  "type": "project-cluster",
  "source": "github",
  "sourceId": "github:cluster:repo:ThinkFlowLab/FlyBot",
  "title": "ThinkFlowLab/FlyBot",
  "subtitle": "Project Activity",
  "body": "...",
  "priority": "high" | "medium" | "low",
  "status": "active",
  "clusterSize": 15,
  "blocks": [
    {
      "type": "stat-row",
      "stats": [
        {"value": 5, "label": "待处理 PR"},
        {"value": 17, "label": "已合并（24h）"},
        {"value": 3, "label": "待解决 issue"}
      ]
    },
    {
      "type": "tags",
      "tags": [{"text": "3 需要 review", "color": "orange"}]
    },
    {
      "type": "sparkline",
      "data": [3, 5, 2, 8, 12, 10, 7],
      "label": "7 天活跃度"
    },
    {
      "type": "avatars",
      "avatars": [
        {"url": "https://github.com/...", "name": "Day Dreamer"}
      ]
    },
    {
      "type": "link-list",
      "links": [
        {
          "title": "Re-implement task read model (#1915)",
          "url": "https://github.com/ThinkFlowLab/FlyBot/pull/1915",
          "type": "pr-review"
        }
      ]
    }
  ],
  "actions": [
    {
      "label": "去 review #1915",
      "value": "https://github.com/ThinkFlowLab/FlyBot/pull/1915/files",
      "primary": true
    }
  ],
  "metadata": {
    "repo": "ThinkFlowLab/FlyBot",
    "prCount": 5,
    "reviewCount": 3,
    "issueCount": 3
  },
  "items": [],
  "topItems": [],
  "createdAt": "...",
  "updatedAt": "..."
}
```

### Block 类型

- **stat-row**: 统计数字行（待处理 PR、已合并、待解决 issue）
- **tags**: 状态标签（"3 需要 review", "已发版", "阻塞中"）
- **sparkline**: 7 天活跃度折线图（每天的 PR/commit 数）
- **avatars**: 贡献者头像列表
- **link-list**: 前 3 个热点项目（PR 标题 + 类型 + URL）
- **chart**: 图表（donut 饼图、bar 柱状图）
- **timeline**: 日历时间轴
- **image**: 缩略图

### 生成要求

1. **绝对不要编造任何数据**: 所有数字、项目名、人名、URL 必须来自 `{{items}}`
2. **中文标签和摘要**: 所有 label、body、summary 用中文
3. **深度链接**: action.value 必须是具体 URL（PR /files 页、Gmail 线程、GitHub 搜索）
4. **动词按钮**: action.label 用中文动词（"去 review", "回复", "处理", "查看"）
5. **限制文本**: body 最多 100 字，每个 link.title 保持原标题
6. **去重**: 同仓库聚合，同发件人聚合
7. **优先级排序**: blocked-on-you 卡片放前面
8. **为什么重要**: body 说明影响（"阻塞发版"、"Day Dreamer 在等"）

## 输出

```json
{
  "cards": [ ... ]
}
```
