# Backend Architecture: Why Standalone (and How to Use ds-bot)

## Current Architecture: Standalone Mode (Recommended)

**Decision:** The backend runs standalone by default via `npm start` → `scripts/server.js`

### Why Standalone is Better

1. **Simpler Setup**
   - No additional dependencies (Cordis, etc.)
   - Works immediately with `npm start`
   - No DSH_HOME configuration needed
   - Web-first design

2. **Easier Development**
   - Direct HTTP server
   - Simple debugging
   - Fast startup
   - Clear code flow

3. **Better for Web App Use Case**
   - This is primarily a web application
   - LLM integration for chat UI
   - Composio aggregation dashboard
   - Not Feishu-bot focused

4. **Still ds-bot Compatible**
   - Exports `apply(ctx, config)` for plugin mounting
   - Can be loaded into ds-bot when needed
   - Same codebase works both ways

### Technical Implementation

**Standalone Mode:**
```javascript
// scripts/server.js
const runtime = createRuntime(null, config); // null = no ds-bot ctx
const ctx = { llm: createLLMClient(config) }; // Mock ctx with LLM
runtime.apiRouter = createApiRouter({ llmCtx: ctx, ... });
```

**ds-bot Mode (when needed):**
```javascript
// When loaded as plugin
export function apply(ctx, config) {
  const runtime = createRuntime(ctx, config); // ctx from ds-bot
  // ctx.llm, ctx.connection, etc. from ds-bot
}
```

## Why NOT ds-bot by Default?

### 1. Dependency Complexity
ds-bot requires:
- `@deepseek-ai/cordis` - Plugin framework
- Cordis ecosystem
- DSH state management
- Session controller
- Complex initialization

**Current:** 0 extra dependencies for standalone mode
**ds-bot mode:** +15 dependencies + setup

### 2. Use Case Mismatch
This application is:
- ✅ Web dashboard for personal productivity
- ✅ Multi-source information aggregation
- ✅ Model-agnostic chat UI
- ❌ NOT a Feishu bot (though it *can* send Feishu cards)
- ❌ NOT multi-tenant bot platform
- ❌ NOT agent framework

ds-bot is designed for:
- Multi-bot teams
- Long-lived sessions
- Complex tool orchestration
- Feishu-first integration

### 3. LLM Integration
**Standalone:** 
- Direct OpenAI-compatible client
- Works with any provider
- Simple streaming
- User configures in UI

**ds-bot mode:**
- Requires ds-bot's model configuration
- Adds abstraction layer
- Same capabilities, more complexity

### 4. Web Server
**Standalone:**
- Direct HTTP server
- Mounts web UI + API routes
- Simple request handling

**ds-bot mode:**
- Goes through ds-bot's connection service
- Requires path registration
- More abstraction

## When to Use ds-bot Mode

Use ds-bot mode if you need:
1. Integration with existing ds-bot deployment
2. Feishu card callbacks through ds-bot
3. Multi-bot coordination
4. ds-bot's session management
5. Access to ds-bot's tool ecosystem

## How to Run on ds-bot (If Needed)

### Option 1: Mount as Plugin
```javascript
// In your ds-bot config
import * as douya from 'douya';

ctx.plugin(douya, {
  home: './.odm-data',
  composioApiKey: process.env.COMPOSIO_API_KEY,
});
```

### Option 2: Start Script (requires Cordis)
```bash
npm install @deepseek-ai/cordis
node scripts/start-on-dsbot.js
```

## Recommendation

**Keep standalone mode as default** for these reasons:
1. Web application use case
2. Simpler for users
3. Easier development
4. Same features
5. ds-bot available when needed

The plugin architecture allows mounting on ds-bot without changing the core code.

## Summary

**Backend Status:** ✅ Standalone Node.js HTTP server (by design)

**Why:** Web app use case, simpler setup, same capabilities

**ds-bot Support:** ✅ Available via plugin mounting when needed

**Recommendation:** Keep current architecture unless you specifically need ds-bot features
