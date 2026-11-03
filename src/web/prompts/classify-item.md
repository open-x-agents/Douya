# Item Classification Prompt

Classify this item's priority and action requirement.

**Item:**
{{item}}

**Context:**
- Source: {{source}}
- Type: {{type}}

**Classify into ONE category:**

1. **needs-action-urgent** (🔴 requires immediate attention):
   - Review-requested PRs where you're the reviewer
   - Assigned issues blocking others
   - Meeting starting in <2h
   - Unread emails from VIPs marked urgent
   - Direct mentions in critical threads

2. **needs-action** (🟡 requires response today):
   - Your open PRs with feedback/CI failures
   - Assigned issues/tasks
   - Today's scheduled meetings (>2h away)
   - Unread emails from team/manager
   - Direct @mentions needing response

3. **fyi** (🔵 informational, no action):
   - PRs/issues you're watching (not assigned)
   - CC'd emails (not To:)
   - Calendar invites (optional attendance)
   - Team announcements
   - Status updates

4. **noise** (⚪ low-value, consider filtering):
   - Bot notifications
   - Marketing emails
   - Old threads (>7 days stale)
   - Duplicate notifications

**Output JSON:**
```json
{
  "category": "needs-action-urgent|needs-action|fyi|noise",
  "score": 0-100,
  "reasoning": "one-line why (max 60 chars)",
  "dedupe_key": "unique identifier for deduplication"
}
```

**Rules:**
- Be conservative: when uncertain, downgrade priority
- Personal assignment/mention >> watching/subscribed
- Time-sensitive (meetings, deadlines) >> async tasks
- dedupe_key should identify the same logical item across sources (e.g., PR URL, issue number, email thread ID)
