# Tile Summary Prompt

Generate a Chinese summary for a project tile that explains what happened and why it matters.

## Research Patterns Applied

Based on Superhuman, Motion, Linear, Sunsama:
- **One-line "why it matters"**: Explain impact, not just facts
- **"Blocked on you" vs "waiting"**: Distinguish what needs YOUR action
- **Suggested next action**: Tell user exactly what to do
- **Calm, helpful tone**: Reduce anxiety, be realistic

## Input Variables

- `{{repoName}}`: Repository name (e.g., "acme/repo-a")
- `{{openPRs}}`: Number of open PRs
- `{{mergedPRs}}`: Number of merged PRs in last 24h
- `{{openIssues}}`: Number of open issues
- `{{reviewCount}}`: Number of PRs needing review from you
- `{{topTitles}}`: Top 3 item titles (semicolon-separated)

## Prompt Template

```
为代码仓库 {{repoName}} 生成一个英文标题和中文摘要。

**活动数据（真实数据，不要编造）**:
- {{openPRs}} 个 PR 待处理
- {{mergedPRs}} 个 PR 已合并（最近 24h）
- {{openIssues}} 个 issue
- {{reviewCount}} 个 PR 需要 review
- 热点项目: {{topTitles}}

**生成两部分**:

1. **headline**（英文，最多 60 字符）: 简洁描述活动重点
   - 风格示例: "v0.2.14 shipped with new features across 17 PRs"
   - 风格示例: "Major refactor in progress, 5 reviews pending"
   - 风格示例: "Bug fixes merged, 3 critical issues remain open"

2. **summary**（中文，1-2 句话，最多 100 字）: 说明发生了什么、为什么重要、下一步做什么
   
   **必须包含**:
   - 具体数字和工作内容（基于真实数据）
   - **为什么重要**: 如果有阻塞发版的、性能相关的、安全问题的，明确说明影响
   - **谁在等**: 如果有 PR 等待 review，说明"X 个 PR 等待你 review"
   - **建议行动**: "先 review #1915，它阻塞了 core 发版"
   
   **示例**:
   - "repo-a 过去 24h 合并了 17 个 PR，主要是 task-read-model 重构工作；还有 3 个 PR 等待 review。"
   - "repo-b 有 2 个 PR 正在进行中，主要是 UI 重构；#42 阻塞了下周的 demo，建议优先 review。"
   - "repo-c 今天没有新 PR，有 2 个 issue 待处理，包括内存泄漏问题（高优先级）。"

JSON: {"headline": "英文标题", "summary": "中文摘要",
  "nextAction": "先审 #N …", "nextAction": "动词+对象的下一步（中文）"}
```

## Expected Output

```json
{
  "headline": "Major refactor shipped, 3 reviews pending",
  "summary": "repo-a 过去 24h 合并了 17 个 PR，主要是 task-read-model 重构工作；还有 3 个 PR 等待你 review，其中 #1915 阻塞了 core 发版。"
}
```
