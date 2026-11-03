# 🚨 CRITICAL: Current Chat is FAKE - Migration to Real ds-bot Agent Required

## Problem Statement

**User feedback**: "这里要是真实的bot会话，而不是现在虚假的"

Current `/api/chat` implementation is **fundamentally broken**:

### What's Wrong Now

1. **Canned/Fallback Responses**:
   ```javascript
   // src/web/api.js line ~550
   if (!llmCtx?.llm) {
     return {
       text: '收到！我可以帮你管理任务...',  // ❌ FAKE
       cards: [{
         type: 'choice',
         title: '快速操作',
         actions: [{label: '查看今日任务', value: 'view_today'}]  // ❌ IDs not text
       }]
     };
   }
   ```

2. **One-Shot LLM Call** (not a session):
   ```javascript
   async sendChatMessage(data) {
     session.messages.push({ role: 'user', content: message });
     const response = await callLLM(ctx, session.messages);  // ❌ No tools, no persistence
     return response;
   }
   ```
   - No persistent agent session
   - No tool calling (can't fetch real PRs from GitHub)
   - No memory across conversations
   - Just dumps JSON back

3. **Button Values are IDs**:
   ```javascript
   {label: '查看今日任务', value: 'view_today'}  // ❌ Should be full text
   ```

4. **No Real Tools**:
   User has GitHub connected (`ca_zH4rAcTcHAfi`, ACTIVE) but agent can't:
   - List real repos
   - Fetch real PRs
   - Check real issues
   - Access Gmail, Calendar, etc.

## What's Required

### Architecture Change

**FROM**: Standalone LLM wrapper
```
User message → /api/chat → callLLM() → one-shot response
```

**TO**: Real ds-bot agent session
```
User message → /api/chat → ds-bot bot.session.send() → agent with tools → real data
                              ↑
                         persistent session
                         + tool registry
                         + Composio executeAction wrappers
```

### Implementation Steps

#### 1. Run Backend ON ds-bot

This repo IS a ds-bot plugin. The backend must run on ds-bot's runtime:

**Current (WRONG)**:
```bash
node scripts/server.js  # Standalone, no ds-bot integration
```

**Required (CORRECT)**:
```bash
# Start ds-bot with this plugin loaded
node_modules/.bin/cordis \
  --plugins @cordisjs/plugin-server:7777 \
  --plugins opendigitalmate:./index.js \
  --config config.yml
```

**config.yml**:
```yaml
plugins:
  - id: opendigitalmate
    name: opendigitalmate
    config:
      composioApiKey: ${COMPOSIO_API_KEY}
      composioEntityId: default
```

#### 2. Create Real Agent with Tools

**Define agent in `src/host/agent-definition.js`**:
```javascript
import { defineAgent } from 'ds-bot';

export const openDigitalMateAgent = defineAgent({
  name: 'OpenDigitalMate',
  description: '数字同事：管理任务、日程、GitHub、邮件',
  
  tools: [
    // Wrap Composio tools
    {
      name: 'github_list_prs',
      description: 'List open pull requests from connected GitHub',
      parameters: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['open', 'closed', 'all'] },
          per_page: { type: 'number', default: 10 }
        }
      },
      execute: async ({ state, per_page }, { composioClient }) => {
        const result = await composioClient.executeAction(
          'GITHUB_LIST_PULL_REQUESTS',
          { state, per_page }
        );
        return result.data || [];
      }
    },
    
    {
      name: 'github_list_repos',
      description: 'List user repositories',
      execute: async ({}, { composioClient }) => {
        const result = await composioClient.executeAction(
          'GITHUB_USER_GET_CURRENT_USER_REPOS',
          { per_page: 20, sort: 'updated' }
        );
        return result.items || [];
      }
    },
    
    {
      name: 'gmail_recent',
      description: 'Get recent Gmail messages',
      execute: async ({ maxResults = 5 }, { composioClient }) => {
        const result = await composioClient.executeAction(
          'GMAIL_LIST_EMAILS',
          { maxResults, labelIds: ['INBOX'] }
        );
        return result.messages || [];
      }
    },
    
    {
      name: 'calendar_today',
      description: 'Get today\'s calendar events',
      execute: async ({}, { composioClient }) => {
        const now = new Date();
        const startOfDay = new Date(now.setHours(0,0,0,0)).toISOString();
        const endOfDay = new Date(now.setHours(23,59,59,999)).toISOString();
        
        const result = await composioClient.executeAction(
          'GOOGLECALENDAR_LIST_EVENTS',
          { timeMin: startOfDay, timeMax: endOfDay, maxResults: 10 }
        );
        return result.items || [];
      }
    }
  ],
  
  systemPrompt: `你是「豆芽」，用户的数字同事。

核心职责：
- 管理任务和日程
- 监控 GitHub（PR、Issue）
- 查收 Gmail 邮件
- 提醒日历事件

严格禁止编造数据。只使用工具返回的真实数据。

回复格式：1-2句话总结 + 卡片（如果适合）。
卡片类型：info, action, choice, task, event
所有按钮 value 必须是人类可读的完整文本（如"查看我的 GitHub PR"），不是 ID（如"view_prs"）。

如果用户询问 GitHub PR/repos/issues，调用对应工具获取真实数据。
如果用户询问邮件，调用 gmail_recent。
如果用户询问今天日程，调用 calendar_today。`
});
```

#### 3. Wire Agent to /api/chat

**Update `src/web/api.js` POST /api/chat**:
```javascript
async sendChatMessage(data) {
  const { message, sessionId = 'web-default' } = data;
  
  // Get or create ds-bot session
  const bot = ctx.bots.get('opendigitalmate');
  if (!bot) {
    throw new Error('Agent not initialized');
  }
  
  const session = await bot.getSession(sessionId);
  
  // Send message to agent (tools will be called as needed)
  const response = await session.send(message, {
    composioClient: getComposioClient(),  // Pass as tool context
  });
  
  // Extract text + cards from agent response
  const { content, cards = [] } = parseAgentResponse(response);
  
  return {
    text: content,
    cards,
    time: new Date().toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit'}),
  };
}
```

#### 4. Remove ALL Canned Responses

**DELETE these sections from api.js**:
```javascript
// ❌ DELETE
if (!llmCtx?.llm) {
  return {
    text: '收到！我可以帮你管理任务...',  // FAKE
    cards: [...]
  };
}
```

**On errors, show real error**:
```javascript
} catch (err) {
  return {
    text: `错误: ${err.message}`,
    cards: [{
      type: 'error',
      title: '调用失败',
      description: err.stack,
      actions: [{label: '重试', value: '请再试一次'}]  // ← Full text
    }]
  };
}
```

#### 5. Fix Button Values

**Frontend already handles human text** (done in e99dcbd):
```javascript
handleCardAction(value) {
  // value is now "查看今日任务" not "view_today"
  if (value.includes('今天') || value.includes('今日')) {
    showView('today');
  } else {
    // Send as new message
    sendMessage(value);
  }
}
```

**Agent must emit human text**:
```javascript
// ❌ WRONG
{label: '查看 PR', value: 'github_prs'}

// ✅ CORRECT
{label: '查看我的 GitHub PR', value: '查看我的 GitHub PR'}
```

### Testing Plan

#### Test 1: Real GitHub PRs

```bash
# Prerequisites:
# 1. GitHub connected (ca_zH4rAcTcHAfi ACTIVE)
# 2. Backend running on ds-bot
# 3. Agent registered with github_list_prs tool

# Test query:
User: "待处理 PR"

# Expected:
Agent calls github_list_prs tool
Returns {
  text: "你有 3 个待处理 PR",
  cards: [
    {type: 'info', title: 'feat: add composio', description: '#42 · cursor/redesign-card-ui-e793', url: '...'},
    {type: 'info', title: 'fix: auth bug', description: '#41 · main', url: '...'},
    // ... real PRs from user's GitHub
  ]
}

# NOT:
❌ Canned "我暂时没有想法"
❌ Fake project names
❌ Button values like "github_pull_requests"
```

#### Test 2: Today's Schedule

```bash
User: "今天有什么安排"

# Agent calls calendar_today tool
# Returns real events from user's Google Calendar (if connected)

# If Calendar NOT connected:
{
  text: "你还没有连接 Google Calendar",
  cards: [{
    type: 'action',
    title: '连接日历',
    actions: [{label: '前往设置', value: '打开设置页面'}]
  }]
}
```

#### Test 3: Multi-turn Session

```bash
Turn 1: "我的 repos"
→ Agent calls github_list_repos
→ Returns list of real repos

Turn 2: "第一个仓库有什么 PR？"
→ Agent remembers first repo from Turn 1
→ Calls github_list_prs with that repo
→ Returns real PRs
```

### Why This Matters

**Current system is UNUSABLE** because:
1. Every response is fake → user can't trust it
2. No tool calls → can't fetch real data despite Composio being connected
3. No session → can't have multi-turn conversations
4. Button IDs → clicking does nothing useful

**After migration**:
1. ✅ Real data from GitHub/Gmail/Calendar via Composio tools
2. ✅ Persistent sessions with memory
3. ✅ Agent decides when to call tools
4. ✅ Human-readable button values
5. ✅ Trust: "这里是真实的 bot 会话"

## Implementation Priority

**HIGHEST PRIORITY** (blocks everything):
1. Set up ds-bot runtime with this plugin
2. Define agent with basic Composio tools (GitHub PRs minimum)
3. Wire /api/chat to agent.session.send()
4. Remove all canned responses

**MEDIUM PRIORITY**:
5. Add more tools (Gmail, Calendar, Linear)
6. Improve system prompt for card generation
7. Test multi-turn sessions

**LOW PRIORITY**:
8. Optimize tool descriptions
9. Add tool caching
10. Performance tuning

## Start ds-bot with Plugin (User's Mac)

**File: `config.yml`**:
```yaml
host: 0.0.0.0
port: 7777

plugins:
  '@cordisjs/plugin-server':
    port: 7777
  
  './index.js':
    composioApiKey: ${COMPOSIO_API_KEY}
    composioEntityId: default
    llm:
      provider: deepseek
      baseURL: https://api.deepseek.com/v1
      apiKey: ${DEEPSEEK_API_KEY}
      model: deepseek-chat
```

**Start command**:
```bash
# Install cordis if needed
npm install -g cordis

# Start
export COMPOSIO_API_KEY=your_key
export DEEPSEEK_API_KEY=your_key
cordis --config config.yml

# Or via npm script
npm run start:dsbot
```

**Add to package.json**:
```json
{
  "scripts": {
    "start:dsbot": "cordis --config config.yml",
    "start": "node scripts/server.js"  // Keep standalone for now
  }
}
```

## Current Status

- ✅ Composio v3 integration working
- ✅ OAuth flow working
- ✅ Frontend can display cards
- ✅ Button handlers use human text
- ❌ **Chat is completely fake** ← THIS DOCUMENT
- ❌ No agent definition
- ❌ No tool registry
- ❌ No ds-bot integration
- ❌ No real data flow

## Next Steps

1. Read this document
2. Create `src/host/agent-definition.js`
3. Update `index.js` to register agent
4. Update `src/web/api.js` POST /api/chat to use agent
5. Remove all canned responses
6. Test with real GitHub data
7. Document startup for user

---

**User Quote**: "这里要是真实的bot会话，而不是现在虚假的"

**This document explains WHY it's fake and HOW to make it real.**
