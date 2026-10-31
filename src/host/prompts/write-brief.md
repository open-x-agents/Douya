# Daily Brief Writing Prompt

Write a concise, actionable daily brief from classified items using RICH VISUAL CARDS.

**Grouped Items:**
{{items}}

**User Context:**
- Name: {{userName}}
- Role: {{userRole}}
- Time: {{currentTime}}

**Output Format:**

Generate a JSON brief with 3-8 cards, prioritized by urgency. Each card should be VISUAL-FIRST with minimal text.

```json
{
  "summary": "One-line TL;DR (max 80 chars, e.g., '3 PRs need review, 2 meetings today, 5 unread emails')",
  "cards": [
    {
      "type": "action|event|info",
      "priority": "high|medium|low",
      "title": "Card title (max 60 chars)",
      "body": "OPTIONAL 1-line context (max 80 chars, prefer empty if blocks are self-explanatory)",
      "source": "github|gmail|googlecalendar|slack",
      "sourceId": "unique ID for deduplication",
      "url": "deep link",
      "status": "active",
      "blocks": [
        // Visual blocks - see schema below
      ]
    }
  ]
}
```

**Visual Block Types (use these instead of long text!):**

1. **stat**: Big number + label
   ```json
   {"type": "stat", "value": "3", "label": "PRs need review", "color": "red|yellow|green|blue|gray"}
   ```

2. **tags**: Badges/labels
   ```json
   {"type": "tags", "items": [{"label": "urgent", "color": "red"}, {"label": "bug", "color": "orange"}]}
   ```

3. **avatars**: Participant/sender stack
   ```json
   {"type": "avatars", "items": [{"name": "Alice", "url": "https://github.com/alice.png"}], "overflow": 2}
   ```

4. **chart**: Mini bar/sparkline/donut
   ```json
   {"type": "chart", "chartType": "bar", "data": [3, 5, 2, 8], "labels": ["Mon", "Tue", "Wed", "Thu"], "color": "blue"}
   ```

5. **progress**: Progress bar
   ```json
   {"type": "progress", "value": 3, "max": 5, "label": "3 of 5 done"}
   ```

6. **timeline**: Calendar events
   ```json
   {"type": "timeline", "items": [{"time": "10:00", "title": "Team sync"}, {"time": "14:00", "title": "1:1"}]}
   ```

**Prioritization:**
1. High: Urgent actions (review-requested, meeting <2h, VIP email)
2. Medium: Today's actions (assigned tasks, scheduled meetings)
3. Low: FYI (watching, CC'd, announcements)

**Grouping Logic:**
- Merge similar items from same source (e.g., "3 PRs need review" with stat block instead of 3 separate cards)
- Group by source when >3 items (e.g., use chart block showing distribution)
- Dedupe across sources (same PR mentioned in GitHub + Slack = 1 card)

**Visual-First Writing Style:**
- **Prefer blocks over body text**: stat block "3" > body text "You have 3 items"
- **Title**: Action-oriented ("Review PRs", "Team meetings", "Unread emails")
- **Body**: Empty or 1-line context ONLY if blocks don't tell the full story
- **Blocks**: 1-3 blocks per card showing key data visually

**Example Cards:**

GitHub PRs:
```json
{
  "type": "action",
  "title": "Review requested",
  "body": "",
  "source": "github",
  "priority": "high",
  "blocks": [
    {"type": "stat", "value": "3", "label": "PRs waiting", "color": "red"},
    {"type": "tags", "items": [{"label": "urgent", "color": "red"}, {"label": "blocking", "color": "orange"}]}
  ]
}
```

Calendar:
```json
{
  "type": "event",
  "title": "Today's meetings",
  "body": "",
  "source": "googlecalendar",
  "blocks": [
    {"type": "timeline", "items": [{"time": "10:00", "title": "Team sync"}, {"time": "14:00", "title": "1:1"}, {"time": "16:00", "title": "Design review"}]}
  ]
}
```

Emails:
```json
{
  "type": "info",
  "title": "Unread emails",
  "body": "",
  "source": "gmail",
  "blocks": [
    {"type": "stat", "value": "12", "label": "unread", "color": "blue"},
    {"type": "chart", "chartType": "bar", "data": [2, 5, 3, 2], "labels": ["Manager", "Team", "Clients", "Other"]}
  ]
}
```

**Quality Bar (from competitors):**
- Superhuman/Shortwave: Prioritize VIP senders, extract action items, sender avatars
- Linear: Show assigned > mentioned > subscribed, status badges
- GitHub: Review-requested > assigned > participating, PR status icons
- Sunsama/Motion: Time-block timeline, prep before meetings, progress bars
- Glean/Dust: Summarize long threads, surface decisions, mini charts for activity

**No Invented Data:**
- Only use provided items
- If no items in a category, omit it
- Never fabricate names, times, numbers, or metrics
- Chart data must come from real counts (e.g., PRs by state from actual item list)
