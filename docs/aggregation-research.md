# Aggregation Research: Personal Assistant AI Patterns

Research conducted on leading personal assistant aggregation tools to inform Open Digital Mate's aggregation and triage design.

## Tools Studied

1. **Superhuman** - AI email triage and classification
2. **Motion** - Auto-scheduling with intelligent time-blocking
3. **Linear Pulse & Triage Intelligence** - Project updates and issue triage
4. **Sunsama** - Daily planning ritual with workload estimation

## Key Patterns Discovered

### 1. Urgency/Importance Triage

**Pattern**: Multi-level priority classification that separates "needs action NOW" from "can wait"

- **Superhuman**: Splits inbox into Important (from humans) vs Other (automated). Auto-labels classify Marketing, News, Pitch, Social. Custom labels via AI prompts or deterministic rules.
  - Source: https://help.superhuman.com/hc/en-us/articles/46005657758861-Auto-Labels
  - Source: https://blog.superhuman.com/superhuman-ai-feature-showcase/

- **Motion**: ASAP tasks override all other priority. Then hard deadlines → soft deadlines → high/medium/low priority.
  - Flags tasks that can't fit before deadline
  - Source: https://www.usemotion.com/help/time-management/auto-scheduling

- **Linear**: Triage Intelligence suggests teams, assignees, labels based on historical patterns. Priority inbox separates "needs attention" from "can wait".
  - Source: https://linear.app/docs/triage-intelligence

- **Sunsama**: Daily priority (Urgent → Priority → Normal → Low) resets each day. Backlog priority persists for future work.
  - Source: https://help.sunsama.com/docs/usage-guides/tasks/task-priority/

**Application**: Use multi-tier classification:
- `urgent` (review-requested PRs, imminent meetings, hard deadlines)
- `action` (assigned issues, today's meetings, important emails, soft deadlines)
- `fyi` (my PRs, newsletters, updates for awareness)

### 2. "What Changed Since You Last Looked"

**Pattern**: Surface only new/updated items, not static backlogs

- **Linear Pulse**: Personalized feed shows project/initiative updates since last visit. Daily/weekly AI summaries delivered to inbox.
  - Source: https://linear.app/changelog/2025-04-16-pulse
  - Source: https://linear.app/docs/pulse

- **Superhuman**: Auto-labels run on last 14 days of email when created/edited
  - Source: https://help.superhuman.com/hc/en-us/articles/46005657758861-Auto-Labels

**Application**: 
- Timestamp-based gathering (last 24-48h)
- Highlight "updated since yesterday" vs "new today"
- Show activity delta: "3 new comments on PR #42"

### 3. "Blocked on You" vs "Waiting on Others"

**Pattern**: Distinguish items requiring YOUR action from items you're monitoring

- **Linear**: Triage suggests assignee based on who typically handles this type of issue
  - Source: https://linear.app/docs/triage-intelligence

- **Sunsama**: Daily ritual explicitly asks "what matters today" and "what's in your way"
  - Source: https://help.sunsama.com/docs/usage-guides/daily-planning/

- **Motion**: Ranks tasks by urgency, priority, and deadline; clearly shows ETAs and at-risk deadlines
  - Source: https://www.usemotion.com/help/time-management/auto-scheduling/reference-auto-scheduling/how-auto-scheduling-works-behind-the-scenes

**Application**:
- Classify by actor: `review-requested` (blocked on you) vs `pr-mine` (waiting on reviewers)
- Explicit "next action" field: "你需要 review" vs "等待 CI 完成"
- Surface blockers: "这个 PR 阻塞了 core-host 发版"

### 4. Commitments Extraction

**Pattern**: Identify promises, deadlines, and agreements from content

- **Linear**: Extracts relationships and duplicates using semantic similarity
  - Source: https://linear.app/docs/triage-intelligence

- **Sunsama**: Asks "what anticipated obstacles" during planning
  - Source: https://help.sunsama.com/docs/getting-started/setting-up-your-account/

**Application**:
- Parse PR descriptions for "Fixes #123", "Closes #456"
- Extract mentioned deadlines: "needs to ship by Friday"
- Identify blocking relationships from PR bodies and comments

### 5. One-Line "Why It Matters"

**Pattern**: Concise context that explains impact, not just facts

- **Superhuman**: Auto-label descriptions explain the category (e.g., "Messages applying for job positions")
  - Source: https://blog.superhuman.com/superhuman-ai-feature-showcase/

- **Linear Pulse**: AI summary explains what changed and why across projects
  - Source: https://linear.app/changelog/2025-04-16-pulse

**Application**: Every tile gets a `whyItMatters` field:
- "这个 PR 阻塞了 core-host 发版" (blocking release)
- "Day Dreamer 在等你的回复" (someone waiting)
- "3 个 PR 需要 review，其中 2 个是性能相关" (context about what's in the batch)

### 6. Suggested Next Action

**Pattern**: Tell the user exactly what to do, not just what exists

- **Motion**: Shows ETA for each task completion. Auto-schedules tasks into calendar blocks.
  - Source: https://www.usemotion.com/help/time-management/auto-scheduling/reference-auto-scheduling/how-auto-scheduling-works-behind-the-scenes

- **Sunsama**: Guides through specific steps: add tasks → estimate time → defer overload → order work → set shutdown time
  - Source: https://www.sunsama.com/blog/the-official-daily-planning-guide

- **Linear**: Auto-apply triage suggestions with clear reasoning shown
  - Source: https://linear.app/changelog/2025-09-19-auto-apply-triage-suggestions

**Application**: Every tile includes `suggestedAction`:
- "先 review PR #1915"
- "回复 Day Dreamer 的邮件"
- "处理 3 个待合并 PR"
With deep links to specific actions (not generic "View Repository")

### 7. Time-Boxing into the Day

**Pattern**: Map work to calendar availability and working hours

- **Motion**: Auto-schedules tasks into calendar based on duration, priority, deadline, and availability. Splits long tasks into chunks. Respects working hours and breaks.
  - Source: https://www.usemotion.com/help/time-management/auto-scheduling
  - Source: https://github.com/ever-works/awesome-time-tracking/blob/develop/details/motion-auto-scheduling-technology.md

- **Sunsama**: Time estimates on every task. Workload counter warns if over capacity. Timeline shows estimated completion vs shutdown time. Defer tasks that don't fit.
  - Source: https://www.sunsama.com/blog/the-official-daily-planning-guide

**Application**:
- Generate timetable with fixed calendar blocks + suggested focus blocks
- Estimate duration for each tile's work (e.g., "30 min" for review, "2h" for 3 PRs)
- Suggest optimal order: urgent reviews first, batched non-urgent later
- Warn if total work exceeds user's typical active hours

### 8. Tone: Calm, Helpful, Non-Overwhelming

**Pattern**: Reduce anxiety by being realistic about what's achievable

- **Superhuman**: "Cut through the noise and prioritize what matters most"
  - Source: https://help.superhuman.com/hc/en-us/articles/46005657758861-Auto-Labels

- **Sunsama**: "Defer work until you've got a reasonable workload... liberate yourself from stress of trying to do things that couldn't be done anyway"
  - Source: https://www.sunsama.com/blog/the-official-daily-planning-guide

- **Motion**: Flags tasks that can't fit rather than pretending everything will get done
  - Source: https://www.usemotion.com/help/time-management/auto-scheduling/reference-auto-scheduling/how-auto-scheduling-works-behind-the-scenes

**Application**:
- Chinese tone: warm, encouraging, realistic
- "今天有 5 件事需要你处理，其中 2 件比较紧急。让我们一起搞定它们！"
- Not: "你有 47 个 PR！" (overwhelming)
- But: "有 3 个 PR 需要 review，剩下的可以批量处理" (manageable)

## Implementation Checklist

- [ ] Multi-tier urgency classification (urgent/action/fyi)
- [ ] "What changed" timestamps and deltas
- [ ] "Blocked on you" vs "waiting on others" actor classification
- [ ] Commitment/deadline/blocker extraction from content
- [ ] One-line `whyItMatters` per tile explaining impact
- [ ] Specific `suggestedAction` with verb + deep link per tile
- [ ] Time estimates and timetable generation
- [ ] Workload capacity checking against user's active hours
- [ ] Warm, realistic Chinese tone in all prompts

## Sources

All sources accessed 2026-10-31:

- Superhuman Auto Labels: https://help.superhuman.com/hc/en-us/articles/46005657758861-Auto-Labels
- Superhuman AI Showcase: https://blog.superhuman.com/superhuman-ai-feature-showcase/
- Motion Auto-Scheduling: https://www.usemotion.com/help/time-management/auto-scheduling
- Motion Behind the Scenes: https://www.usemotion.com/help/time-management/auto-scheduling/reference-auto-scheduling/how-auto-scheduling-works-behind-the-scenes
- Motion Technology (GitHub): https://github.com/ever-works/awesome-time-tracking/blob/develop/details/motion-auto-scheduling-technology.md
- Linear Pulse: https://linear.app/docs/pulse
- Linear Pulse Launch: https://linear.app/changelog/2025-04-16-pulse
- Linear Triage Intelligence: https://linear.app/docs/triage-intelligence
- Sunsama Daily Planning Guide: https://www.sunsama.com/blog/the-official-daily-planning-guide
- Sunsama Task Priority: https://help.sunsama.com/docs/usage-guides/tasks/task-priority/
- Sunsama Daily Planning: https://help.sunsama.com/docs/usage-guides/daily-planning/
