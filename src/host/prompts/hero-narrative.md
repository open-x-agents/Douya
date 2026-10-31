# Hero Narrative Prompt

Generate a warm, personalized daily narrative for the hero greeting card.

## Research Patterns Applied

Based on Sunsama, Motion, Superhuman:
- **Realistic about capacity**: Don't overwhelm, acknowledge what's achievable
- **Warm, encouraging tone**: "让我们一起搞定它们"
- **Specific counts**: Mention actual numbers when notable
- **What matters today**: Focus on urgent/important, not everything

## Input Variables

- `{{userName}}`: User's name (e.g., "Alex")
- `{{urgentCount}}`: Number of urgent items (review-requested PRs, imminent meetings)
- `{{actionCount}}`: Number of actionable items (assigned, today's meetings, emails)
- `{{meetings}}`: Number of calendar events today
- `{{emails}}`: Number of unread emails
- `{{favoriteRepos}}`: List of user's top repos
- `{{frequentContacts}}`: List of frequent email contacts
- `{{recentTopics}}`: Recent chat topics

## Prompt Template

```
为用户生成一条温暖的、个性化的每日叙述（1-2 句话，最多 120 字符）。

**今日数据（真实数据，不要编造）**:
- {{urgentCount}} 个紧急事项（需要 review 的 PR、即将开始的会议）
- {{actionCount}} 个待处理事项（分配的任务、今天的会议、邮件）
- {{meetings}} 个日历事件
- {{emails}} 封未读邮件

**用户信息**:
- 姓名: {{userName}}（永远不要写成 User）
- 常用仓库: {{favoriteRepos}}
- 常联系人: {{frequentContacts}}
- 最近话题: {{recentTopics}}

**要求**:
1. **仅基于上述真实数据** - 不要编造项目名、数字或承诺
2. **温暖、鼓励的语气** - 像朋友而非机器人
3. **现实可达成的** - 如果事情很多，承认现实："今天有点满，我们挑重要的先做"
4. **提及具体数字** - 当数字显著时（如 >3 个紧急事项）
5. **不要空泛套话** - 避免"加油""你可以的"等通用鼓励
6. **最多 120 字符**
7. **用中文**

**语气示例（基于 Sunsama "realistic about workload" 模式）**:
- 适度工作量: "今天有 {{actionCount}} 件事需要你处理，其中 {{urgentCount}} 件比较紧急。让我们一起搞定它们！"
- 繁重工作量: "今天有 {{actionCount}} 件事，有点多。我们先处理 {{urgentCount}} 件紧急的，其他的可以稍后。"
- 轻松工作量: "今天相对轻松，{{actionCount}} 件事都不紧急。可以花时间好好做。"
- 无工作: "今天暂时没有紧急事项，是个适合规划长期工作的好日子。"

**禁止**:
- ❌ "你有 47 个 PR！" (overwhelming)
- ❌ "加油！相信你一定可以！" (empty cheerleading)
- ❌ "今天要完成所有任务" (unrealistic)

**正确**:
- ✓ "有 3 个 PR 需要 review，剩下的可以批量处理" (manageable chunks)
- ✓ "Day Dreamer 在等你回复，其他邮件都不急" (clear priority)

JSON: {"narrative": "你的 1-2 句叙述"}
```

## Expected Output

```json
{
  "narrative": "今天有 5 件事需要你处理，其中 2 件比较紧急。让我们一起搞定它们！"
}
```

OR (when overloaded):

```json
{
  "narrative": "今天有 12 件事，有点多。我们先处理 3 件紧急的，其他的可以明天。"
}
```
