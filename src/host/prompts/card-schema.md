# Enhanced Card Schema with Visual Blocks

Cards support rich visual blocks for minimal text, maximum information density.

## Card Structure

```json
{
  "id": "card_123",
  "type": "action|event|info|task",
  "title": "Brief title (max 60 chars)",
  "body": "Optional 1-line context (max 80 chars)",
  "source": "github|gmail|googlecalendar|slack|manual",
  "sourceId": "unique_identifier",
  "url": "https://...",
  "priority": "high|medium|low",
  "status": "active|done|snoozed|pinned",
  "blocks": [
    // Visual blocks array (see below)
  ],
  "createdAt": "2026-10-31T07:00:00Z",
  "updatedAt": "2026-10-31T07:30:00Z"
}
```

## Block Types

### 1. Stat Block (big number + label)
```json
{
  "type": "stat",
  "value": "3",
  "label": "PRs need review",
  "trend": "up|down|neutral",
  "color": "red|yellow|green|blue|gray"
}
```

### 2. Tags/Badges
```json
{
  "type": "tags",
  "items": [
    {"label": "urgent", "color": "red"},
    {"label": "bug", "color": "orange"},
    {"label": "review", "color": "blue"}
  ]
}
```

### 3. Avatar Stack (participants/senders)
```json
{
  "type": "avatars",
  "items": [
    {"name": "Alice", "url": "https://github.com/alice.png"},
    {"name": "Bob", "url": "https://github.com/bob.png"}
  ],
  "overflow": 5
}
```

### 4. Mini Chart (sparkline/bar/donut via inline SVG)
```json
{
  "type": "chart",
  "chartType": "bar|sparkline|donut",
  "data": [3, 5, 2, 8, 4],
  "labels": ["Mon", "Tue", "Wed", "Thu", "Fri"],
  "color": "blue"
}
```

### 5. Progress Bar
```json
{
  "type": "progress",
  "value": 3,
  "max": 5,
  "label": "3 of 5 tasks done"
}
```

### 6. Timeline (for calendar events)
```json
{
  "type": "timeline",
  "items": [
    {"time": "10:00", "title": "Team sync"},
    {"time": "14:00", "title": "1:1 with manager"},
    {"time": "16:00", "title": "Design review"}
  ]
}
```

### 7. Image/Thumbnail
```json
{
  "type": "image",
  "url": "https://opengraph.githubassets.com/...",
  "alt": "Repository preview"
}
```

### 8. Link Preview (extracted metadata)
```json
{
  "type": "link",
  "url": "https://github.com/user/repo/pull/42",
  "title": "Add feature X",
  "description": "Brief preview",
  "favicon": "https://github.com/favicon.ico"
}
```

## Usage Guidelines

1. **Prefer visuals over text**: Use stats, charts, and badges instead of descriptive text
2. **One visual tells the story**: A single stat block "3 PRs" > long text "You have three pull requests..."
3. **Combine blocks wisely**: stat + tags, or timeline + avatars
4. **Max 1 line of body text**: Let blocks carry the information
5. **Only real data**: Never fabricate numbers, names, or metrics

## Examples

**Example 1: GitHub PR Review Card**
```json
{
  "type": "action",
  "title": "Review requested",
  "body": "",
  "source": "github",
  "priority": "high",
  "blocks": [
    {
      "type": "stat",
      "value": "3",
      "label": "PRs waiting",
      "color": "red"
    },
    {
      "type": "avatars",
      "items": [
        {"name": "alice", "url": "https://github.com/alice.png"}
      ]
    },
    {
      "type": "tags",
      "items": [
        {"label": "urgent", "color": "red"},
        {"label": "blocking", "color": "orange"}
      ]
    }
  ]
}
```

**Example 2: Calendar Events Card**
```json
{
  "type": "event",
  "title": "Today's schedule",
  "body": "3 meetings",
  "source": "googlecalendar",
  "blocks": [
    {
      "type": "timeline",
      "items": [
        {"time": "10:00", "title": "Team sync"},
        {"time": "14:00", "title": "1:1"},
        {"time": "16:00", "title": "Design review"}
      ]
    }
  ]
}
```

**Example 3: Email Summary Card**
```json
{
  "type": "info",
  "title": "Unread emails",
  "body": "",
  "source": "gmail",
  "blocks": [
    {
      "type": "stat",
      "value": "12",
      "label": "unread",
      "color": "blue"
    },
    {
      "type": "chart",
      "chartType": "bar",
      "data": [2, 5, 3, 2],
      "labels": ["Manager", "Team", "Clients", "Other"]
    }
  ]
}
```
