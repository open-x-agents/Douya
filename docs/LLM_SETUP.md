# LLM Configuration and Testing Guide

## Overview

Open Digital Mate now supports real LLM integration with a beautiful in-app configuration UI. The backend can run standalone OR mounted on ds-bot.

## Current Architecture

### Standalone Mode (npm start)
- Runs `scripts/server.js` which creates an HTTP server
- Creates a mock context with LLM client
- LLM client implements the same interface as ds-bot's ctx.llm
- Chat calls work with real models or fallback gracefully

### ds-bot Mode (when mounted as plugin)
- Plugin exports `apply(ctx, config)` 
- Receives full ds-bot context with llm, tools, connection etc.
- Uses ds-bot's native LLM provider
- All features work through ds-bot's infrastructure

## Backend Status: **Standalone + ds-bot Compatible**

The backend currently:
1. ✅ Runs standalone with npm start (scripts/server.js)
2. ✅ Implements ds-bot-compatible LLM interface
3. ✅ Can be mounted on ds-bot via apply(ctx, config)
4. ✅ Same codebase works in both modes

## Configuring a Model

### Option 1: Environment Variables
```bash
# Set before starting
export OPENAI_API_KEY="sk-..."
# Or in .env file
```

### Option 2: In-App Configuration
1. Start the server: `npm start`
2. Open http://localhost:7777
3. Click "配置" (Settings) in sidebar
4. See "AI模型" configuration section at top
5. Fill in:
   - Provider (OpenAI/DeepSeek/Custom)
   - API Key
   - Model name (auto-suggested)
   - Base URL (auto-filled for known providers)
6. Click "保存模型配置" (Save)
7. Click "测试连接" (Test Connection) to verify

### Option 3: JSON Configuration
Create `.odm-data/config.json`:
```json
{
  "llm": {
    "provider": "openai",
    "apiKey": "sk-...",
    "model": "gpt-4o",
    "baseURL": "https://api.openai.com/v1"
  }
}
```

## Testing Real Model Calls

1. Configure a model (see above)
2. Open http://localhost:7777
3. Click the blue chat button (bottom right)
4. Type a message: "帮我安排今天的任务"
5. The response will:
   - Call the real configured model
   - Parse the response
   - Render as interactive cards
   - Show action buttons

## API Keys Available in Environment

The server checks for these in order:
1. ConfigStore (.odm-data/config.json)
2. Environment variables:
   - OPENAI_API_KEY
   - DEEPSEEK_API_KEY
   - Any custom key you export

## Supported Providers

### OpenAI
- Base URL: https://api.openai.com/v1
- Models: gpt-4o, gpt-4o-mini, gpt-4-turbo, gpt-3.5-turbo

### DeepSeek
- Base URL: https://api.deepseek.com/v1  
- Models: deepseek-chat, deepseek-coder

### Custom
- Any OpenAI-compatible API
- Supports local models (Ollama, LM Studio, etc.)

## Files Changed

### New Files:
- `src/host/llm-client.js` - LLM client with streaming
- `docs/LLM_SETUP.md` - This guide

### Modified Files:
- `src/client/index.html` - Added model config UI
- `src/host/config-store.js` - LLM config storage
- `src/host/api.js` - LLM config endpoints
- `scripts/server.js` - LLM client initialization
- `index.js` - Runtime LLM context wiring

## Next Steps

To use a real model RIGHT NOW:
```bash
export OPENAI_API_KEY="sk-..."  # or your key
npm start
# Open browser, configure in UI, test connection
```

Or just configure through the beautiful UI after starting!
